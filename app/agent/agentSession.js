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
const toolRegistry = require('./toolRegistry');
const contextBuilder = require('../core/contextBuilder');
const reactLoop = require('./reactLoop');
const nativeToolLoop = require('./nativeToolLoop');
const plannerAgent = require('./plannerAgent');
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
 * @param {{stopReason: string, steps: AgentStep[], summary: string}} outcome
 * @param {ChangeSet} changeSet
 * @param {number | null} sizeBefore
 * @returns {{status: 'done' | 'failed', outcomeText: string}}
 */
function judgeItem(outcome, changeSet, sizeBefore) {
  const changed = changeSet.size() > (sizeBefore === null ? 0 : sizeBefore);
  const anySucceeded = outcome.steps.some((step) => step.result && step.result.ok);

  if (outcome.stopReason === 'done') {
    return { status: 'done', outcomeText: changed ? '' : 'no files changed' };
  }
  if (changed && anySucceeded) {
    // Work landed but the loop did not close the item off cleanly. Reporting this as
    // done would overclaim; reporting it as untouched would hide a real edit.
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
   */
  constructor(options) {
    this.client = options.client;
    this.model = options.model;
    this.capability = options.capability;
    this.gate = options.gate;
    this.workspaceRoot = options.workspaceRoot;
    this.memory = options.memory || null;
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
   * @param {(event: object) => void} [options.onEvent]
   * @returns {Promise<SessionResult>}
   */
  async run(task, options = {}) {
    const mode = options.mode || 'agent';
    const emit = options.onEvent || (() => {});
    this._controller = new AbortController();
    this.running = true;

    try {
      const activeRoute = promptRouter.route({
        mode,
        capability: this.capability,
        thinkingCapacity: this.thinkingCapacity,
        memory: this.memory ? await this.memory.renderForPrompt(this._recallDepth()) : '',
      });

      emit({ type: 'start', mode, strategy: activeRoute.strategy, maxSteps: activeRoute.budgets.maxSteps });

      // Ask mode: one response, no loop, no tools in existence.
      if (activeRoute.strategy === 'none') {
        const askContext = await this._buildContext(task, activeRoute, options.editor);
        const summary = await this._answerDirectly(task, activeRoute, askContext);
        emit({ type: 'done', summary });
        return { summary, steps: [], changeSet: new ChangeSet(), stopReason: 'answered', mode };
      }

      const changeSet = new ChangeSet();

      // A model that can hold a TODO list gets the request split into items and works
      // through them one at a time. Everything else keeps the previous behaviour.
      if (mode === 'agent' && this.capability.canPlanTodos) {
        const todoResult = await this._runWithTodos(task, activeRoute, changeSet, options, emit);
        if (todoResult) return todoResult;
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
      if (mode === 'plan') result.plan = plannerAgent.parsePlanSummary(outcome.summary);

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
      emit({ type: 'todo-item', index: position, total: todos.items.length, text: item.text });

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
      const outcome = await loop.run({
        client: this.client,
        model: this.model,
        route: itemRoute,
        task: itemTask,
        context,
        execute: (action) => this._execute(action, itemRoute, changeSet),
        onEvent: emit,
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
      emit({ type: 'todo-item-done', index: position, status, text: item.text });

      await this._remember(outcome.steps);

      if (outcome.stopReason === 'cancelled') {
        todos.skipRemaining('the session was cancelled');
        break;
      }
    }

    if (todos.current()) todos.skipRemaining('the session ran out of steps');

    const progress = todos.progress();
    const summary =
      `${progress.done} of ${progress.total} item(s) completed.\n\n${todos.describe()}` +
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

    const built = contextBuilder.build({
      task,
      budget: activeRoute.budgets.promptTokenTarget,
      editor: editor || {},
      // Memory is already in the system prompt for the loop tiers; including it
      // twice would waste a scarce budget on a duplicate.
      memory: activeRoute.strategy === 'none' && this.memory ? await this.memory.readRecent(this._recallDepth()) : [],
      contextFiles: this.contextFiles ? this.contextFiles.renderForPrompt() : '',
      // A model that has to discover the file tree spends steps on it and, worse,
      // invents paths when it guesses. Seeding the listing costs a fraction of the
      // budget and removes the most common failure on Tier B outright.
      workspaceFiles: activeRoute.strategy === 'none' ? [] : await this._workspaceFiles(activeRoute),
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
      return {
        ok: false,
        observation:
          activeRoute.mode === 'plan'
            ? `"${action.action}" is not available in Plan mode. You can only look at the project. Finish with "done" and describe the plan.`
            : `"${action.action}" is not an available action.`,
        error: 'TOOL_UNAVAILABLE',
      };
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

    try {
      return await tool.handler(action, context);
    } catch (err) {
      // A tool throwing must not kill the session; the model may recover.
      const message = /** @type {Error} */ (err).message;
      logger.error(`Tool ${action.action} threw: ${message}`);
      return { ok: false, observation: `${action.action} failed: ${message}`, error: 'TOOL_ERROR' };
    }
  }

  /**
   * Condense the session into memory, at the configured frequency.
   *
   * @param {AgentStep[]} steps
   * @returns {Promise<void>}
   * @private
   */
  async _remember(steps) {
    if (!this.translator || steps.length === 0) return;

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
