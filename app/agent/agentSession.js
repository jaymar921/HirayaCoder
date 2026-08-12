'use strict';

/**
 * The unified agent loop driver.
 *
 * One entry point — `run(task)` — behind which both tiers, all three modes, the
 * permission gate, the change set, and the memory loop are wired together. The two
 * loop strategies are interchangeable implementations of the same contract; nothing
 * outside this file needs to know which one is active.
 *
 * Responsibilities that live here rather than in either loop, because they are the
 * same regardless of how actions are produced:
 *
 *  - Recalling session memory and re-condensing it afterward, at the frequency the
 *    thinking capacity dictates.
 *  - Executing actions through the tool registry, with mode enforced twice: the
 *    registry withholds tools it must not offer, and `execute` refuses any name it
 *    was not offered even if a loop bug lets one through.
 *  - Accumulating one change set per session, so a multi-file task produces a single
 *    grouped review rather than a prompt per file.
 *  - Stop and cancel.
 *
 * @module agent/agentSession
 */

const logger = require('../utils/logger');
const promptRouter = require('../core/promptRouter');
const intentRouter = require('../core/intentRouter');
const toolRegistry = require('./toolRegistry');
const contextBuilder = require('../core/contextBuilder');
const reactLoop = require('./reactLoop');
const nativeToolLoop = require('./nativeToolLoop');
const plannerAgent = require('./plannerAgent');
const earnedHints = require('./earnedHints');
const { TodoList } = require('./todoList');

/**
 * @typedef {object} AgentStep
 * @property {import('../core/outputParser').ParsedAction} action
 * @property {import('./toolRegistry').ToolResult} result
 */

/**
 * @typedef {object} FileChange
 * @property {'create' | 'edit' | 'delete'} kind
 * @property {string} path
 * @property {string | null} before
 * @property {string | null} after
 * @property {number} added
 * @property {number} removed
 */

/**
 * Everything a session touched, for one grouped review.
 *
 * Keyed by path so a file edited three times in one session appears once, with its
 * original `before` — the user reviews the net effect, not the agent's intermediate
 * drafts.
 */
class ChangeSet {
  constructor() {
    /** @type {Map<string, FileChange>} */
    this.files = new Map();
    /** @type {Array<{command: string, exitCode: number | null, ok: boolean}>} */
    this.commands = [];
  }

  /**
   * @param {FileChange} change
   */
  record(change) {
    const existing = this.files.get(change.path);
    if (existing) {
      // Preserve the state from before the session began.
      this.files.set(change.path, {
        ...change,
        before: existing.before,
        kind: existing.kind === 'create' && change.kind === 'edit' ? 'create' : change.kind,
      });
      return;
    }
    this.files.set(change.path, change);
  }

  /**
   * @param {{command: string, exitCode: number | null, ok: boolean}} entry
   */
  recordCommand(entry) {
    this.commands.push(entry);
  }

  /** @returns {FileChange[]} */
  list() {
    return [...this.files.values()];
  }

  /** @returns {boolean} */
  isEmpty() {
    return this.files.size === 0 && this.commands.length === 0;
  }

  /**
   * How many distinct changes are recorded.
   *
   * Used to tell whether one TODO item changed anything, which `isEmpty()` cannot
   * answer once an earlier item has already changed something.
   *
   * @returns {number}
   */
  size() {
    return this.files.size + this.commands.length;
  }

  /** @returns {string} */
  describe() {
    if (this.isEmpty()) return 'No files were changed.';
    const parts = [];
    for (const change of this.list()) {
      if (change.kind === 'delete') parts.push(`deleted ${change.path}`);
      else if (change.kind === 'create') parts.push(`created ${change.path}`);
      else parts.push(`edited ${change.path} (+${change.added}/-${change.removed})`);
    }
    if (this.commands.length > 0) {
      parts.push(`ran ${this.commands.length} command(s)`);
    }
    return parts.join(', ');
  }
}

/**
 * @typedef {object} SessionResult
 * @property {string} summary
 * @property {AgentStep[]} steps
 * @property {ChangeSet} changeSet
 * @property {string} stopReason
 * @property {'agent' | 'plan' | 'ask'} mode
 * @property {string[]} [plan]  Plan-mode steps, ready for the checklist UI.
 * @property {import('./todoList').TodoItem[]} [todos]  Items and their outcomes, when a list was used.
 */

/** No item can succeed in fewer than a read, a write, and a finish. */
const MIN_STEPS_PER_TODO_ITEM = 3;

/**
 * How many items may each draw the full step budget before the session is capped.
 *
 * The ceiling exists for wall-clock, not correctness: on CPU inference a step is
 * tens of seconds, so an unbounded list could run for an hour. Four items at full
 * budget is already a long session and well past the point where a user would rather
 * see partial results than keep waiting.
 */
const MAX_TODO_ITEMS_WITH_FULL_BUDGET = 4;

