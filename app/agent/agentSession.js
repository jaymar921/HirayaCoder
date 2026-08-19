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

const fs = require('fs');

const logger = require('../utils/logger');
const pathGuard = require('../security/pathGuard');
const promptRouter = require('../core/promptRouter');
const requestPlan = require('../core/requestPlan');
const fileTree = require('../core/fileTree');
const fileSpec = require('../core/fileSpec');
const intentRouter = require('../core/intentRouter');
const toolRegistry = require('./toolRegistry');
const contextBuilder = require('../core/contextBuilder');
const environmentProfile = require('../core/environmentProfile');
const projectOverview = require('../core/projectOverview');
const reactLoop = require('./reactLoop');
const nativeToolLoop = require('./nativeToolLoop');
const plannerAgent = require('./plannerAgent');
const completionCheck = require('./completionCheck');
const earnedHints = require('./earnedHints');
const stepBrief = require('./stepBrief');
const dictation = require('./dictation');
const stepGuard = require('./stepGuard');
const answerCheck = require('./answerCheck');
const commonSense = require('../core/commonSense');
const clarification = require('./clarification');
const { ErrorRecovery } = require('./errorRecovery');
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
 * @property {number} [revision]  When the change set recorded it. See `ChangeSet.since`.
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
    /** @type {Array<{command: string, exitCode: number | null, ok: boolean, revision?: number}>} */
    this.commands = [];
    /**
     * How many records this set has taken, ever.
     *
     * A monotonic counter rather than a size, because size cannot answer the question a
     * TODO step asks: "did *this step* change anything?" A step that edits a file an
     * earlier step created leaves the map exactly the same size, and `size()` reports
     * the step as having done nothing — which on the React benchmark is the common case,
     * since the step that assembles `App.jsx` is editing what the scaffold step made.
     */
    this.revision = 0;
  }

  /**
   * @param {FileChange} change
   */
  record(change) {
    this.revision += 1;
    const existing = this.files.get(change.path);
    if (existing) {
      // Preserve the state from before the session began.
      this.files.set(change.path, {
        ...change,
        revision: this.revision,
        before: existing.before,
        kind: existing.kind === 'create' && change.kind === 'edit' ? 'create' : change.kind,
      });
      return;
    }
    this.files.set(change.path, { ...change, revision: this.revision });
  }

  /**
   * The files recorded since a given revision.
   *
   * @param {number} revision  A value read from `this.revision` earlier.
   * @returns {FileChange[]}
   */
  since(revision) {
    return this.list().filter((change) => (change.revision || 0) > revision);
  }

  /**
   * @param {{command: string, cwd?: string, exitCode: number | null, ok: boolean}} entry
   */
  recordCommand(entry) {
    this.revision += 1;
    // Stamped like a file change, and for the same question: `stepGuard` asks what *this
    // step* did, and until 0.6.1 the commands half of the set could not answer it.
    this.commands.push({ ...entry, revision: this.revision });
  }

  /**
   * The commands run since a given revision.
   *
   * The counterpart to `since`, which reads the files half only. A step that scaffolds a
   * project writes no files through the agent at all, so this is the only record that it
   * did anything — see `stepGuard.ranSomething`.
   *
   * @param {number} revision
   * @returns {Array<{command: string, ok: boolean}>}
   */
  commandsSince(revision) {
    return this.commands.filter((entry) => (entry.revision || 0) > revision);
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
 * How many files one step may be handed to write.
 *
 * The benchmark brief's structure section draws twelve, which is the largest real case
 * seen and the number this is set from. A step naming more than that has almost
 * certainly matched something that is not a file list.
 */
const MAX_DICTATIONS_PER_ITEM = 12;

/** How much of a neighbouring file is read to work out what it exports. */
const MAX_RELATED_FILE_CHARS = 4000;

/**
 * How many times one file is asked for before the run moves on without it.
 *
 * Two, and the second is earned in one of two ways: the reply was unusable (cut off
 * mid-file, or not the kind of file that was asked for), or it was a perfectly good file
 * that does not mention something its requirements named. Both are specific and
 * correctable, which is what makes a retry worth its twenty seconds. A third attempt is
 * not: a model that has now been told twice is not going to find it on the next one.
 */
const MAX_DICTATION_ATTEMPTS = 2;

/** Source files whose imports the assembly check can read. */
const MODULE_FILE = /\.(?:jsx?|tsx?|mjs|cjs|vue|svelte)$/i;

/**
 * Paths a dictation may never target.
 *
 * Generated trees and dependency manifests. `package.json` is the important one: it
 * appears in almost every drawn folder structure, it is written by the scaffolding
 * command rather than by hand, and a model asked to "write package.json for a Vite
 * React app with Tailwind" produces a plausible one with the wrong versions and no
 * scripts — which is exactly what the 0.9.0 baseline recorded `qwen3.5:0.8b` doing,
 * leaving a project whose `npm run build` did not exist.
 */
const UNDICTATABLE =
  /(?:^|\/)(?:node_modules|dist|build|out|coverage|\.git)\/|(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|\.env(?:\..+)?)$/i;

/** Longer than any real path, and the bound that keeps the check below linear. */
const MAX_TARGET_PATH_CHARS = 400;

/**
 * File types a model cannot write, whatever it replies with.
 *
 * `.svg` is deliberately absent — it is text, a model can write one, and a request that
 * asks for an icon means it.
 */
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'icns',
  'pdf', 'zip', 'gz', 'tar', 'jar', 'war', 'class', 'exe', 'dll', 'so', 'dylib', 'bin', 'wasm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'wav', 'ogg', 'webm', 'mov', 'avi',
  'db', 'sqlite', 'lock',
]);

/**
 * Is this a filename, or a piece of prose that looks like one?
 *
 * The rule: a stem of at least two word characters, and an extension of two to eight
 * letters. It took a live sweep to find — a request saying *Counter (e.g. "3 of 5
 * remaining")* had `e.g` picked out of it as a path, and a file called `e.g` was
 * dictated into the project root. `i.e` and `etc.` fail the same rule.
 *
 * The cost is real and small: a genuine single-letter extension like `.c` or `.h` is not
 * dictated and is left to the loop. Against that, a junk file appearing in someone's
 * project, created without them asking, out of a fragment of their own sentence, is
 * exactly the surprise this feature must not produce.
 *
 * ## Why this is not a regular expression
 *
 * It was one, and the obvious one — `[\w@.-]*[\w-]{2,}[\w@.-]*\.[a-z][a-z0-9]{1,7}$` —
 * is quadratic. Three adjacent variable-length classes over the same character set, then
 * a literal that a non-matching input never reaches, is a backtracking machine. Measured
 * on this project's own SAST pass, against a string of `a`s with no dot in it:
 *
 * | Input length | Time |
 * |---|---|
 * | 400 | 19 ms |
 * | 800 | 196 ms |
 * | 1,600 | 1.4 s |
 * | 3,200 | 10.6 s |
 *
 * The input is a token taken out of the user's own request, so this is a hang rather
 * than a compromise — but a paste containing one long unbroken token would freeze the
 * extension, and "it is only the user's own text" has never been a good enough reason
 * here. Split on the last `/` and the last `.` and every step below is linear.
 *
 * @param {string} target
 * @returns {boolean}
 */
function isDictatableFilename(target) {
  const path = String(target);
  if (path.length > MAX_TARGET_PATH_CHARS) return false;

  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  // `dot <= 0` covers both "no extension" and a dotfile like `.env`, whose whole name is
  // the extension and which is never something to dictate.
  if (dot <= 0) return false;

  const stem = name.slice(0, dot);
  const extension = name.slice(dot + 1);
  if (extension.length < 2 || extension.length > 8) return false;
  if (!/^[a-z][a-z0-9]*$/i.test(extension)) return false;
  // A model cannot write a PNG, and a fenced code block written into one is junk with a
  // misleading name. Found while tracing the README section of the benchmark brief,
  // which contains the placeholder `![screenshot](./screenshot.png)` — a real path, a
  // real extension, and nothing a dictation could ever produce.
  if (BINARY_EXTENSIONS.has(extension.toLowerCase())) return false;

  let wordChars = 0;
  for (const character of stem) {
    if (/[\w-]/.test(character)) wordChars += 1;
    if (wordChars >= 2) return true;
  }
  return false;
}

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
 * ## Why this counts revisions rather than files
 *
 * It used to compare `changeSet.size()` against the size before the item ran, and that
 * is wrong for the most ordinary shape a TODO list has: an item that *edits* a file an
 * earlier item created leaves the map exactly the same size. The item is then judged to
 * have changed nothing, the completion check challenges its `done`, and a step that
 * wrote a real file is reported as "it asked for a file and none was written".
 *
 * On the React benchmark that is not an edge case, it is the plan — scaffold `App.jsx`,
 * then assemble `App.jsx` — so the item most likely to be scored as a failure was the
 * one doing the work the user cared about. `ChangeSet.revision` counts records rather
 * than distinct paths, which is the question actually being asked.
 *
 * @param {{stopReason: string, steps: AgentStep[], summary: string, doneChallenged?: boolean}} outcome
 * @param {ChangeSet} changeSet
 * @param {number | null} revisionBefore  `changeSet.revision` from before the item ran.
 * @returns {{status: 'done' | 'done-with-warning' | 'failed', outcomeText: string}}
 */
