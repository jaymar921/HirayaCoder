'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * The two fs calls here target `this.filePath`, built from the VS Code workspace
 * root and a fixed filename. No component derives from model output. */

/**
 * What happened, in numbers: `.hirayacoder/outcomes.jsonl`.
 *
 * Every session already produces an honest, local, evidence-based record — guard
 * refusals with error codes, stop reasons, whether the change set grew, whether the
 * user approved or declined. Until this file existed, nothing consumed any of it, so
 * the extension made the same mistakes with the same model forever. The ledger is the
 * memory that makes `agent/earnedHints` possible.
 *
 * ## Two rules decide the record shape
 *
 * **The signal comes from evidence, never from the model's self-report.** The same
 * principle `judgeItem` enforces, for the same reason: a model that reports a declined
 * delete as "deleted the file" would also report a session it botched as a success.
 * So nothing a model *says* is stored — only what the tools and guards returned.
 *
 * **No free text, ever.** A record holds enum-shaped values and counts: a model name,
 * a tier, an action name, a guard error code, a stop reason, booleans. No paths, no
 * commands, no file contents, no model prose. That is a deliberate narrowing rather
 * than an oversight — the audit log next door already answers "what was touched", and
 * this file only has to answer "how often does this model trip this guard". Keeping
 * workspace content out of it means the learning layer cannot leak a project into a
 * prompt, and it makes the redaction pass a formality rather than a defence.
 *
 * Unlike the audit log, this file *can* be cleared: a learned setting that makes
 * things worse must be as easy to discard as it was to acquire.
 *
 * @module core/outcomeLedger
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
const { JsonlLog } = require('../utils/jsonlLog');
const { redact } = require('../security/secretsScanner');

/**
 * Smaller than the audit log's cap. A record is ~150 bytes and carries no content, so
 * a megabyte is thousands of steps — far more history than any profile should weigh.
 */
const MAX_LEDGER_BYTES = 1024 * 1024;

/** Every value in a record is a short token; anything longer is not one of ours. */
const MAX_VALUE_CHARS = 120;

/** How many records a profile is built from, unless a caller says otherwise. */
const DEFAULT_STATS_WINDOW = 1000;

/**
 * @typedef {object} StepOutcome
 * @property {string} model
 * @property {'A' | 'B'} tier
 * @property {'low' | 'medium' | 'high'} thinking
 * @property {'agent' | 'plan' | 'ask'} mode
 * @property {string} sessionId
 * @property {string} action              The tool name, e.g. 'write_file'.
 * @property {boolean} ok
 * @property {string} [code]              Guard or tool error code, when it failed.
 * @property {'approved' | 'declined'} [decision]  Only when a permission prompt decided it.
 */

/**
 * @typedef {object} SessionOutcome
 * @property {string} model
 * @property {'A' | 'B'} tier
 * @property {'low' | 'medium' | 'high'} thinking
 * @property {'agent' | 'plan' | 'ask'} mode
 * @property {string} sessionId
 * @property {string} stopReason
 * @property {number} steps
 * @property {boolean} changed            Did the change set grow?
 */

/**
 * @typedef {object} ModelProfile
 * @property {string} model
 * @property {number} steps               Actions executed.
 * @property {number} failures            Of those, how many failed.
 * @property {number} sessions
 * @property {number} sessionsThatChanged
 * @property {number} declined            Permission prompts the user answered no to.
 * @property {Map<string, number>} trips  Guard error code → how many times.
 * @property {Map<string, number>} stops  Stop reason → how many sessions ended that way.
 */

/**
 * A fresh, empty profile.
 *
 * @param {string} model
 * @returns {ModelProfile}
 */
function emptyProfile(model) {
  return {
    model,
    steps: 0,
    failures: 0,
    sessions: 0,
    sessionsThatChanged: 0,
    declined: 0,
    trips: new Map(),
    stops: new Map(),
  };
}

/**
 * @param {Map<string, number>} counter
 * @param {string} key
 */
function bump(counter, key) {
  counter.set(key, (counter.get(key) || 0) + 1);
}

/**
 * Fold raw records into one profile per model.
 *
 * A Map rather than an object: the keys are Ollama model names, which arrive from
 * outside, and a plain object would resolve `'constructor'` to a prototype member and
 * hand the caller something that is not a profile.
 *
 * Records the file has that this build does not understand are skipped rather than
 * guessed at — the file outlives any one version of the extension.
 *
 * @param {object[]} records
 * @returns {Map<string, ModelProfile>}
 */