/** Openers that begin a request for information rather than for work. */
const QUESTION_OPENERS =
  /^\s*(?:how|what|what's|whats|why|when|where|which|who|is|are|was|were|do|does|did|can|could|should|would|will|explain|describe|tell\s+me|show\s+me)\b/i;

/**
 * Does this read as a question rather than an instruction?
 *
 * Deliberately shallow. It only has to be right often enough to keep questions out of
 * the TODO path, and being wrong in either direction is cheap: a missed question runs
 * as a plan, and a misread instruction runs as a single pass — which is what every
 * model did before the TODO path existed.
 *
 * An imperative anywhere in the text wins, so "how do I add a dark mode toggle — please
 * implement it" is treated as work. The question mark is not sufficient on its own for
 * the same reason: "can you add a test?" is a request, not an enquiry.
 *
 * @param {string} task
 * @returns {boolean}
 */
function looksLikeAQuestion(task) {
  const text = String(task || '').trim();
  if (!text) return false;

  // Any instruction to change something makes this work, whatever it opens with.
  if (/\b(?:add|create|write|implement|update|edit|change|fix|refactor|delete|remove|rename|move|install|generate|build|make)\b/i.test(text)) {
    return false;
  }

  return QUESTION_OPENERS.test(text) || text.endsWith('?');
}

/**
 * The checklist as the UI should draw it right now.
 *
 * A copy, not the live items: the event travels to a webview through
 * `postMessage`, and handing out the array the session is still mutating would let
 * a later item's status appear on an earlier render.
 *
 * @param {TodoList} todos
 * @returns {{text: string, status: string, outcome?: string}[]}
 */
function snapshotTodos(todos) {
  return todos.items.map((item) => ({ text: item.text, status: item.status, outcome: item.outcome }));
}

/**
 * Decide whether a TODO item actually got done.
 *
 * From evidence, not from the model's account of itself. Three things are known for
 * certain after a run: whether the loop reached `done`, whether any step succeeded,
 * and whether the change set grew. A model's summary is not among them.
 *
 * An item that ends `done` having changed nothing is reported as done — a request to
 * check or confirm something legitimately changes no files, and calling that a
 * failure would be wrong more often than it would be right.
 *
 * ## The third state
 *
 * Reproduced on `qwen3.5:2b` in three consecutive runs: the model writes the file
 * correctly, re-reads it "to verify", spends the rest of the item's steps doing that,
 * and never emits `done`. Flat `failed` is defensible — the item was not closed — but
 * it reads as "nothing happened" for an item that, in substance, happened.
 *
 * `done-with-warning` is the honest answer, and it is still evidence-based: the change
 * set grew and no step failed. What is missing is only the model's sign-off, which was
 * never worth anything anyway. The one thing this must not become is trusting the
 * model's own claim of completion — that is the failure the whole judgement exists to
 * avoid, so a run that changed nothing can never reach this state.
 *
 * @param {{stopReason: string, steps: AgentStep[], summary: string}} outcome
 * @param {ChangeSet} changeSet
 * @param {number | null} sizeBefore
 * @returns {{status: 'done' | 'done-with-warning' | 'failed', outcomeText: string}}
 */
function judgeItem(outcome, changeSet, sizeBefore) {
  const changed = changeSet.size() > (sizeBefore === null ? 0 : sizeBefore);
  const anySucceeded = outcome.steps.some((step) => step.result && step.result.ok);
  const anyFailed = outcome.steps.some((step) => step.result && step.result.ok === false);

  if (outcome.stopReason === 'done') {
    // Reaching `done` is the model's claim, and it is worth exactly as much as the
    // evidence behind it. Observed on `gemma4:e2b`: the user declined the delete, the
    // file stayed, and the model closed the item with `done` — the checklist then read
    // "Delete the obsolete file — done" for a file that is still there.
    //
    // The narrow case that catches it: nothing changed *and* something failed. An
    // item that changed nothing without failing anything is a legitimate check, and an
    // item that landed its change after recovering from a failed step is an ordinary
    // success — flagging either would make the caveat meaningless.
    if (!changed && anyFailed) {
      return { status: 'failed', outcomeText: 'the model reported it finished, but its actions failed' };
    }
    return { status: 'done', outcomeText: changed ? '' : 'no files changed' };
  }
  if (changed && anySucceeded && !anyFailed) {
    return {
      status: 'done-with-warning',
      outcomeText: `changes landed, but the model never closed the item off (${outcome.stopReason})`,
    };
  }
  if (changed && anySucceeded) {
    // Work landed *and* something failed along the way. Reporting this as done would
    // overclaim; reporting it as untouched would hide a real edit.
    return { status: 'failed', outcomeText: `stopped early (${outcome.stopReason}) after making changes` };
  }
  return { status: 'failed', outcomeText: `stopped: ${outcome.stopReason}` };
}

/**
 * Append the steps that did not succeed to a model-written summary.
 *
 * The summary is the one part of a session written entirely by the model, and models
 * describe what they *intended*. Observed on `gemma4:e2b`: the user declined the
 * delete confirmation, the file was untouched, and the summary still reported
 * "`src/obsolete.js` was deleted." A user who reads that believes a destructive
 * action happened when it did not.
 *
 * Rather than trying to detect the false claim inside prose — which would mean
 * trusting a language judgement about a safety-relevant fact — the outcome the
 * extension knows for certain is stated plainly underneath. The model may describe
 * the session however it likes; the record of what actually failed is not its to
 * write.
 *
 * @param {string} summary
 * @param {AgentStep[]} steps
 * @returns {string}
 */
function appendUnfinishedNote(summary, steps) {
  const failed = (steps || []).filter((step) => step.result && step.result.ok === false);
  if (failed.length === 0) return summary;

  // One line per distinct target, most recent attempt winning, so a model that
  // retried a write three times does not produce three identical warnings.
  /** @type {Map<string, string>} */
  const lines = new Map();
  for (const step of failed) {
    const target = step.action.path || step.action.command || step.action.query || step.action.action;
    lines.set(target, `- ${step.result.observation}`);
  }

  return `${summary}\n\nThese steps did not complete:\n${[...lines.values()].join('\n')}`;
}

class AgentSession {
  /**
   * @param {object} options
   * @param {import('../core/ollamaClient').OllamaClient} options.client
   * @param {string} options.model
   * @param {import('../core/modelCapability').Capability} options.capability
   * @param {import('../security/permissionGate').PermissionGate} options.gate
   * @param {string} options.workspaceRoot
   * @param {import('../core/memoryStore').MemoryStore} [options.memory]
   * @param {import('../core/contextTranslator').ContextTranslator} [options.translator]
   * @param {import('../core/contextFilesManager').ContextFilesManager} [options.contextFiles]
   * @param {import('../core/modelCapability').ThinkingCapacity} [options.thinkingCapacity]
   * @param {string} [options.sessionId]
   * @param {import('../core/outcomeLedger').OutcomeLedger} [options.ledger]
   * @param {{enabled?: boolean, hintThreshold?: number}} [options.adaptation]
   */
  constructor(options) {
    this.client = options.client;
    this.model = options.model;
    this.capability = options.capability;
    this.gate = options.gate;
    this.workspaceRoot = options.workspaceRoot;
    this.memory = options.memory || null;
    /**
     * What is true of this workspace and machine, across every session.
     *
     * Separate from `memory` on purpose: that is a per-session log of what happened,
     * this is what was established. Null when there is no workspace to keep it in.
     *
     * @type {import('../core/factStore').FactStore | null}
     */
    this.facts = options.facts || null;
    this.translator = options.translator || null;
    this.contextFiles = options.contextFiles || null;
    this.thinkingCapacity = options.thinkingCapacity || 'medium';
    this.sessionId = options.sessionId || '1';
    /**
     * Base64 images for this turn, on models that can see them.
     *
     * Sent with the **first** message only. A 4 MB screenshot is ~5.5 MB of base64,
     * and re-sending it on every turn of an eight-step loop would spend more time
     * uploading the same picture than thinking about it. The model has seen it; the
     * trace and observations carry the conversation from there.
     */
    this.images = Array.isArray(options.images) ? options.images : [];
    this.scriptTimeoutMs = options.scriptTimeoutMs;
    /**
     * Where this session's evidence goes, and where the previous ones' came from.
     *
     * Null is a supported state, not a degraded one: without a workspace there is
     * nowhere to keep a ledger, and every call site here treats an absent ledger as
     * "learn nothing this session" rather than as an error.
     */
    this.ledger = options.ledger || null;
    this.adaptation = options.adaptation || {};

    /**
     * Earlier turns of this chat, set per `run` call.
     *
     * Held on the session rather than threaded through every private method: the
     * context is rebuilt once per TODO item and once per loop turn, and each of those
     * call sites would otherwise have to remember to pass it on.
     *
     * @type {Array<{role: string, text: string}>}
     */
    this.conversation = [];

    /** @type {AbortController | null} */
    this._controller = null;
    this.running = false;
  }

  /** Stop the session after the action in flight completes. */
  cancel() {
    if (this._controller) this._controller.abort();
  }

  /**
   * Run one message.
   *
   * @param {string} task
   * @param {object} [options]
   * @param {'agent' | 'plan' | 'ask'} [options.mode]
   * @param {{path?: string, content?: string, selection?: string, language?: string}} [options.editor]
   * @param {Array<{role: string, text: string}>} [options.conversation]
   *   Earlier turns, oldest first, not including this one.
   * @param {(event: object) => void} [options.onEvent]
   * @returns {Promise<SessionResult>}
   */
  async run(task, options = {}) {
    const mode = options.mode || 'agent';
    const emit = options.onEvent || (() => {});
    this.conversation = Array.isArray(options.conversation) ? options.conversation : [];
    this._controller = new AbortController();
    this.running = true;

    try {
      // Only Agent mode is routed by intent — Plan and Ask are the user saying what they
      // want, and second-guessing an explicit choice is not this classifier's job.
      const intent = mode === 'agent' ? intentRouter.classify(task) : { intent: 'task', reason: 'mode was chosen' };
      if (intent.intent === 'chat') {
        logger.info(`Answering conversationally rather than running the agent (${intent.reason}).`);
      }

      const activeRoute = promptRouter.route({
        mode,
        capability: this.capability,
        thinkingCapacity: this.thinkingCapacity,
        memory: await this._renderMemory(),
        earnedHints: await this._earnedHints(mode),
        intent: intent.intent,
      });

      emit({
        type: 'start',
        mode,
        strategy: activeRoute.strategy,
        maxSteps: activeRoute.budgets.maxSteps,
        // The UI needs to know a turn will not be doing any work, so it can stop
        // promising a step counter it is never going to fill in.
        conversational: activeRoute.strategy === 'chat',
      });

      // Ask mode, and Agent mode answering conversation: one response, no loop, no
      // tools in existence.
      if (activeRoute.strategy === 'none' || activeRoute.strategy === 'chat') {
        const askContext = await this._buildContext(task, activeRoute, options.editor);
        const summary = await this._answerDirectly(task, activeRoute, askContext);
        emit({ type: 'done', summary });
        /** @type {SessionResult} */
        const answered = {
          summary,
          steps: [],
          changeSet: new ChangeSet(),
          stopReason: activeRoute.strategy === 'chat' ? 'conversation' : 'answered',
          mode,
        };
        await this._recordSession(answered);
        return answered;
      }

      const changeSet = new ChangeSet();

      // A model that can hold a TODO list gets the request split into items and works
      // through them one at a time. Everything else keeps the previous behaviour.
      if (mode === 'agent' && this.capability.canPlanTodos) {
        const todoResult = await this._runWithTodos(task, activeRoute, changeSet, options, emit);
        if (todoResult) {
          await this._recordSession(todoResult);
          return todoResult;
        }
      }

      const plan =
        activeRoute.budgets.planning !== 'none' && mode === 'agent'
          ? await plannerAgent.plan({
              client: this.client,
              model: this.model,
              task,
              context: await this._buildContext(task, activeRoute, options.editor),
              signal: this._controller.signal,
            })
          : null;

      if (plan && plan.length > 0) emit({ type: 'plan', steps: plan });

      // The task goes through contextBuilder rather than being prepended by the
      // loop. Doing both put the task in the prompt twice, which on a 1800-token
      // Tier B budget is a measurable waste and reads to the model as emphasis it
      // was never meant to carry.
      const effectiveTask = plan && plan.length > 0 ? `${task}\n\nYour plan:\n${plan.join('\n')}` : task;
      const context = await this._buildContext(effectiveTask, activeRoute, options.editor);

      const loop = activeRoute.strategy === 'native' ? nativeToolLoop : reactLoop;
      const outcome = await loop.run({
        client: this.client,
        model: this.model,
        route: activeRoute,
        task: effectiveTask,
        context,
        execute: (action) => this._execute(action, activeRoute, changeSet),
        onEvent: emit,
        signal: this._controller.signal,
        images: this.images,
      });

      await this._remember(outcome.steps);

      /** @type {SessionResult} */
      const result = {
        summary: appendUnfinishedNote(outcome.summary, outcome.steps),
        steps: outcome.steps,
        changeSet,
        stopReason: outcome.stopReason,
        mode,
      };

      // A Plan-mode run produces a checklist, not changes.
      if (mode === 'plan') result.plan = await this._derivePlan(task, outcome);

      await this._recordSession(result);
      return result;
    } finally {
      this.running = false;
      this._controller = null;
    }
  }

  /**
   * Work through a request as a TODO list, one item at a time.
   *
   * Each item gets its own loop run — its own context, its own trace, its own step
   * budget — so the model is only ever asked to do one thing, even when the user
   * asked for three. Between items it sees the list with the finished ones ticked
   * off, which is the only cross-item state it needs.
   *
   * Returns `null` when a list was not worth building, so the caller falls back to
   * the ordinary single-run path.
   *
   * @param {string} task
   * @param {import('../core/promptRouter').Route} activeRoute
   * @param {ChangeSet} changeSet
   * @param {object} options
   * @param {(event: object) => void} emit
   * @returns {Promise<SessionResult | null>}
   * @private
   */
  async _runWithTodos(task, activeRoute, changeSet, options, emit) {
    // A question is not a work plan. Asked "how to run it" about a file it had just
    // written, `ornith:9b` produced "Read myjava.java to understand its contents and
    // dependencies" and "Determine how to compile and run myjava.java" — two loops, two
    // reads, no change to anything, and the actual answer buried under a completion
    // report for items the user never asked for.
    //
    // Skipping the split costs a misread request one single-pass run, which is exactly
    // what every model did before this path existed and is entirely capable of
    // answering. Splitting a question costs an extra inference and produces a worse
    // answer. The asymmetry decides it.
    if (looksLikeAQuestion(task)) {
      logger.debug('Request reads as a question; answering it directly rather than planning items.');
      return null;
    }

    const planContext = await this._buildContext(task, activeRoute, options.editor);
    const items = await plannerAgent.planTodos({
      client: this.client,
      model: this.model,
      task,
      context: planContext,
      signal: this._controller.signal,
    });

    // One item is not a list — it is the task. Running it through this path would add
    // a wrapper and an inference call to buy nothing.
    if (!TodoList.isWorthKeeping(items)) {
      logger.debug('TODO planning produced fewer than two items; running the task directly.');
      return null;
    }

    const todos = new TodoList(items);
    emit({ type: 'todo', items: todos.items.map((item) => item.text) });
    logger.info(`Running ${todos.items.length} TODO item(s) one at a time.`);

    /** @type {AgentStep[]} */
    const allSteps = [];
    /** @type {string[]} */
    const summaries = [];

    // Each item gets the tier's *full* step budget, not a share of one.
    //
    // Dividing the session budget across items was the first design and it was
    // wrong: with three items and a Tier B budget of 8, every item got 3 steps —
    // fewer than the same model would have had for the whole task in one pass.
    // Measured on `qwen3.5:2b`, item 2 spent its three on read/write/read and ran
    // out before it could report `done`, so finished work was recorded as a failure.
    //
    // Nothing carries between items except the checklist: the context, trace, and
    // observations are rebuilt per item, so there is no reason for one item's cost
    // to come out of another's allowance. The ceiling below is what bounds the
    // session instead.
    const perItemSteps = activeRoute.budgets.maxSteps;
    let remainingSteps = perItemSteps * Math.min(todos.items.length, MAX_TODO_ITEMS_WITH_FULL_BUDGET);
    const loop = activeRoute.strategy === 'native' ? nativeToolLoop : reactLoop;

    while (todos.current() && remainingSteps > 0) {
      if (this._controller.signal.aborted) {
        todos.skipRemaining('the session was cancelled');
        break;
      }

      const item = todos.current();
      const position = todos.position();
      // The snapshot rides along with the event because the UI has no other way to
      // learn the list changed: it holds the items it was given at `todo` time and
      // nothing else, so an index alone would leave it guessing at the other rows.
      emit({
        type: 'todo-item',
        index: position,
        total: todos.items.length,
        text: item.text,
        items: snapshotTodos(todos),
      });

      // Never below a read-think-modify, or the item cannot succeed even in
      // principle and the run would only look like it tried.
      const itemBudget = Math.max(MIN_STEPS_PER_TODO_ITEM, Math.min(perItemSteps, remainingSteps));

      const itemTask =
        `${task}\n\n${todos.render()}\n\n` +
        `Right now, do only item ${position}: ${item.text}\n` +
        'Ignore the other items — they are handled separately. When this one item is complete, reply with "done".';

      const itemRoute = { ...activeRoute, budgets: { ...activeRoute.budgets, maxSteps: itemBudget } };
      const context = await this._buildContext(itemTask, itemRoute, options.editor);

      const before = changeSet.size();

      // Each item runs a fresh loop, and a loop numbers its steps from its own
      // `steps.length + 1` — so item 2's first action announces itself as step 1 again.
      // The trace then shows two rows both labelled "1", above a header reading
      // "Steps (1)", because the view tracks the highest number it has seen. Observed
      // on `ornith:9b` answering a two-item request.
      //
      // The loops are right to number from their own steps: they cannot know they are
      // one item of several. Only this driver knows, so it is the one that offsets.
      const stepOffset = allSteps.length;
      const emitForItem = (event) => {
        if ((event.type === 'action' || event.type === 'observation') && typeof event.step === 'number') {
          emit({ ...event, step: stepOffset + event.step });
          return;
        }
        emit(event);
      };

      const outcome = await loop.run({
        client: this.client,
        model: this.model,
        route: itemRoute,
        task: itemTask,
        context,
        execute: (action) => this._execute(action, itemRoute, changeSet),
        onEvent: emitForItem,
        signal: this._controller.signal,
        // Only the first item sees the image. By item two the work is grounded in
        // files that have been read, and re-uploading the picture each time would
        // cost more than it informs.
        images: position === 1 ? this.images : [],
      });

      allSteps.push(...outcome.steps);
      remainingSteps -= Math.max(1, outcome.steps.length);
      if (outcome.summary) summaries.push(`${position}. ${outcome.summary}`);

      // Completion is judged from what the run produced, never from the model saying
      // so — the same models that report a declined delete as successful would tick
      // off an item they never touched.
      const { status, outcomeText } = judgeItem(outcome, changeSet, before);
      todos.finishCurrent(status, outcomeText, outcome.steps.length);
      emit({ type: 'todo-item-done', index: position, status, text: item.text, items: snapshotTodos(todos) });

      await this._remember(outcome.steps);

      if (outcome.stopReason === 'cancelled') {
        todos.skipRemaining('the session was cancelled');
        break;
      }
    }

    if (todos.current()) todos.skipRemaining('the session ran out of steps');

    const progress = todos.progress();
    const caveat =
      progress.warned > 0
        ? ` ${progress.warned} of those changed files without the model confirming it had finished — check them.`
        : '';
    const summary =
      `${progress.done} of ${progress.total} item(s) completed.${caveat}\n\n${todos.describe()}` +
      (summaries.length > 0 ? `\n\nDetail:\n${summaries.join('\n')}` : '');

    return {
      summary: appendUnfinishedNote(summary, allSteps),
      steps: allSteps,
      changeSet,
      stopReason: progress.done === progress.total ? 'done' : 'partial',
      mode: 'agent',
      todos: todos.items,
    };
  }

  /**
   * The checklist a Plan-mode run hands back.
   *
   * Plan mode's whole output is the checklist, and until now the only way to get one
   * was for the model's closing `done` summary to happen to be a numbered list. That
   * is two bets on one turn: that the loop reached `done` at all, and that the summary
   * came out in list shape. Small models lose both routinely — a Plan run that hits
   * the repeat guard ends with "I stopped because I kept repeating the same step",
   * which parses to zero steps — and the failure is silent, because the webview simply
   * renders the prose and never draws the "Run this plan" button. The feature reads as
   * broken rather than as degraded.
   *
   * So the summary is still preferred, and when it yields nothing the plan is asked
   * for directly instead: one cheap constrained call, given what the exploration
   * actually turned up. That call has one job and a fixed output shape, which is a far
   * easier thing for a 1B model to get right than closing a loop in list form.
   *
   * Returns `[]` when even that produces nothing, so the caller falls back to prose
   * rather than inventing steps.
   *
   * @param {string} task
   * @param {{summary: string, steps: AgentStep[]}} outcome
   * @returns {Promise<string[]>}
   * @private
   */
  async _derivePlan(task, outcome) {
    const fromSummary = plannerAgent.parsePlanSummary(outcome.summary);
    if (fromSummary.length > 0) return fromSummary;

    logger.debug('Plan-mode summary held no numbered steps; asking for the plan directly.');

    try {
      return await plannerAgent.plan({
        client: this.client,
        model: this.model,
        task,
        context: this._explorationNotes(outcome.steps),
        signal: this._controller ? this._controller.signal : undefined,
      });
    } catch (err) {
      // A missing checklist degrades Plan mode to prose. It must never fail the turn.
      logger.warn(`Could not derive a plan: ${/** @type {Error} */ (err).message}`);
      return [];
    }
  }

  /**
   * What a read-only run learned, compressed for one follow-up prompt.
   *
   * Paths and outcomes only. The observations themselves are file contents, which
   * would blow the budget of the very models this exists for — and the second pass
   * needs to know *which files matter*, not what is in them.
   *
   * @param {AgentStep[]} steps
   * @returns {string}
   * @private
   */
  _explorationNotes(steps) {
    const lines = (steps || [])
      .filter((step) => step.action && step.action.path)
      .map((step) => `- ${step.action.path}${step.result && step.result.ok ? '' : ' (could not be read)'}`);

    const unique = [...new Set(lines)].slice(0, 15);
    return unique.length > 0 ? `Files you looked at while exploring:\n${unique.join('\n')}` : '';
  }

  /**
   * Is this session allowed to learn?
   *
   * The setting turns off *both* halves — no hints are read and no outcomes are
   * written. Recording while claiming to be off would be the wrong reading of a
   * switch labelled "let HirayaCoder learn from what happens in this workspace": a
   * user who declines that should not find a new file in their project.
   *
   * @returns {boolean}
   * @private
   */
  _adapting() {
    return Boolean(this.ledger) && this.adaptation.enabled !== false;
  }

  /**
   * The corrective hints this model has earned in this workspace.
   *
   * Read once per message, before routing, because the preamble has to be settled
   * before the first turn is built. A session does not adapt to itself mid-run: the
   * evidence it produces counts towards the *next* message, which keeps the prompt
   * stable across the turns of one task.
   *
   * @param {'agent' | 'plan' | 'ask'} mode
   * @returns {Promise<string[]>}
   * @private
   */
  async _earnedHints(mode) {
    if (!this._adapting() || mode === 'ask') return [];

    try {
      const profile = await this.ledger.profileFor(this.model);
      const hints = earnedHints.select(profile, { threshold: this.adaptation.hintThreshold });
      if (hints.length > 0) {
        logger.info(
          `${this.model} has earned ${hints.length} corrective hint(s): ` +
            hints.map((hint) => `${hint.key}×${hint.count}`).join(', ')
        );
      }
      return hints.map((hint) => hint.text);
    } catch (err) {
      // Adaptation is an optimization. A session must never fail to start because the
      // file it learns from could not be read.
      logger.warn(`Could not select earned hints: ${/** @type {Error} */ (err).message}`);
      return [];
    }
  }

  /**
   * Record one executed action as evidence.
   *
   * Everything here is what the tools and guards reported — never what the model said
   * about itself, and never anything naming a file. See `core/outcomeLedger`.
   *
   * @param {import('../core/outputParser').ParsedAction} action
   * @param {import('./toolRegistry').ToolResult} result
   * @param {import('../core/promptRouter').Route} activeRoute
   * @param {boolean} mutating Whether the tool could change the workspace.
   * @private
   */
  _recordStep(action, result, activeRoute, mutating) {
    if (!this._adapting()) return;

    // A permission prompt only decided this step if the tool was one that asks. A
    // successful read is not the user "approving" anything.
    let decision;
    if (result.error === 'USER_DENIED') decision = 'declined';
    else if (mutating && result.ok) decision = 'approved';

    void this.ledger.recordStep({
      model: this.model,
      tier: this.capability ? this.capability.tier : 'B',
      thinking: this.thinkingCapacity,
      mode: activeRoute.mode,
      sessionId: this.sessionId,
      action: action.action,
      ok: Boolean(result.ok),
      code: result.ok ? undefined : result.error,
      decision,
    });
  }

  /**
   * Record how a whole message ended.
   *
   * `changed` comes from the change set rather than from the summary, for the reason
   * `judgeItem` exists: a model that reports a declined delete as done would also
   * report a session that changed nothing as a success.
   *
   * @param {SessionResult} result
   * @returns {Promise<void>}
   * @private
   */
  async _recordSession(result) {
    if (!this._adapting()) return;

    await this.ledger.recordSession({
      model: this.model,
      tier: this.capability ? this.capability.tier : 'B',
      thinking: this.thinkingCapacity,
      mode: result.mode,
      sessionId: this.sessionId,
      stopReason: result.stopReason,
      steps: result.steps.length,
      changed: !result.changeSet.isEmpty(),
    });
  }

  /**
   * The memory block for the system prompt: established facts, then session notes.
   *
   * Facts come first and are never trimmed for notes, because they are the statements a
   * turn most needs and the ones least likely to be re-derivable. "Java is not available
   * on this machine" changes what the whole session should attempt; "Edited
   * src/todo_manager.py" is recoverable by reading the file.
   *
   * Both go under the one heading the prompt templates carry. Facts are self-labelling
   * — `[This machine]`, `[Decided]` — so the distinction survives without a second
   * placeholder in every template.
   *
   * @returns {Promise<string>}
   * @private
   */
  async _renderMemory() {
    const blocks = [];

    if (this.facts) {
      try {
        const known = await this.facts.renderForPrompt();
        if (known) blocks.push(known);
      } catch (err) {
        logger.warn(`Could not read established facts: ${/** @type {Error} */ (err).message}`);
      }
    }

    if (this.memory) blocks.push(await this.memory.renderForPrompt(this._recallDepth()));

    return blocks.filter(Boolean).join('\n');
  }

  /**
   * How many memory entries to recall, per thinking capacity.
   *
   * @returns {number}
   * @private
   */
  _recallDepth() {
    const budgets = require('../core/modelCapability').budgetsFor(
      this.capability ? this.capability.tier : 'B',
      this.thinkingCapacity
    );
    return budgets.memoryRecallEntries;
  }

  /**
   * @param {string} task
   * @param {import('../core/promptRouter').Route} activeRoute
   * @param {object} [editor]
   * @returns {Promise<string>}
   * @private
   */
  async _buildContext(task, activeRoute, editor) {
    if (this.contextFiles) await this.contextFiles.refresh();

    // Both of the loopless strategies put memory in the user turn rather than the
    // system prompt, and neither wants a file listing it has no way to act on.
    const loopless = activeRoute.strategy === 'none' || activeRoute.strategy === 'chat';

    const built = contextBuilder.build({
      task,
      budget: activeRoute.budgets.promptTokenTarget,
      editor: editor || {},
      // Memory is already in the system prompt for the loop tiers; including it
      // twice would waste a scarce budget on a duplicate. The loopless strategies have
      // no system-prompt memory block, so it arrives here instead — facts included,
      // since "Java is not installed here" is exactly the kind of thing a user asks
      // about conversationally.
      memory: loopless ? (await this._renderMemory()).split('\n').filter(Boolean) : [],
      // Carried on every strategy, not only the conversational one. "Do it the way we
      // discussed" and "the file I mentioned earlier" are ordinary things to say to an
      // agent mid-task, and until 0.4.0 nothing in the prompt could answer either.
      conversation: this.conversation,
      contextFiles: this.contextFiles ? this.contextFiles.renderForPrompt() : '',
      // A model that has to discover the file tree spends steps on it and, worse,
      // invents paths when it guesses. Seeding the listing costs a fraction of the
      // budget and removes the most common failure on Tier B outright.
      workspaceFiles: loopless ? [] : await this._workspaceFiles(activeRoute),
    });

    return built.text;
  }

  /**
   * A shallow listing of the workspace, for orientation on the first turn.
   *
   * Uses the real `list_files` tool so the paths shown are exactly the paths the
   * tools will accept — a listing built any other way could disagree with the guard.
   *
   * @param {import('../core/promptRouter').Route} activeRoute
   * @returns {Promise<string[]>}
   * @private
   */
  async _workspaceFiles(activeRoute) {
    const listing = toolRegistry.get('list_files', activeRoute.mode);
    if (!listing) return [];

    try {
      const result = await listing.handler(
        {},
        {
          workspaceRoot: this.workspaceRoot,
          gate: this.gate,
          sessionId: this.sessionId,
          mode: activeRoute.mode,
          maxObservationTokens: 400,
        }
      );
      const entries = result.detail && Array.isArray(result.detail.entries) ? result.detail.entries : [];
      // Folders are noise here; the model needs paths it can read.
      return entries.filter((entry) => !entry.endsWith('/')).slice(0, 40);
    } catch (err) {
      logger.warn(`Could not seed the workspace listing: ${/** @type {Error} */ (err).message}`);
      return [];
    }
  }

  /**
   * Ask mode. One call, no tools offered at all.
   *
   * @param {string} task
   * @param {import('../core/promptRouter').Route} activeRoute
   * @param {string} context
   * @returns {Promise<string>}
   * @private
   */
  async _answerDirectly(task, activeRoute, context) {
    try {
      const response = await this.client.chat(
        {
          model: this.model,
          messages: [
            { role: 'system', content: activeRoute.systemPrompt },
            // Ollama takes images as base64 on the message itself.
            { role: 'user', content: context, ...(this.images.length > 0 ? { images: this.images } : {}) },
          ],
          options: { temperature: 0.3 },
        },
        { signal: this._controller ? this._controller.signal : undefined }
      );
      return String((response && response.message && response.message.content) || '').trim() || 'No answer was produced.';
    } catch (err) {
      return `The model could not be reached: ${/** @type {Error} */ (err).message}`;
    }
  }

  /**
   * Execute one action.
   *
   * The second of the two mode enforcement points. `toolRegistry.get` returns null
   * for a tool not offered in this mode, so a write in Plan mode cannot execute even
   * if the loop somehow produced one.
   *
   * @param {import('../core/outputParser').ParsedAction} action
   * @param {import('../core/promptRouter').Route} activeRoute
   * @param {ChangeSet} changeSet
   * @returns {Promise<import('./toolRegistry').ToolResult>}
   * @private
   */
  async _execute(action, activeRoute, changeSet) {
    const tool = toolRegistry.get(action.action, activeRoute.mode);
    if (!tool) {
      logger.warn(`Refused action "${action.action}" in ${activeRoute.mode} mode.`);
      const unavailable = {
        ok: false,
        observation:
          activeRoute.mode === 'plan'
            ? `"${action.action}" is not available in Plan mode. You can only look at the project. Finish with "done" and describe the plan.`
            : `"${action.action}" is not an available action.`,
        error: 'TOOL_UNAVAILABLE',
      };
      this._recordStep(action, unavailable, activeRoute, false);
      return unavailable;
    }

    /** @type {import('./toolRegistry').ToolContext} */
    const context = {
      workspaceRoot: this.workspaceRoot,
      gate: this.gate,
      sessionId: this.sessionId,
      mode: activeRoute.mode,
      changeSet,
      maxObservationTokens: Math.floor(activeRoute.budgets.promptTokenTarget * 0.5),
      scriptTimeoutMs: this.scriptTimeoutMs,
      signal: this._controller ? this._controller.signal : undefined,
    };

    /** @type {import('./toolRegistry').ToolResult} */
    let result;
    try {
      result = await tool.handler(action, context);
    } catch (err) {
      // A tool throwing must not kill the session; the model may recover.
      const message = /** @type {Error} */ (err).message;
      logger.error(`Tool ${action.action} threw: ${message}`);
      result = { ok: false, observation: `${action.action} failed: ${message}`, error: 'TOOL_ERROR' };
    }

    // Recorded here rather than in the loops, because this is the one place every
    // action passes through regardless of which tier produced it.
    this._recordStep(action, result, activeRoute, Boolean(tool.mutating));
    return result;
  }

  /**
   * Condense the session into memory, at the configured frequency.
   *
   * @param {AgentStep[]} steps
   * @returns {Promise<void>}
   * @private
   */
  async _remember(steps) {
    if (steps.length === 0) return;

    // Facts first, and independently of the translator: this is pattern-matching over
    // what a program printed, so it costs no inference and must not be skipped just
    // because note-writing is unavailable. It is also the half that outlives the
    // session, which makes it the half worth being careful about losing.
    if (this.facts) {
      try {
        // Deliberately not `_toStepSummary`, which is shaped for the translator and
        // drops the error code. What a fact is derived from is the raw evidence: the
        // action, the command, whether it failed, and what it printed.
        await this.facts.learnFrom(
          steps.map((step) => ({
            action: step.action.action,
            command: step.action.command,
            ok: step.result.ok,
            error: step.result.error,
            observation: step.result.observation,
          }))
        );
      } catch (err) {
        logger.warn(`Could not record what this session established: ${/** @type {Error} */ (err).message}`);
      }
    }

    if (!this.translator) return;

    const budgets = require('../core/modelCapability').budgetsFor(
      this.capability ? this.capability.tier : 'B',
      this.thinkingCapacity
    );

    try {
      if (budgets.translateFrequency === 'every-step') {
        for (const step of steps) {
          await this.translator.translate(this._toStepSummary(step));
        }
      } else {
        await this.translator.translateSession(steps.map((step) => this._toStepSummary(step)));
      }
    } catch (err) {
      // Memory is an optimization; the work is already done and applied.
      logger.warn(`Could not update session memory: ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * @param {AgentStep} step
   * @returns {import('../core/contextTranslator').StepSummary}
   * @private
   */
  _toStepSummary(step) {
    const detail = step.result.detail || {};

    // The observation alone is mechanical ("Updated src/app.js (+7 / -5 lines)"),
    // which gives the translator nothing to describe — it then invents something,
    // the grounding check rejects it, and the note ends up bare. `writeFile` already
    // captures the lines that actually changed, and those are the substance.
    const result = [step.result.observation, detail.preview ? `Changed lines:\n${detail.preview}` : '']
      .filter(Boolean)
      .join('\n');

    return {
      action: step.action.action,
      path: step.action.path,
      command: step.action.command,
      thought: step.action.thought,
      result,
      ok: step.result.ok,
      isNew: Boolean(detail.isNew),
    };
  }
}

module.exports = { AgentSession, ChangeSet, appendUnfinishedNote };