function judgeItem(outcome, changeSet, revisionBefore) {
  const changed = changeSet.revision > (revisionBefore === null ? 0 : revisionBefore);
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

    // Told outright that nothing had been written, and it closed the item anyway. That
    // is a stronger statement than "no files changed", which reads as a legitimate
    // check — this one is an item that asked for work and did not do it. Observed on
    // `ornith:9b` against "Create todoapp.html …", reported as "done (no files
    // changed)" while the user was asking a fourth time where the file was.
    if (!changed && outcome.doneChallenged) {
      return { status: 'failed', outcomeText: 'it asked for a file and none was written' };
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
/**
 * State plainly that a session claiming to be finished produced nothing.
 *
 * `appendUnfinishedNote` below covers steps that *failed*, and this is the case it
 * cannot see: a session where every step succeeded, nothing was written, and the model
 * said it was done — twice, the second time after being told outright that nothing had
 * changed. Observed on `ornith:9b`: asked four separate times to create `todoapp.html`,
 * it read the two Python files, replied "Finished.", and the user got a one-word
 * success report for a file that did not exist.
 *
 * The completion check gives the model a chance to fix that. This is what happens when
 * it does not take it — and it is the more important half, because the model's second
 * `done` is accepted and would otherwise be reported as an ordinary success.
 *
 * @param {string} summary
 * @param {{doneChallenged?: boolean, stopReason: string}} outcome
 * @param {ChangeSet} changeSet
 * @returns {string}
 */
function appendUnverifiedNote(summary, outcome, changeSet) {
  if (!outcome.doneChallenged || !changeSet.isEmpty()) return summary;

  return (
    `${summary}\n\n**Nothing in the project changed.** I said this was finished, was told ` +
    'no file had been written, and said it was finished again — so treat the summary above ' +
    'as a description of what was intended, not of what happened. Nothing was created, ' +
    'edited, or deleted. Asking again with the exact file path usually works; a larger ' +
    'model is the surer fix.'
  );
}

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
    /**
     * What was changed, and what it was changed from.
     *
     * @type {import('../core/fileHistory').FileHistory | null}
     */
    this.history = options.history || null;
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
     * Whether a `done` is checked against what the session actually produced.
     *
     * On by default and settable off, because it costs a turn in the case where the
     * model was right and the check was wrong — and because a user who has decided they
     * want the model's word taken at face value should be able to have that.
     */
    this.verifyCompletion = options.verifyCompletion !== false;
    /**
     * Run each TODO item as its own briefed step, with a retry and a hard stop.
     *
     * Experimental and off by default. It changes three things at once — what a step is
     * shown, whether a step is checked against its own text, and whether a failure ends
     * the run — and each of those is a bet that costs turns when it is wrong. The user
     * chooses; see the "Step sessions" toggle in the chat header.
     */
    this.stepSessions = options.stepSessions === true;

    /**
     * The machine this session is running on, detected once.
     *
     * Held on the session rather than detected inside `promptRouter` per call: a
     * six-item TODO run in step mode routes once per step, and the answer cannot change
     * between them. Injected in tests to assert the Windows and POSIX prompts without
     * needing the matching machine.
     *
     * @type {import('../core/environmentProfile').EnvironmentProfile}
     */
    this.environment = options.environment || environmentProfile.detect();

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

    /**
     * How a question reaches the user, and their answer comes back.
     *
     * Null is the ordinary state for a benchmark, a test, or any caller that has no
     * panel — and every path that would raise a question checks first and settles for
     * guidance instead. A run must never block on an answer that nothing can give.
     *
     * @type {((request: import('./clarification').Clarification) =>
     *   Promise<import('./clarification').ClarificationAnswer | null>) | null}
     */
    this.onClarify = typeof options.onClarify === 'function' ? options.onClarify : null;

    /**
     * What has failed this run, and what the user has already said about it.
     *
     * Rebuilt per `run` rather than per session: "you have tried this three times" is a
     * claim about one turn, and a new message is a new chance.
     *
     * @type {ErrorRecovery}
     */
    this._recovery = new ErrorRecovery({ canAsk: false });

    /**
     * Set when the user answers a mid-run question with something the loop cannot
     * express — skip this item, or stop altogether. Read by `_runWithTodos` once the
     * loop it was raised inside has returned.
     *
     * @type {'' | 'skip' | 'stop'}
     */
    this._interrupt = '';

    /** What the user said mid-run, for the summary. @type {string[]} */
    this._userGuidance = [];

    /**
     * The checklist currently running, so an answer given inside a loop can adjust it.
     *
     * Null except between `_runWithTodos` building the list and reporting it.
     *
     * @type {TodoList | null}
     */
    this._todos = null;

    /** @type {AbortController | null} */
    this._controller = null;
    this.running = false;
  }

  /**
   * Put a question to the user and wait for the answer.
   *
   * Returns the resolved effect, or null when there was nobody to ask — callers treat
   * that as "carry on as you were", never as a refusal.
   *
   * @param {import('./clarification').Clarification} request
   * @param {(event: object) => void} emit
   * @returns {Promise<{effect: import('./clarification').ClarificationEffect, guidance: string, label: string} | null>}
   * @private
   */
  async _ask(request, emit) {
    if (!this.onClarify) return null;

    emit({ type: 'clarification', request });
    logger.info(`Pausing to ask: ${request.question}`);

    /** @type {import('./clarification').ClarificationAnswer | null} */
    let answer = null;
    try {
      answer = await this.onClarify(request);
    } catch (err) {
      // A question that could not be shown must not take the run down with it. The
      // model is mid-item with a step budget and a change set; failing closed here
      // means carrying on without the answer, not discarding the work.
      logger.warn(`Could not ask the user: ${/** @type {Error} */ (err).message}`);
      return null;
    }

    const resolved = clarification.resolve(request, answer);
    emit({ type: 'clarification-answered', id: request.id, label: resolved.label });
    logger.info(`The user answered "${resolved.label}" (${resolved.effect}).`);

    if (resolved.guidance) this._userGuidance.push(resolved.guidance);
    return resolved;
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
    // Held on the session so `_execute` can raise a question from inside a loop it was
    // not handed the emitter for. Cleared in the `finally` below with everything else
    // that is per-turn.
    this._emit = emit;
    /** The TODO item in flight, so a question can say what it is about. @type {string} */
    this._currentItem = '';
    this.conversation = Array.isArray(options.conversation) ? options.conversation : [];
    this._controller = new AbortController();
    this.running = true;
    this._startedAt = Date.now();
    // Per turn, not per session: three failures ago was a different request, and a run
    // that opened already out of patience would ask about a wall the user may have
    // taken down in between.
    this._recovery = new ErrorRecovery({ canAsk: Boolean(this.onClarify) });
    this._interrupt = '';
    this._userGuidance = [];
    /** What was read differently from what was typed, for the summary. @type {string[]} */
    this._interpretations = [];
    // Snapshotted rather than measured per call: the client already totals every
    // request it makes, so the difference across a session is the time spent waiting on
    // Ollama — including the planning and TODO-splitting passes, which happen outside
    // any loop and would be missed by instrumenting the loops instead.
    this._modelMsAtStart = this._modelMsSoFar();

    try {
      // Read before routed. A request naming a file that is one letter away from a real
      // one is not ambiguous to a person, and a small model handed it literally creates
      // the misspelled file and reports success — so the reading happens here, before
      // anything downstream treats the name as given. Agent mode only: Plan and Ask
      // produce words rather than files, so a wrong name costs a sentence.
      if (mode === 'agent') {
        task = await this._interpretRequest(task, options, emit);
        if (this._interrupt === 'stop') {
          const stopped = {
            summary: 'Stopped before starting, at your request.',
            steps: [],
            changeSet: new ChangeSet(),
            stopReason: 'cancelled',
            mode,
          };
          emit({ type: 'done', summary: stopped.summary });
          return stopped;
        }
      }

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
        // Selected against what was asked rather than by recency. A session's memory
        // file outlives the subject that filled it, so on any turn but the first the
        // most recent notes are about the *previous* request; the notes bearing on this
        // one are further back. Recall is never worse for it — a message that matches
        // nothing falls back to the same recency window this used to take.
        memory: await this._renderMemory({ about: task }),
        earnedHints: await this._earnedHints(mode),
        environment: this.environment,
        intent: intent.intent,
        // "Read the README" should not be able to reach `run_script`, whatever the
        // planner decides in between. See `intentRouter.isReadOnlyRequest`.
        readOnlyTurn: intentRouter.isReadOnlyRequest(task, this.conversation),
      });

      if (activeRoute.readOnlyTurn) {
        logger.info('This message asks to look, not to change; the mutating tools are not offered this turn.');
      }

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
        // Nothing else records a conversational turn: no steps, no change set, no file
        // history. Without this the whole exchange leaves memory empty.
        await this._rememberExchange(task, summary, { changed: false });
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

      // A request gets split into items and worked through one at a time when either
      // the request's own structure says how (any model, no inference — see
      // `core/requestPlan`) or the model is big enough to be asked. `_runWithTodos`
      // decides which, and returns null when neither applies.
      if (mode === 'agent') {
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
        // Agent mode only. A Plan run that changed nothing did exactly what it was for,
        // and challenging it would be the check firing on its own success condition.
        verifyDone: mode === 'agent' ? this._doneVerifier(task, changeSet, 0) : undefined,
        onEvent: emit,
        signal: this._controller.signal,
        images: this.images,
      });

      await this._remember(outcome.steps);

      // Before the honest system notes are appended, not after: those notes are the one
      // part of a summary the model did not write, and they must not be redrafted.
      const checkedSummary = await this._rethink(task, outcome.summary, {
        changedFiles: !changeSet.isEmpty(),
      });

      // A question answered with tools — "explain the auth flow" — leaves an action
      // trail of reads and no record of what was concluded. The `changed` guard keeps
      // this off the turns the action notes already cover.
      await this._rememberExchange(task, checkedSummary, { changed: !changeSet.isEmpty() });

      /** @type {SessionResult} */
      const result = {
        summary:
          appendUnverifiedNote(
            appendUnfinishedNote(checkedSummary, outcome.steps),
            outcome,
            changeSet
          ) + this._describeInterventions(),
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
      this._emit = null;
      this._currentItem = '';
      // Also cleared on the paths that leave `_runWithTodos` early — a cancel, or a
      // throw — where the line at the end of it is never reached.
      this._todos = null;
    }
  }

  /**
   * Read the request the way a person would before handing it to the model.
   *
   * Returns the task to actually run, which is usually the one that came in. See
   * `core/commonSense` for what is checked and why the line between fixing something
   * and asking about it is drawn where it is.
   *
   * Never throws: an interpretation that fails leaves the request exactly as the user
   * typed it, which is the behaviour every version before 0.7.0 had.
   *
   * @param {string} task
   * @param {object} options
   * @param {(event: object) => void} emit
   * @returns {Promise<string>}
   * @private
   */
  async _interpretRequest(task, options, emit) {
    let files = [];
    try {
      files = await this._workspaceFiles(null);
    } catch (err) {
      logger.debug(`Could not list the workspace to read the request against: ${/** @type {Error} */ (err).message}`);
      return task;
    }

    /** @type {import('../core/commonSense').Interpretation} */
    let reading;
    try {
      reading = commonSense.interpret({
        task,
        files,
        conversation: this.conversation,
        editorPath: options.editor ? options.editor.path : '',
        canAsk: Boolean(this.onClarify),
      });
    } catch (err) {
      logger.warn(`Could not read the request: ${/** @type {Error} */ (err).message}`);
      return task;
    }

    if (reading.kind === 'repaired') {
      this._interpretations.push(reading.note);
      emit({ type: 'interpretation', note: reading.note });
      // Into memory as well as the summary. A user who names the same file the same
      // wrong way twice in one session should not have it re-derived from scratch, and
      // the note is composed rather than model-written so it is safe to keep.
      if (this.memory) {
        try {
          await this.memory.append(reading.note);
        } catch (err) {
          logger.debug(`Could not record the reading: ${/** @type {Error} */ (err).message}`);
        }
      }
      return reading.task;
    }

    if (reading.kind === 'ask' && reading.clarification) {
      const resolved = await this._ask(reading.clarification, emit);
      if (!resolved) return task;
      if (resolved.effect === 'stop') {
        this._interrupt = 'stop';
        return task;
      }
      // Appended rather than substituted. The user answered a question about their own
      // request, so what they said is an addition to it — replacing the text would
      // discard the half the question was not about.
      const note = `You asked about this and the user said: ${resolved.guidance}`;
      this._interpretations.push(note);
      return `${task}\n\n${note}`;
    }

    return task;
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

    // The request's own structure first, and only then the model.
    //
    // Not an optimization — it is the only route open to most of the models this
    // extension exists for. `planTodos` needs `thinking` and 2B parameters, so below
    // that threshold there was no list at all and the whole request went into every
    // prompt. Reading headings and numbered steps needs no inference, so it works at
    // 0.8B exactly as well as at 70B.
    //
    // It is also better where both are available: the items are spans of the user's own
    // text in the user's own order, and each one carries the section it came from, so
    // the step that runs it is shown three hundred words about the folder structure
    // rather than five thousand about the whole app. And it costs no round-trip.
    const structural = requestPlan.fromRequest(task);
    /** @type {Array<string | {text: string, detail: string}>} */
    let items = structural.items;
    let planSource = 'the request’s own structure';

    if (items.length === 0) {
      if (!this.capability.canPlanTodos) {
        logger.debug(`No structure to split on (${structural.reason}) and this model is not asked to plan.`);
        return null;
      }
      const planContext = await this._buildContext(task, activeRoute, options.editor);
      items = await plannerAgent.planTodos({
        client: this.client,
        model: this.model,
        task,
        context: planContext,
        signal: this._controller.signal,
      });
      planSource = 'the model';
    }

    // One item is not a list — it is the task. Running it through this path would add
    // a wrapper and an inference call to buy nothing.
    if (!TodoList.isWorthKeeping(items)) {
      logger.debug('TODO planning produced fewer than two items; running the task directly.');
      return null;
    }

    const todos = new TodoList(items);
    // Rules the request states once and means throughout — "no external UI libraries",
    // "React functional components only". They are not work, so they are not items;
    // they ride under every step instead. Empty unless the plan came from the structure.
    const constraints = structural.constraints;
    // Behaviour the request states in sections that name no files — see core/requestPlan.
    const requirements = structural.requirements || '';
    logger.info(`Checklist of ${todos.items.length} item(s) from ${planSource}.`);
    // Reachable from `_recover`, which runs inside a loop this method is awaiting and
    // has no other way to reach the checklist. Cleared in the `finally` below so a
    // later turn cannot write into a list that has already been reported.
    this._todos = todos;
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

    /** Set when a step failed twice and the run is stopping deliberately. */
    let stopNotice = '';
    let cancelled = false;
    /** Set when the user, asked mid-run, chose to stop. Not the same as cancelling. */
    let stoppedByUser = false;

    while (todos.current() && remainingSteps > 0) {
      if (this._controller.signal.aborted) {
        todos.skipRemaining('the session was cancelled');
        break;
      }

      const item = todos.current();
      const position = todos.position();
      // So a question raised from inside this item's loop can say what it is about.
      this._currentItem = item.text;
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

      /** @type {{outcome: any, verdict: any, attempts: number} | null} */
      let attemptResult = null;
      /** How many times this item has been run. Never more than two — see `stepGuard`. */
      const maxAttempts = this.stepSessions ? 2 : 1;

      // Item scope, not attempt scope. A retried item is one item: what it produced is
      // everything both attempts wrote, and it is judged on all of it. Attempt one
      // writing the wrong file and attempt two writing the right one is a step that
      // succeeded, and the file the first attempt touched still has to be recorded for
      // the steps that come after.
      const itemRevisionBefore = changeSet.revision;
      let itemStepCount = 0;

      // Before the loop is asked to decide anything, write the files this step names.
      //
      // Only ever files the *request* named, and only on the constrained tier — a Tier
      // A model orchestrates tools well enough to be left to it, and the whole finding
      // behind `agent/dictation` is about the tier that does not. See `_dictateFiles`.
      /** @type {{written: string[], failed: Array<{path: string, reason: string}>, steps: AgentStep[]}} */
      let dictated = { written: [], failed: [], steps: [] };
      if (this.capability.tier === 'B' && item.detail) {
        dictated = await this._dictateFiles({
          item,
          constraints,
          requirements,
          route: activeRoute,
          changeSet,
          emit,
          stepOffset: allSteps.length,
        });
        allSteps.push(...dictated.steps);
        itemStepCount += dictated.steps.length;
        if (dictated.written.length) {
          summaries.push(`Wrote ${dictated.written.join(', ')}.`);
        }
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (remainingSteps <= 0 || this._controller.signal.aborted) break;

        // Never below a read-think-modify, or the item cannot succeed even in
        // principle and the run would only look like it tried.
        const itemBudget = Math.max(MIN_STEPS_PER_TODO_ITEM, Math.min(perItemSteps, remainingSteps));
        // The system prompt carries the memory block on both loop tiers, and it is
        // built once per message — before the list exists, so every step of a six-item
        // run would otherwise share one recency-selected recall. In step mode it is
        // rebuilt per step against that step's own subject, which is the half of
        // "linked memory" that matters: the note naming the file this step has to
        // import is, by the time the step runs, the oldest one in the file.
        const itemRoute = {
          ...(await this._routeForStep(activeRoute, item.text)),
          budgets: { ...activeRoute.budgets, maxSteps: itemBudget },
        };

        // Attempt scope, and only for the `done` check: an attempt that reports itself
        // finished having written nothing must be challenged even when the previous
        // attempt did write something.
        const attemptRevisionBefore = changeSet.revision;

        // An item that carries its own section of the request gets the step brief
        // whether or not the experimental step mode is on, because the alternative
        // below puts the entire request back into the prompt — which is the exact cost
        // the split was made to avoid. The experimental flag governs the *retry*, which
        // is a separate thing and stays where it was.
        const itemTask =
          this.stepSessions || item.detail
            ? stepBrief.build({
                task,
                item: item.text,
                detail: item.detail,
                constraints,
                position,
                total: todos.items.length,
                items: todos.items,
                changes: changeSet.list(),
                attempt,
                previousFailure: attemptResult ? attemptResult.verdict.detail : '',
              })
            : `${task}\n\n${todos.render()}\n\n` +
              `Right now, do only item ${position}: ${item.text}\n` +
              'Ignore the other items — they are handled separately. When this one item is complete, reply with "done".';

        // The transition itself, at info, because the experimental step mode is the
        // feature most often being evaluated when someone reads this log — and "was it
        // even on?" was previously answerable only from a line written when the tab
        // toggled it, hours earlier in a different session.
        logger.info(
          `Step ${position}/${todos.items.length}, attempt ${attempt} of ${maxAttempts}: ` +
            `${itemBudget} step(s) budgeted, ${this.stepSessions ? 'step-scoped brief' : 'full request'}.`
        );

        // A step's memory is selected by what the step is about, not by what happened
        // most recently — the note naming the file this step has to import is usually
        // the oldest one in the file by the time the step runs. See
        // `memoryStore.readRelevant`.
        const context = await this._buildContext(itemTask, itemRoute, options.editor, {
          recallAbout: item.text,
        });

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
          // Judged against this item's own text and this item's own starting point: the
          // list runs one loop per item, and an earlier item's file is not evidence that
          // this one did anything.
          verifyDone: this._doneVerifier(item.text, changeSet, attemptRevisionBefore, { planned: true }),
          onEvent: emitForItem,
          signal: this._controller.signal,
          // Only the first item sees the image. By item two the work is grounded in
          // files that have been read, and re-uploading the picture each time would
          // cost more than it informs.
          images: position === 1 && attempt === 1 ? this.images : [],
        });

        allSteps.push(...outcome.steps);
        itemStepCount += outcome.steps.length;
        remainingSteps -= Math.max(1, outcome.steps.length);
        if (outcome.summary) summaries.push(`${position}. ${outcome.summary}`);
        await this._remember(outcome.steps);

        const verdict = stepGuard.verify({
          item: item.text,
          stopReason: outcome.stopReason,
          changed: changeSet.since(itemRevisionBefore),
          // A scaffold step's whole output is a command's side effects, which never pass
          // through `write_file` and so never appear above.
          commands: changeSet.commandsSince(itemRevisionBefore),
          steps: outcome.steps,
        });

        attemptResult = { outcome, verdict, attempts: attempt };

        // The user was asked mid-item and said stop. Distinct from a cancel: they made
        // a decision about this run rather than abandoning it, and the summary says so.
        if (this._interrupt === 'stop') {
          stoppedByUser = true;
          break;
        }
        if (outcome.stopReason === 'cancelled') {
          cancelled = true;
          break;
        }
        // Asked mid-item and told to skip. The retry below is exactly what they
        // declined, so it does not happen.
        if (this._interrupt === 'skip') break;
        if (verdict.ok || attempt === maxAttempts) break;

        // About to be written off, so it gets one more run with the diagnosis stated —
        // never a second, for the reason in `stepGuard`'s header.
        logger.info(`Step ${position} did not land (${verdict.reason}); reconsidering once before failing it.`);
        emit({ type: 'todo-item-retry', index: position, text: item.text, reason: verdict.detail });
      }

      // The item was never run at all — cancelled between the checklist event and the
      // first attempt. It stays active, so the skip below records it honestly.
      if (!attemptResult) {
        todos.skipRemaining('the session was cancelled');
        break;
      }

      const { outcome, verdict, attempts } = attemptResult;
      const produced = changeSet.since(itemRevisionBefore);

      // Completion is judged from what the run produced, never from the model saying
      // so — the same models that report a declined delete as successful would tick
      // off an item they never touched. In step mode the guard's verdict narrows it
      // further: changing *a* file is not the same as changing *this step's* file.
      let { status, outcomeText } = judgeItem(outcome, changeSet, itemRevisionBefore);
      if (this.stepSessions && !verdict.ok) {
        // The guard's reason wins even when `judgeItem` had already failed the item.
        // Both are true, and only one of them tells the user which file is missing:
        // "it asked for a file and none was written" against "this step is about
        // src/App.jsx, but what changed was vite.config.js".
        status = 'failed';
        outcomeText = verdict.detail;
      }

      const changedPaths = produced.map((change) => change.path);

      // The user was asked about this item and chose to leave it. That is a decision,
      // not a failure, and recording it as one would put a `[!]` against a row the user
      // themselves closed — and would then feed "an earlier step failed" to every item
      // after it.
      if (this._interrupt === 'skip') {
        this._interrupt = '';
        todos.skipCurrent('you asked me to skip this one');
        emit({
          type: 'todo-item-done',
          index: position,
          status: 'skipped',
          text: item.text,
          items: snapshotTodos(todos),
        });
        continue;
      }

      todos.finishCurrent(status, outcomeText, itemStepCount, { changedPaths, attempts });
      emit({ type: 'todo-item-done', index: position, status, text: item.text, items: snapshotTodos(todos) });

      if (stoppedByUser) {
        todos.skipRemaining('you stopped the run here');
        break;
      }

      if (cancelled) {
        todos.skipRemaining('the session was cancelled');
        break;
      }

      // One failed step means every step after it is working against a project that
      // does not have what it was promised. Carrying on produced the missing-path
      // cascade the benchmark runs are full of, so the run stops and says so.
      if (this.stepSessions && status === 'failed') {
        const skipped = todos.remaining();
        stopNotice = stepGuard.workaround({
          item: item.text,
          position,
          verdict,
          remaining: skipped,
          steps: outcome.steps,
        });
        logger.warn(`Step ${position} failed twice; stopping the run rather than cascading.`);
        todos.skipRemaining('an earlier step failed, so this was not attempted');
        break;
      }
    }

    if (todos.current()) todos.skipRemaining('the session ran out of steps');

    // Everything is written. Does the screen they were written for actually use them?
    //
    // Runs after the items rather than inside one, because the answer is only knowable
    // once they have all had their turn — and it is the failure that survived every
    // other check in two evaluations: a clean build over an app that renders the
    // scaffold's demo.
    if (this.capability.tier === 'B' && constraints !== undefined && !this._controller.signal.aborted) {
      const assembled = await this._assemble({
        constraints,
        requirements,
        route: activeRoute,
        changeSet,
        emit,
        stepOffset: allSteps.length,
      });
      allSteps.push(...assembled.steps);
      if (assembled.rewrote) summaries.push(`Wired ${assembled.missing.join(', ')} into ${assembled.rewrote}.`);
    }

    const progress = todos.progress();
    const caveat =
      progress.warned > 0
        ? ` ${progress.warned} of those changed files without the model confirming it had finished — check them.`
        : '';
    const summary =
      `${progress.done} of ${progress.total} item(s) completed.${caveat}\n\n${todos.describe()}` +
      (stopNotice ? `\n\n${stopNotice}` : '') +
      // What the user was asked and what they said, before the per-item detail. A run
      // that only succeeded because they answered a question should say so — otherwise
      // the checklist reads as though the model worked it out on its own.
      this._describeInterventions(todos) +
      (summaries.length > 0 ? `\n\nDetail:\n${summaries.join('\n')}` : '');

    // The list is reported now, so nothing may write into it afterwards.
    this._todos = null;

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
   * What the run had to be told, and by whom, for the end of the summary.
   *
   * Three separate things end up here and they are not interchangeable: what was read
   * differently from what the user typed, what the user said when asked mid-run, and
   * what kept failing regardless. A summary that reports only the checklist hides all
   * three — and the third is the one a user most needs, because a run that ends "4 of 4
   * completed" after hitting the same error eleven times is technically true and
   * actively misleading.
   *
   * @param {TodoList} [todos]
   * @returns {string} Empty when the run needed none of it.
   * @private
   */
  _describeInterventions(todos) {
    const blocks = [];

    if (this._interpretations && this._interpretations.length > 0) {
      blocks.push(`How I read the request:\n${this._interpretations.map((note) => `- ${note}`).join('\n')}`);
    }

    if (this._userGuidance && this._userGuidance.length > 0) {
      blocks.push(`What you told me when I asked:\n${this._userGuidance.map((note) => `- ${note}`).join('\n')}`);
    }

    if (todos) {
      const changed = todos.describeChanges();
      if (changed) blocks.push(changed);
    }

    const stuck = this._recovery ? this._recovery.persistent() : [];
    if (stuck.length > 0) {
      const lines = stuck
        .slice(0, 3)
        .map((entry) => `- ${entry.action} failed ${entry.count} times: ${entry.headline}`);
      blocks.push(`What kept going wrong:\n${lines.join('\n')}`);
    }

    return blocks.length > 0 ? `\n\n${blocks.join('\n\n')}` : '';
  }

  /**
   * The route for one step, with its memory block recalled against that step.
   *
   * ## Why every item gets this, not only a briefed step
   *
   * Until 0.7.0 this returned the session's route untouched unless step sessions were
   * on, so a six-item run shared one memory block — selected by recency, before the
   * list existed, against the whole request. That is the wrong block for every item
   * after the first. The React benchmark shows the failure exactly: the item that had
   * to assemble `App.jsx` ran sixth, and the notes naming `useTodos.js` and
   * `TodoInput.jsx` — the two files it needed to import — were by then the oldest in
   * the file and the first to fall out of a five-entry recency window. The note that
   * survived was about the README.
   *
   * Recall by subject is never worse than recall by recency: an item whose text
   * matches nothing gets exactly the recency window it would have had (see
   * `memoryStore.readRelevant`). What it costs is one extra prompt assembly per item,
   * which is string work against an already-loaded file — no inference, no disk.
   *
   * Returns the session's own route untouched when there is no memory to select from.
   *
   * @param {import('../core/promptRouter').Route} activeRoute
   * @param {string} about    The step's text.
   * @returns {Promise<import('../core/promptRouter').Route>}
   * @private
   */
  async _routeForStep(activeRoute, about) {
    if (!this.memory || !about) return activeRoute;

    try {
      return promptRouter.route({
        mode: activeRoute.mode,
        capability: this.capability,
        thinkingCapacity: this.thinkingCapacity,
        memory: await this._renderMemory({ about }),
        earnedHints: await this._earnedHints(activeRoute.mode),
        environment: this.environment,
        intent: 'task',
        // Carried, not recomputed. This route replaces the session's for the whole
        // step, so dropping the flag would hand the mutating tools back to a turn the
        // router had already decided was a look-only request — and now that every item
        // rebuilds its route, that would be the default path rather than an
        // experimental one. The decision belongs to the session's route; this only
        // re-renders the memory block underneath it.
        readOnlyTurn: activeRoute.readOnlyTurn,
      });
    } catch (err) {
      // A step must never fail to start because its recall could not be assembled.
      logger.warn(`Could not build a step-scoped prompt: ${/** @type {Error} */ (err).message}`);
      return activeRoute;
    }
  }

  /**
   * The check a loop runs before accepting the model's word that it has finished.
   *
   * Bound to a starting size rather than to emptiness, so within a TODO list each item
   * is judged on what *it* produced. Plan mode gets no verifier at all: a plan changing
   * nothing is the entire point of it.
   *
   * @param {string} task What this loop was asked to do.
   * @param {ChangeSet} changeSet
   * @param {number} revisionBefore  See `judgeItem` for why this is not a size.
   * @param {{planned?: boolean}} [opts]  True when `task` is a TODO item rather than a
   *   message the user typed — see `intentRouter.requiresChange`.
   * @returns {((summary: string) => string | null) | undefined}
   * @private
   */
  _doneVerifier(task, changeSet, revisionBefore, opts = {}) {
    if (this.verifyCompletion === false) return undefined;

    return () =>
      completionCheck.objectTo({
        task,
        changed: changeSet.revision > revisionBefore,
        written: changeSet.list().filter((change) => change.kind !== 'delete'),
        // Every command this run executed, so a `done` cannot be accepted on top of a
        // build the model watched fail. Not scoped to `revisionBefore` like the file
        // checks: a TODO item that leaves the build broken has broken it for every item
        // after it, and the run should not reach the end still red.
        commands: changeSet.commands,
        planned: Boolean(opts.planned),
        exists: (relativePath) => this._existsInWorkspace(relativePath),
      });
  }

  /**
   * Is there a file at this workspace-relative path right now?
   *
   * Confined the same way every other path is, and false for anything that escapes —
   * a task naming `/etc/passwd` is not evidence about this project. Used only to
   * decide whether a file the task named is genuinely missing.
   *
   * @param {string} relativePath
   * @returns {boolean}
   * @private
   */
  /**
   * Read a workspace file, or return null.
   *
   * Confined by `pathGuard` like every other read. Used to tell a dictation what the
   * files around it export, and to show it what it is rewriting.
   *
   * @param {string} relativePath
   * @returns {string | null}
   * @private
   */
  _readInWorkspace(relativePath) {
    if (!this.workspaceRoot) return null;
    try {
      const resolved = pathGuard.resolvePath(this.workspaceRoot, relativePath);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined above
      const source = fs.readFileSync(resolved.absolute, 'utf8');
      return source.length > MAX_RELATED_FILE_CHARS ? source.slice(0, MAX_RELATED_FILE_CHARS) : source;
    } catch {
      return null;
    }
  }

  /**
   * The files this item is responsible for, and whether each may be written.
   *
   * Two questions, and the request answers both. *Which* files: the tree the user drew,
   * read by `core/fileTree`, or failing that the paths the item's own text names.
   * *Whether*: a file that does not exist yet is this step's to create, and a file that
   * already exists is left alone **unless the user annotated it** in their tree.
   *
   * That last rule is doing real work. The benchmark brief's tree comments `App.jsx`
   * with "Composes layout + components" and leaves `package.json` and `vite.config.js`
   * bare — because the first is a file the author expects to be authored and the others
   * are what `npm create vite` produces. Rewriting `App.jsx`, which the scaffold left
   * holding its counter demo, is the single thing that most needed doing in the 0.7.0
   * and 0.9.0 baseline runs. Rewriting `package.json` would destroy the project.
   *
   * @param {import('./todoList').TodoItem} item
   * @returns {Array<{path: string, purpose: string, exists: boolean}>}
   * @private
   */
  _filesForItem(item) {
    const detail = String(item.detail || '');
    if (!detail) return [];

    const named = fileTree.hasTree(detail)
      ? fileTree.files(detail)
      : stepBrief.namedFiles(`${item.text}\n${detail}`).map((path) => ({ path, purpose: '' }));

    /** @type {Array<{path: string, purpose: string, exists: boolean}>} */
    const targets = [];
    const seen = new Set();
    for (const entry of named) {
      const target = String(entry.path || '').replace(/^\.\//, '');
      if (!target || seen.has(target)) continue;
      seen.add(target);
      if (UNDICTATABLE.test(target)) continue;
      if (!isDictatableFilename(target)) continue;

      // You cannot fill in a project that has not been created yet.
      //
      // The rule below reads as fussy and it is load-bearing. Measured on
      // `qwen3.5:0.8b`: the setup step's loop failed to scaffold, the structure step
      // then dictated `todo-glass-app/src/components/ClearButton.jsx` — creating
      // `todo-glass-app/` on the way — and when the scaffold command finally ran,
      // `npm create vite` found a non-empty directory, **exited 0, and created
      // nothing**. A clean exit code over a project that does not exist is the worst
      // possible failure, because everything downstream believes it.
      //
      // So a file inside a project directory is dictated only once that directory is
      // there. If the scaffold never happens the run writes nothing and says so, which
      // is the honest outcome; when the next turn scaffolds, dictation resumes. Files at
      // the workspace root have no such prerequisite and are always allowed.
      const root = target.includes('/') ? target.slice(0, target.indexOf('/')) : '';
      if (root && !this._existsInWorkspace(root)) continue;

      const exists = this._existsInWorkspace(target);
      // An existing file with nothing said about it is somebody else's — the
      // scaffold's, or the user's. Only an annotated one may be replaced.
      if (exists && !entry.purpose) continue;
      targets.push({ path: target, purpose: String(entry.purpose || ''), exists });
    }
    return targets;
  }

  /**
   * Write the files this item names by asking the model for their contents.
   *
   * See `agent/dictation` for why this exists: below about 2B the JSON action protocol
   * is the bottleneck rather than the coding, and `llama3.2:1b` answered eleven turns
   * out of eleven with an unparseable reply while being perfectly able to write the
   * component when simply asked for it.
   *
   * Every write goes through `_execute`, so the permission gate, the path guard, the
   * change set, the file history and the audit log all see it exactly as they see a
   * write the model chose for itself. The only difference is who picked the path, and
   * here that is the user's own request.
   *
   * @param {object} options
   * @param {import('./todoList').TodoItem} options.item
   * @param {string} options.constraints
   * @param {string} options.requirements
   * @param {import('../core/promptRouter').Route} options.route
   * @param {ChangeSet} options.changeSet
   * @param {(event: object) => void} options.emit
   * @param {number} options.stepOffset
   * @returns {Promise<{written: string[], failed: Array<{path: string, reason: string}>, steps: AgentStep[]}>}
   * @private
   */
  async _dictateFiles(options) {
    const { item, constraints, requirements, route, changeSet, emit } = options;
    /** @type {{written: string[], failed: Array<{path: string, reason: string}>, steps: AgentStep[]}} */
    const outcome = { written: [], failed: [], steps: [] };

    if (!route.allowedActions.has('write_file')) return outcome;

    const targets = this._filesForItem(item).slice(0, MAX_DICTATIONS_PER_ITEM);
    if (targets.length === 0) return outcome;

    // The drawing comes out of the background before the background goes into a prompt
    // about one file. The paths have already been read; leaving fifteen filenames in
    // front of a 0.8B model competes with the one filename in the instruction, and
    // recency wins — asked for `tailwind.config.js` with the tree in view, it returned a
    // `package.json`. What is left is the prose around the tree, which is the part worth
    // keeping: "do not flatten it", "all todo CRUD operations live in the `useTodos`
    // custom hook, components stay presentational".
    const background = fileTree.hasTree(item.detail) ? fileTree.withoutTree(item.detail) : item.detail;

    logger.info(`Dictating ${targets.length} file(s) named by step "${item.text.slice(0, 60)}".`);

    for (const target of targets) {
      if (this._controller.signal.aborted) break;

      // What the neighbours export, read off the disk rather than remembered. This is
      // what makes `App.jsx` import `TodoList` by the name `TodoList.jsx` actually
      // exported — the failure that cost the 0.7.0 session an hour of pasted console
      // errors.
      const related = [];
      for (const change of changeSet.list()) {
        if (change.kind === 'delete' || change.path === target.path) continue;
        const source = this._readInWorkspace(change.path);
        if (source) related.push({ path: change.path, source });
      }

      // What the request asks *this file* to do, gathered from wherever it was written.
      //
      // The step that writes `TodoItem.jsx` lives in the folder-structure section, which
      // specifies no behaviour at all; the behaviour is three sections away, under
      // *Features*, which names no files. Without this the model writing the row that
      // owns toggle, edit and delete is never shown the words "Escape", "blur" or
      // "double-click" — every one of which the benchmark grades. See `core/fileSpec`.
      const relevant = fileSpec.forFile({
        path: target.path,
        purpose: target.purpose,
        requirements,
      });
      if (relevant.matched > 0) {
        logger.debug(`${target.path}: ${relevant.matched} of ${relevant.considered} requirement(s) apply.`);
      }

      const current = target.exists ? this._readInWorkspace(target.path) : null;
      const spec = [
        background,
        current
          ? 'This file already exists. Its current contents are below; replace them with what ' +
            `this step asks for, keeping anything still needed.\n---\n${current}\n---`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      // One retry, with the reason the first reply was rejected.
      //
      // Worth its cost because the rejections are specific and correctable — "the reply
      // was cut off", "that is not JavaScript" — rather than the model being unable to
      // do it. A second unusable reply is recorded as a miss and the run carries on: a
      // file that could not be written is a fact the summary should carry, not a reason
      // to abandon the other eleven.
      let result = null;
      /** What the last attempt was told it had got wrong. */
      let complaint = '';
      for (let attempt = 1; attempt <= MAX_DICTATION_ATTEMPTS; attempt += 1) {
        result = await dictation.dictate({
          client: this.client,
          model: this.model,
          path: target.path,
          purpose: target.purpose,
          requirements: relevant.text,
          spec,
          constraints,
          related: related.slice(-dictation.MAX_RELATED),
          previousError: complaint,
          signal: this._controller.signal,
        });
        if (this._controller.signal.aborted) break;

        if (!result.ok) {
          complaint = result.reason;
          continue;
        }

        // The file arrived. Now: does it contain the things its requirements named?
        //
        // Only literal words are checked — an identifier the author backticked, or a key
        // whose spelling the platform fixes (`Escape` is `Escape`, `blur` is `blur`).
        // A requirement that says "cancel on Escape" over code that never says the word
        // is a requirement that did not get implemented, and that is worth one more go.
        // Anything softer is deliberately not checked: "with a confirmation state" can be
        // written a dozen ways, and a guess at those would rewrite working code.
        const missing = dictation.missingFrom(relevant.text, result.code);
        if (missing.length === 0 || attempt >= MAX_DICTATION_ATTEMPTS) break;

        complaint =
          `the file was written but does not mention ${missing.join(', ')}, which the requirements above ask for. ` +
          'Write it again, in full, actually implementing those.';
        logger.info(`${target.path}: missing ${missing.join(', ')}; asking again.`);
      }

      if (!result.ok) {
        outcome.failed.push({ path: target.path, reason: result.reason });
        // Said out loud rather than swallowed. A file the request named and the run
        // could not produce is exactly what a user needs to know, and the first version
        // of this dropped five of eleven files in silence.
        emit({ type: 'dictation-failed', path: target.path, reason: result.reason });
        logger.warn(`Could not write ${target.path}: ${result.reason}.`);
        continue;
      }

      const action = {
        action: 'write_file',
        path: target.path,
        code: result.code,
        thought: target.purpose || `write ${target.path}, named by this step`,
      };
      emit({ type: 'action', step: options.stepOffset + outcome.steps.length + 1, action });
      const executed = await this._execute(action, route, changeSet);
      emit({ type: 'observation', step: options.stepOffset + outcome.steps.length + 1, result: executed });
      outcome.steps.push({ action, result: executed });

      if (executed.ok) outcome.written.push(target.path);
      else outcome.failed.push({ path: target.path, reason: executed.observation });
    }

    return outcome;
  }

  /**
   * Make sure the file everything else was written for actually uses it.
   *
   * The single most expensive failure in two evaluations, and the one a build cannot
   * see: five correct components on disk, a clean `npm run build`, and an `App.jsx`
   * still holding the scaffold's counter demo because nothing ever went back to it. The
   * 0.7.0 analysis recorded it across five models; the 0.9.0 baseline reproduced it with
   * every gate green and **2 of 12** features working.
   *
   * Nothing here needs the model's judgement. The extension knows which files this
   * session wrote, it knows which of them is the composition root, and it can read
   * whether that file imports the others. When it does not, the file is asked for again
   * with the missing imports named — one more dictation, not a whole extra turn.
   *
   * @param {object} options
   * @param {string} options.constraints
   * @param {string} options.requirements
   * @param {import('../core/promptRouter').Route} options.route
   * @param {ChangeSet} options.changeSet
   * @param {(event: object) => void} options.emit
   * @param {number} options.stepOffset
   * @returns {Promise<{rewrote: string, missing: string[], steps: AgentStep[]}>}
   * @private
   */
  async _assemble(options) {
    const { route, changeSet, emit } = options;
    /** @type {{rewrote: string, missing: string[], steps: AgentStep[]}} */
    const outcome = { rewrote: '', missing: [], steps: [] };
    if (!route.allowedActions.has('write_file')) return outcome;

    const written = changeSet
      .list()
      .filter((change) => change.kind !== 'delete' && MODULE_FILE.test(change.path))
      .map((change) => change.path);
    if (written.length < 2) return outcome;

    // The composition root among the files this session actually wrote. A root the
    // session never touched is not this check's business — it belongs to whoever wrote
    // it, and rewriting it uninvited is the behaviour the annotation rule exists to
    // prevent.
    const root = written.find((candidate) => fileSpec.isComposition(candidate, ''));
    if (!root) return outcome;

    const source = this._readInWorkspace(root);
    if (!source) return outcome;

    // A file counts as imported if its module name appears in an import or require. The
    // path may be written a dozen ways — `./components/TodoList`, `../components/TodoList.jsx`,
    // an alias — so the basename is what is looked for, inside import statements only.
    const importing = (source.match(/^\s*(?:import\b[^\n]*|const[^\n]*=\s*require\([^\n]*)/gm) || []).join('\n');
    const missing = written
      .filter((candidate) => candidate !== root)
      .filter((candidate) => {
        const name = (candidate.split('/').pop() || '').replace(/\.[^.]*$/, '');
        return name.length > 1 && !importing.includes(name);
      });

    outcome.missing = missing;
    if (missing.length === 0) return outcome;

    logger.info(`${root} does not use ${missing.join(', ')}; asking for it again.`);

    const related = [];
    for (const candidate of written) {
      if (candidate === root) continue;
      const text = this._readInWorkspace(candidate);
      if (text) related.push({ path: candidate, source: text });
    }

    const result = await dictation.dictate({
      client: this.client,
      model: this.model,
      path: root,
      purpose: 'the screen that puts the other components together',
      requirements: options.requirements,
      spec:
        `This file already exists but does not use ${missing.join(', ')}, which this session wrote ` +
        'for it. Write it again so that it imports and renders them. Its current contents are ' +
        `below.\n---\n${source}\n---`,
      constraints: options.constraints,
      related: related.slice(-dictation.MAX_RELATED),
      signal: this._controller.signal,
    });

    if (!result.ok) {
      emit({ type: 'dictation-failed', path: root, reason: result.reason });
      logger.warn(`Could not reassemble ${root}: ${result.reason}.`);
      return outcome;
    }

    const action = {
      action: 'write_file',
      path: root,
      code: result.code,
      thought: `wire ${missing.join(', ')} into ${root}`,
    };
    emit({ type: 'action', step: options.stepOffset + 1, action });
    const executed = await this._execute(action, route, changeSet);
    emit({ type: 'observation', step: options.stepOffset + 1, result: executed });
    outcome.steps.push({ action, result: executed });
    if (executed.ok) outcome.rewrote = root;

    return outcome;
  }

  _existsInWorkspace(relativePath) {
    if (!this.workspaceRoot) return false;
    try {
      const resolved = pathGuard.resolvePath(this.workspaceRoot, relativePath);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined above
      return fs.existsSync(resolved.absolute);
    } catch {
      return false;
    }
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
   * @param {number} [ms] How long the tool took, including any confirmation wait.
   * @private
   */
  _recordStep(action, result, activeRoute, mutating, ms) {
    if (!this._adapting()) return;

    // A permission prompt only decided this step if the tool was one that asks. A
    // successful read is not the user "approving" anything.
    let decision;
    if (result.error === 'USER_DENIED') decision = 'declined';
    else if (mutating && result.ok) decision = 'approved';

    void this.ledger.recordStep({
      model: this.model,
      params: this.capability ? this.capability.params : undefined,
      tier: this.capability ? this.capability.tier : 'B',
      thinking: this.thinkingCapacity,
      mode: activeRoute.mode,
      sessionId: this.sessionId,
      action: action.action,
      ok: Boolean(result.ok),
      code: result.ok ? undefined : result.error,
      decision,
      ms,
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
    // Written from the change set, which holds the state from *before the turn began*
    // even for a file edited three times — so the recorded diff is the net effect the
    // user was shown, not the agent's intermediate drafts.
    if (this.history && !result.changeSet.isEmpty()) {
      await this.history.recordAll(result.changeSet.list(), {
        sessionId: this.sessionId,
        model: this.model,
      });
    }

    const ms = this._startedAt ? Date.now() - this._startedAt : undefined;
    const modelMs =
      typeof this._modelMsAtStart === 'number' ? this._modelMsSoFar() - this._modelMsAtStart : undefined;

    // Logged whether or not the ledger is on. Adaptation is a choice about whether the
    // extension *learns*; how long a turn took is the first thing anyone needs when a
    // session felt slow, and the output channel is where they will look for it.
    if (typeof ms === 'number') {
      const share = ms > 0 && typeof modelMs === 'number' ? ` (${Math.round((modelMs / ms) * 100)}% waiting on the model)` : '';
      logger.info(`Turn finished in ${(ms / 1000).toFixed(1)}s${share} — ${result.stopReason}, ${result.steps.length} step(s).`);
    }

    if (!this._adapting()) return;

    await this.ledger.recordSession({
      model: this.model,
      params: this.capability ? this.capability.params : undefined,
      tier: this.capability ? this.capability.tier : 'B',
      thinking: this.thinkingCapacity,
      mode: result.mode,
      sessionId: this.sessionId,
      stopReason: result.stopReason,
      steps: result.steps.length,
      changed: !result.changeSet.isEmpty(),
      ms,
      modelMs,
    });
  }

  /**
   * Total milliseconds this client has spent on Ollama since it was created.
   *
   * Returns 0 for a client without health tracking — a test double, mostly — so the
   * subtraction still produces a number rather than a NaN that would land in the file.
   *
   * @returns {number}
   * @private
   */
  _modelMsSoFar() {
    return this.client && this.client.health ? this.client.health.totalLatencyMs : 0;
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
   * @param {{about?: string}} [opts]  Select session notes by relevance to this text
   *   rather than by recency alone. See `memoryStore.readRelevant`.
   * @returns {Promise<string>}
   * @private
   */
  async _renderMemory(opts = {}) {
    const blocks = [];

    if (this.facts) {
      try {
        const known = await this.facts.renderForPrompt();
        if (known) blocks.push(known);
      } catch (err) {
        logger.warn(`Could not read established facts: ${/** @type {Error} */ (err).message}`);
      }
    }

    // What this session has already changed. Distinct from the notes below, which say
    // a file was touched, and from the facts above, which say what is true of the
    // project: this says "you did that, it is done". Observed without it, more than
    // once — a model that had correctly wired two classes together rewrote the file
    // later without the wiring, because nothing in its context said the wiring was its
    // own work from four turns ago.
    if (this.history) {
      try {
        const changed = await this.history.renderForPrompt(this.sessionId);
        if (changed) blocks.push(changed);
      } catch (err) {
        logger.warn(`Could not read what this session has changed: ${/** @type {Error} */ (err).message}`);
      }
    }

    if (this.memory) blocks.push(await this.memory.renderForPrompt(this._recallDepth(), { about: opts.about }));

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
   * @param {{recallAbout?: string}} [opts]  What this turn is about, for targeted
   *   memory recall. Empty means recency, which is the behaviour everywhere but a
   *   briefed step.
   * @returns {Promise<string>}
   * @private
   */
  async _buildContext(task, activeRoute, editor, opts = {}) {
    if (this.contextFiles) await this.contextFiles.refresh();

    // Both of the loopless strategies put memory in the user turn rather than the
    // system prompt.
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
      memory: loopless ? (await this._renderMemory({ about: opts.recallAbout })).split('\n').filter(Boolean) : [],
      // Carried on every strategy, not only the conversational one. "Do it the way we
      // discussed" and "the file I mentioned earlier" are ordinary things to say to an
      // agent mid-task, and until 0.4.0 nothing in the prompt could answer either.
      conversation: this.conversation,
      contextFiles: this.contextFiles ? this.contextFiles.renderForPrompt() : '',
      // What the project says it is. Carried everywhere except the conversational
      // route: "what is this about?" is asked at least as often in Ask mode as in Agent
      // mode, and Ask has no way to go and find out.
      //
      // The exception is not a budget decision. A model handed a project description
      // and the message "Hello Hiraya" answers with the project description — observed
      // twice in one session, once for a greeting and once for "I'm Jay". The chat
      // route exists for messages that are not about the project, and giving it the
      // one block that is guarantees the reply will be.
      projectOverview: activeRoute.strategy === 'chat' ? '' : projectOverview.build(this.workspaceRoot),
      // A model that has to discover the file tree spends steps on it and, worse,
      // invents paths when it guesses. Seeding the listing costs a fraction of the
      // budget and removes the most common failure on Tier B outright.
      //
      // Carried on the loopless strategies too, which it was not originally. The
      // reasoning then was that a mode with no tools has "no way to act on" a listing,
      // and that conflated acting with knowing. Ask mode cannot open a file, but it is
      // routinely asked what is *in* the project, and with an empty listing it answered
      // "There are no files listed in your workspace" — in a workspace of several
      // hundred files. Naming what exists is not an action; it is the answer.
      workspaceFiles: await this._workspaceFiles(activeRoute),
    });

    return built.text;
  }

  /**
   * A shallow listing of the workspace, for orientation on the first turn.
   *
   * Uses the real `list_files` tool so the paths shown are exactly the paths the
   * tools will accept — a listing built any other way could disagree with the guard.
   *
   * ## Why the mode is substituted for the loopless strategies
   *
   * Ask mode offers zero tools, by design and by test: `route.tools` is empty and
   * `toolRegistry.get('list_files', 'ask')` returns null. That guarantee is about what
   * the *model* may invoke, and it is not weakened here — the route is untouched, the
   * model is still offered nothing, and it cannot request a listing or any other read.
   *
   * What happens instead is that the extension reads the directory itself and puts the
   * result in the prompt, exactly as it does for the open editor file, which Ask mode
   * has always received without anyone calling it a tool. Looking up the handler under
   * a read-only mode is how that read is performed; it is not a grant.
   *
   * @param {import('../core/promptRouter').Route | null} activeRoute
   *   Null when the read happens before a route exists — `_interpretRequest` needs the
   *   listing to decide whether a filename in the request resolves, and that decision
   *   comes before routing. Treated as read-only, which is what such a read is.
   * @returns {Promise<string[]>}
   * @private
   */
  async _workspaceFiles(activeRoute) {
    const loopless = !activeRoute || activeRoute.strategy === 'none' || activeRoute.strategy === 'chat';
    // 'plan' is the read-only mode. Substituted only to resolve the handler; the gate
    // below still audits the read under the mode the user is actually in.
    const lookupMode = loopless ? 'plan' : activeRoute.mode;
    const listing = toolRegistry.get('list_files', lookupMode);
    if (!listing) return [];

    try {
      const result = await listing.handler(
        {},
        {
          workspaceRoot: this.workspaceRoot,
          gate: this.gate,
          sessionId: this.sessionId,
          mode: lookupMode,
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
   * Record that a question was asked and answered.
   *
   * ## Why memory needed this
   *
   * `memoryStore` held nothing but actions. A forty-turn session produced a three-line
   * file, every line a failed command; another produced one line, and that line was a
   * malformed shell invocation the model had proposed in response to "Magandang hapon!".
   * Nothing either party *said* was in there, which is why "have you already answered
   * this?" could not be answered from memory — the memory did not contain answers.
   *
   * The transcript does hold the conversation, and `contextBuilder` carries the last
   * ten turns of it. That covers "what did we just discuss" and not "you told me this
   * an hour and thirty turns ago", which is precisely the range memory is for: it is
   * recalled by relevance to the current question rather than by recency, so an
   * exchange from early in a long session comes back when it becomes relevant again.
   *
   * ## Why only some turns
   *
   * A turn that changed files is already recorded three times over — the action notes
   * below, `fileHistory`, and the change set. Adding a fourth entry would spend a Tier
   * B recall budget of three to five slots on a duplicate.
   *
   * So this records the turns nothing else does: questions answered, and conversation.
   * Those are exactly the turns that leave no trace anywhere and exactly the ones the
   * user was asking about.
   *
   * @param {string} task
   * @param {string} answer
   * @param {{changed: boolean}} opts
   * @returns {Promise<void>}
   * @private
   */
  async _rememberExchange(task, answer, opts) {
    if (!this.memory || opts.changed) return;

    const question = String(task || '').replace(/\s+/g, ' ').trim();
    const reply = String(answer || '').replace(/\s+/g, ' ').trim();
    if (!question || !reply) return;

    // Nothing was actually answered. Recording "I could not reach the model" as a fact
    // about the project would be worse than recording nothing.
    if (/^(?:the model could not be reached|no answer was produced|stopped before)/i.test(reply)) return;

    // Head-truncated, like every other bounded quote in this codebase: a question says
    // what it wants first, and an answer's first sentence is its answer.
    const short = (text, limit) => (text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text);

    try {
      await this.memory.append(`Asked "${short(question, 90)}" — answered: ${short(reply, 160)}`);
    } catch (err) {
      logger.warn(`Could not record the exchange: ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * Re-read the question against the drafted answer, and correct it if they disagree.
   *
   * ## Why this is a gate and not a step
   *
   * The obvious design is a second pass on every turn. On local hardware that is a
   * second full generation for every reply, most of which were fine — the measured
   * failures were concentrated in one shape (a summary of file changes offered as the
   * answer to a question) that `answerCheck` recognises for free.
   *
   * So the structural check runs always and the model runs only when it fires. A turn
   * that was already correct costs nothing; a turn that was wrong costs one extra call
   * and usually stops being wrong.
   *
   * ## Why a failed redraft keeps the draft
   *
   * Every failure path here returns the original. A redraft that times out, comes back
   * empty, or comes back still mismatched leaves the user with the answer they would
   * have had anyway — worse than a good answer, better than an error, and never worse
   * than the behaviour before this existed. The check is allowed to be wrong; it is not
   * allowed to lose the reply.
   *
   * @param {string} task
   * @param {string} draft
   * @param {object} [opts]
   * @param {boolean} [opts.changedFiles]  Did the turn actually modify the workspace?
   * @param {string} [opts.systemPrompt]   Reused for the redraft, so the corrected answer
   *   is bound by the same mode rules as the draft. Falls back to a minimal instruction.
   * @param {string} [opts.context]        The context the draft was written from.
   * @returns {Promise<string>}
   * @private
   */
  async _rethink(task, draft, opts = {}) {
    const verdict = answerCheck.check({
      task,
      answer: draft,
      changedFiles: Boolean(opts.changedFiles),
      conversation: this.conversation,
    });
    if (!verdict.mismatched) return draft;

    logger.info(`Answer did not match the question (${verdict.reason}); asking for one redraft.`);

    try {
      const response = await this.client.chat(
        {
          model: this.model,
          messages: [
            {
              role: 'system',
              content:
                opts.systemPrompt ||
                'You are HirayaCoder. Answer the user\'s question directly and concisely, in prose.',
            },
            ...(opts.context ? [{ role: 'user', content: opts.context }] : []),
            {
              role: 'user',
              content:
                `The user asked:\n${task}\n\n` +
                `You drafted this reply:\n${draft}\n\n` +
                `${verdict.instruction}\n\n` +
                'Write the corrected reply now. Output only the reply itself — no preamble, ' +
                'no explanation of what you changed.',
            },
          ],
          options: { temperature: 0.3 },
        },
        { signal: this._controller ? this._controller.signal : undefined }
      );

      const redraft = String((response && response.message && response.message.content) || '').trim();
      if (!redraft) return draft;

      // One attempt only. A model that reproduces the same shape twice is not going to
      // be argued out of it, and a loop here would be unbounded on exactly the small
      // models least able to escape it.
      const recheck = answerCheck.check({
        task,
        answer: redraft,
        changedFiles: Boolean(opts.changedFiles),
        conversation: this.conversation,
      });
      if (recheck.mismatched) {
        logger.debug('The redraft did not match either; keeping the original answer.');
        return draft;
      }

      return redraft;
    } catch (err) {
      logger.warn(`Could not redraft the answer: ${/** @type {Error} */ (err).message}`);
      return draft;
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
      const draft =
        String((response && response.message && response.message.content) || '').trim() || 'No answer was produced.';
      // Nothing this path does can change a file, so a changelog here is always wrong.
      return this._rethink(task, draft, { changedFiles: false, systemPrompt: activeRoute.systemPrompt, context });
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
    // Two gates, as before, plus the per-turn one. `allowedActions` is what the route
    // actually offered — on a read-only turn that is the non-mutating set even though
    // the mode is still 'agent', so consulting the mode alone would let a write through
    // that the model was never shown.
    const offered = activeRoute.allowedActions.has(action.action);
    const tool = offered ? toolRegistry.get(action.action, activeRoute.mode) : null;
    if (!tool) {
      logger.warn(`Refused action "${action.action}" in ${activeRoute.mode} mode.`);
      const unavailable = {
        ok: false,
        observation: activeRoute.readOnlyTurn
          ? `"${action.action}" is not available for this request. You were asked to look and explain, not to change anything or run commands. Read what you need and finish with "done".`
          : activeRoute.mode === 'plan'
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
    const startedAt = Date.now();
    try {
      result = await tool.handler(action, context);
    } catch (err) {
      // A tool throwing must not kill the session; the model may recover.
      const message = /** @type {Error} */ (err).message;
      logger.error(`Tool ${action.action} threw: ${message}`);
      result = { ok: false, observation: `${action.action} failed: ${message}`, error: 'TOOL_ERROR' };
    }
    // Includes any time the user spent looking at a confirmation dialog, which is the
    // honest reading of "how long did this step take" and is worth being able to see:
    // a session that looks slow because a prompt sat unanswered for two minutes is not
    // a slow model.
    const ms = Date.now() - startedAt;

    // Recorded here rather than in the loops, because this is the one place every
    // action passes through regardless of which tier produced it.
    this._recordStep(action, result, activeRoute, Boolean(tool.mutating), ms);

    // Same reason, and the reason this is the right place for it: a failure that
    // repeats has to be counted across the whole turn, and only this method sees every
    // action from both loop tiers.
    if (!result.ok) result = await this._recover(action, result);

    // The one line that reconstructs a session afterwards: what was asked for, what
    // happened, and how long it took. Debug rather than info, because a run is dozens
    // of these — but when a user reports "it said it edited the file and it did not",
    // this is the record that settles it, and it costs nothing until they turn it on.
    const target = action.path || action.command || action.query || '';
    logger.debug(
      `Step: ${action.action}${target ? ` ${target}` : ''}${action.cwd ? ` (in ${action.cwd})` : ''} → ` +
        `${result.ok ? 'ok' : `failed${result.error ? ` [${result.error}]` : ''}`} in ${ms}ms`
    );
    return result;
  }

  /**
   * Decide what a failed action gets told, and whether the user gets asked.
   *
   * Returns the result the loop will see — usually the same one with a sentence added.
   * The observation is the only channel back to the model on a Tier B loop, so that is
   * where the guidance has to go; there is no side band it would read.
   *
   * @param {object} action
   * @param {import('./toolRegistry').ToolResult} result
   * @returns {Promise<import('./toolRegistry').ToolResult>}
   * @private
   */
  async _recover(action, result) {
    /** @type {import('./errorRecovery').Failure} */
    const failure = {
      action: String(action.action || ''),
      path: action.path,
      command: action.command,
      error: result.error,
      observation: String(result.observation || ''),
      // `runScript` appends its own "What went wrong: …" sentence when a rule matched,
      // and a second explanation saying the same thing differently is noise in a
      // context window that has none spare. `detail.reason` is set exactly when that
      // happened — see `tools/runScript`.
      diagnosed: Boolean(result.detail && result.detail.reason),
      item: this._currentItem || '',
    };

    /** @type {import('./errorRecovery').RecoveryDecision} */
    let decision;
    try {
      decision = this._recovery.observe(failure);
    } catch (err) {
      logger.warn(`Could not assess the failure: ${/** @type {Error} */ (err).message}`);
      return result;
    }

    if (decision.note && this.memory) {
      try {
        await this.memory.append(decision.note);
      } catch (err) {
        logger.debug(`Could not record the failure: ${/** @type {Error} */ (err).message}`);
      }
    }

    if (decision.kind === 'ask' && decision.clarification) {
      const resolved = await this._ask(decision.clarification, this._emit || (() => {}));
      if (resolved) {
        const note = this._recovery.recordAnswer(failure, resolved.guidance || resolved.label);
        if (this.memory) {
          try {
            await this.memory.append(note);
          } catch (err) {
            logger.debug(`Could not record the answer: ${/** @type {Error} */ (err).message}`);
          }
        }

        if (resolved.effect === 'stop') {
          this._interrupt = 'stop';
          // Aborting is what actually stops a loop mid-item; the flag alone is only
          // read once the loop has returned, which could be several steps later.
          if (this._controller) this._controller.abort();
          return { ...result, observation: `${result.observation}\n\nThe user stopped the run here.` };
        }
        if (resolved.effect === 'skip') {
          this._interrupt = 'skip';
        }

        // The user has just said what this step is actually supposed to do, so the
        // checklist should say it too. Not cosmetic: the item's text is what the retry
        // is briefed on, what `stepGuard` checks the changed files against, and what
        // the summary reads back — leaving it as the model's original wording means
        // the one authoritative statement of the step is the only place their
        // correction does not reach.
        if (resolved.effect === 'instruct' && this._todos && resolved.guidance) {
          this._todos.replaceCurrent(`${this._todos.current().text} — ${resolved.guidance}`);
        }

        return {
          ...result,
          observation: `${result.observation}\n\n${resolved.guidance || resolved.label}`,
        };
      }
      // Nobody answered. Fall through to guidance rather than blocking.
      return result;
    }

    if (decision.kind === 'guidance' && decision.guidance) {
      return { ...result, observation: `${result.observation}\n\n${decision.guidance}` };
    }

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
      cwd: step.action.cwd,
      thought: step.action.thought,
      result,
      ok: step.result.ok,
      isNew: Boolean(detail.isNew),
    };
  }
}

module.exports = { AgentSession, ChangeSet, appendUnfinishedNote };