function summarize(records) {
  /** @type {Map<string, ModelProfile>} */
  const byModel = new Map();

  for (const record of records || []) {
    if (!record || typeof record !== 'object') continue;
    const model = typeof record.model === 'string' ? record.model : '';
    if (!model) continue;

    if (!byModel.has(model)) byModel.set(model, emptyProfile(model));
    const profile = /** @type {ModelProfile} */ (byModel.get(model));

    if (record.kind === 'session') {
      profile.sessions += 1;
      if (record.changed === true) profile.sessionsThatChanged += 1;
      if (typeof record.stopReason === 'string' && record.stopReason) bump(profile.stops, record.stopReason);
      continue;
    }

    if (record.kind !== 'step') continue;

    profile.steps += 1;
    if (record.ok === false) {
      profile.failures += 1;
      if (typeof record.code === 'string' && record.code) bump(profile.trips, record.code);
    }
    if (record.decision === 'declined') profile.declined += 1;
  }

  return byModel;
}

class OutcomeLedger extends JsonlLog {
  /**
   * @param {string} workspaceRoot
   * @param {object} [opts]
   * @param {string} [opts.fileName] Default '.hirayacoder/outcomes.jsonl'.
   * @param {number} [opts.maxBytes]
   */
  constructor(workspaceRoot, opts = {}) {
    super(path.join(workspaceRoot, opts.fileName || path.join('.hirayacoder', 'outcomes.jsonl')), {
      maxBytes: opts.maxBytes || MAX_LEDGER_BYTES,
      label: 'outcome ledger',
    });
    this.root = workspaceRoot;
  }

  /**
   * One action, as the tools and guards reported it.
   *
   * @param {StepOutcome} outcome
   * @returns {Promise<void>}
   */
  recordStep(outcome) {
    return this.append({ ...outcome, kind: 'step' });
  }

  /**
   * One finished session.
   *
   * @param {SessionOutcome} outcome
   * @returns {Promise<void>}
   */
  recordSession(outcome) {
    return this.append({ ...outcome, kind: 'session' });
  }

  /**
   * Drop every key that is not part of the record shape, and bound what is left.
   *
   * An allow-list rather than a deny-list, so a caller that grows a new field — a
   * path, a command, a summary — cannot silently start writing workspace content into
   * a file whose whole value is that it holds none.
   *
   * @param {object} entry
   * @returns {object}
   * @protected
   */
  _sanitize(entry) {
    // Redaction is belt and braces: no field here is meant to be able to carry a
    // credential, and this is what makes that a guarantee rather than an intention.
    const text = (value) =>
      typeof value === 'string' && value !== '' ? this._bound(redact(value), MAX_VALUE_CHARS) : undefined;
    const flag = (value) => (typeof value === 'boolean' ? value : undefined);
    const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined);

    // This literal *is* the allow-list. Written out rather than looped over a list of
    // field names so that adding a field is a visible edit to the record shape.
    const safe = {
      ts: new Date().toISOString(),
      kind: text(entry.kind),
      model: text(entry.model),
      tier: text(entry.tier),
      thinking: text(entry.thinking),
      mode: text(entry.mode),
      sessionId: text(entry.sessionId),
      action: text(entry.action),
      code: text(entry.code),
      decision: text(entry.decision),
      stopReason: text(entry.stopReason),
      ok: flag(entry.ok),
      changed: flag(entry.changed),
      steps: count(entry.steps),
    };

    // Absent keys stay absent rather than serializing as null, so `'code' in record`
    // means what it says and an unremarkable step stays a short line.
    return Object.fromEntries(Object.entries(safe).filter(([, value]) => value !== undefined));
  }

  /**
   * Profiles for every model in the recent window.
   *
   * @param {number} [window] How many records to fold in.
   * @returns {Promise<Map<string, ModelProfile>>}
   */
  async profiles(window = DEFAULT_STATS_WINDOW) {
    try {
      return summarize(await this.read(window));
    } catch (err) {
      // The ledger is an optimization. A session must never fail because the file it
      // learns from could not be read.
      logger.warn(`Could not read the outcome ledger: ${/** @type {Error} */ (err).message}`);
      return new Map();
    }
  }

  /**
   * One model's profile, empty when it has no history yet.
   *
   * @param {string} model
   * @param {number} [window]
   * @returns {Promise<ModelProfile>}
   */
  async profileFor(model, window = DEFAULT_STATS_WINDOW) {
    const all = await this.profiles(window);
    return all.get(model) || emptyProfile(model);
  }

  /**
   * Forget everything the extension has learned in this workspace.
   *
   * Deliberately present here and absent from the audit log: a profile is advisory
   * and must be discardable, while a record of what was done to the user's files is
   * not the extension's to erase.
   *
   * @returns {Promise<void>}
   */
  async clear() {
    await this.flush();
    for (const file of [this.filePath, `${this.filePath}.1`]) {
      try {
        await fs.promises.unlink(file);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
          logger.warn(`Could not clear the outcome ledger: ${/** @type {Error} */ (err).message}`);
        }
      }
    }
  }
}

module.exports = {
  OutcomeLedger,
  summarize,
  emptyProfile,
  MAX_LEDGER_BYTES,
  MAX_VALUE_CHARS,
  DEFAULT_STATS_WINDOW,
};
