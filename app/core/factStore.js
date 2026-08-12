'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Every fs call targets `this.filePath`, built from the VS Code workspace root and a
 * constant filename. No component derives from model output. */

/**
 * Typed, workspace-scoped facts — the half of memory that is not a diary.
 *
 * `memoryStore` records what the agent *did*: "Ran `javac …` (failed)", "Edited
 * src/todo_manager.py". That is a useful log and a poor memory, because almost nothing
 * a user needs remembered is an action. Across a six-session evaluation, none of the
 * things that actually mattered survived into it:
 *
 *   - Java is not installed on this machine.
 *   - The Python here is 3.9, so `str | None` is a syntax error.
 *   - We gave up on Java and moved to Python.
 *   - The deliverable is `todoapp.html`.
 *
 * The first two are facts about the *environment*, and they are the expensive ones.
 * Session 1 spent its entire step budget discovering that `javac` could not run.
 * Session 2, in the same workspace an hour later, spent its budget discovering it
 * again — then proposed `sudo apt-get install default-jdk` on macOS. Nothing carried,
 * because the only thing being carried was a list of actions, and "this command failed"
 * is not the same statement as "this toolchain is absent".
 *
 * ## What goes in here
 *
 * Only what the extension knows for certain, from the same evidence the outcome ledger
 * uses: exit codes, error codes, and the text a program printed. Never the model's
 * account of itself. A model that reports a declined delete as successful would also
 * report a missing compiler as installed, and a wrong fact in here is worse than no
 * fact — it is a wrong fact that persists across sessions and is presented to every
 * future turn as established truth.
 *
 * That is also why there is no model call anywhere in this file. Facts are detected by
 * matching what a program printed, or they are not recorded.
 *
 * ## Scope
 *
 * Per workspace, not per session — the whole point is that session 2 starts knowing
 * what session 1 found out. This is the same reasoning that puts `outcomeLedger` at
 * workspace scope, and the same reasoning that keeps `memoryStore` at session scope:
 * one holds what is true of the project, the other what happened in a conversation.
 *
 * ## This file is untrusted input
 *
 * It is JSONL on disk that the user (or anything else) can edit, and its contents are
 * injected into prompts. Every field is neutralized through `memoryStore.neutralize` on
 * the way out, so a hand-edited file cannot smuggle a delimiter or a role marker into a
 * system prompt. Malformed lines are skipped rather than throwing.
 *
 * @module core/factStore
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
const { neutralize, similarity, DUPLICATE_THRESHOLD } = require('./memoryStore');

/**
 * What a fact is about. The kind is not decoration — it decides ordering in the prompt
 * and what may supersede what.
 *
 * - `environment` — true of this machine: a toolchain that is missing, a version that
 *   rules out a syntax. The only kind currently detected, and the one that pays for the
 *   whole module.
 * - `decision` — a direction the user set, which outranks anything inferred.
 * - `artifact` — what the project is meant to produce.
 * - `preference` — how the user wants things done.
 */
const KINDS = new Set(['environment', 'decision', 'artifact', 'preference']);

/** Headings, in the order they are rendered. Most binding first. */
const KIND_ORDER = ['decision', 'environment', 'artifact', 'preference'];

/** @type {Record<string, string>} */
const KIND_LABEL = {
  decision: 'Decided',
  environment: 'This machine',
  artifact: 'Deliverable',
  preference: 'Preference',
};

/** Beyond this the file is treated as corrupt rather than read into a prompt. */
const MAX_FILE_BYTES = 256 * 1024;

/** Facts past this count are ignored; a workspace with more has gone wrong. */
const MAX_FACTS = 200;

/** How many facts a single prompt carries. Oldest are dropped first. */
const DEFAULT_RECALL = 12;

/**
 * Programs whose absence is worth remembering, and how each one says it is missing.
 *
 * Deliberately keyed on the *program*, so the recorded fact names something actionable
 * ("javac is not available") rather than repeating an error string. The patterns cover
 * all three platforms because the same missing JDK announces itself three different
 * ways, and a detector that only knew the macOS phrasing would have been written from
 * exactly one transcript and silently useless everywhere else:
 *
 *   macOS    The operation couldn't be completed. Unable to locate a Java Runtime.
 *   Linux    javac: command not found
 *   Windows  'javac' is not recognized as an internal or external command
 *
 * The generic patterns are matched against the *command's own binary*, so a build that
 * fails because some tool it shells out to is missing does not get recorded as the
 * build tool being absent.
 */
const RUNTIME_MISSING = [
  // Apple's stub binaries: present on PATH, exit non-zero, no JVM behind them. This is
  // the case no allow-list or PATH check can catch, because the program really is there.
  { pattern: /unable to locate a java runtime/i, binaries: ['java', 'javac'], name: 'a Java runtime (JDK)' },
  { pattern: /no java runtime present/i, binaries: ['java', 'javac'], name: 'a Java runtime (JDK)' },
];

/** Generic "this program does not exist" messages, per platform. */
const NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /command not found/i,
  /: not found\b/i,
  /no such file or directory/i,
];

/**
 * The first word of a command — the program it runs.
 *
 * @param {string} command
 * @returns {string}
 */
function binaryOf(command) {
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  return first.split(/[/\\]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/**
 * Read a durable fact out of one executed step, or return null.
 *
 * Null is by far the common answer, and that is correct: most steps establish nothing
 * that outlives the session. A detector that fired often would fill the prompt with
 * restatements of the trace, which is the failure this module exists to avoid.
 *
 * @param {{action: string, command?: string, ok: boolean, error?: string, observation?: string}} step
 * @returns {{kind: string, text: string, subject: string} | null}
 */
function observe(step) {
  if (!step || step.ok !== false) return null;

  // Only script runs say anything about the machine. A refused write says something
  // about the model.
  if (step.action !== 'run_script' && step.action !== 'run_tests') return null;

  const command = String(step.command || '');
  const binary = binaryOf(command);
  const output = String(step.observation || '');

  for (const rule of RUNTIME_MISSING) {
    if (rule.pattern.test(output) && (rule.binaries.length === 0 || rule.binaries.includes(binary))) {
      return {
        kind: 'environment',
        subject: `runtime:${rule.name}`,
        text: `${rule.name} is not available on this machine — \`${binary}\` exists but cannot run. Do not plan work that needs it; say what the user would have to install.`,
      };
    }
  }

  // The allow-list resolved the binary and the OS could not find it.
  if (step.error === 'BINARY_NOT_FOUND') {
    return {
      kind: 'environment',
      subject: `binary:${binary}`,
      text: `\`${binary}\` is not installed on this machine. Nothing that needs it will run here.`,
    };
  }

  // The program is missing and said so itself. Checked only when the failing command's
  // own binary is named in the message, so a compiler that cannot find a *header* is
  // not recorded as the compiler being absent.
  if (binary && NOT_FOUND_PATTERNS.some((pattern) => pattern.test(output)) && output.toLowerCase().includes(binary)) {
    return {
      kind: 'environment',
      subject: `binary:${binary}`,
      text: `\`${binary}\` is not installed on this machine. Nothing that needs it will run here.`,
    };
  }

  return null;
}

/**
 * @typedef {object} Fact
 * @property {string} kind
 * @property {string} text
 * @property {string} [subject]  What it is about; a newer fact replaces an older one.
 * @property {string} ts
 */

class FactStore {
  /**
   * @param {string} workspaceRoot
   */
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.filePath = path.join(workspaceRoot, '.hirayacoder', 'facts.jsonl');
    /** @type {Fact[]} */
    this.facts = [];
    /** @type {Promise<void>} */
    this._queue = Promise.resolve();
    this._loaded = false;
  }

  /**
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<Fact[]>}
   */
  async load(opts = {}) {
    if (this._loaded && !opts.force) return this.facts;

    let raw = '';
    try {
      const stats = await fs.promises.stat(this.filePath);
      if (stats.size > MAX_FILE_BYTES) {
        logger.warn(`Fact file is ${stats.size} bytes (limit ${MAX_FILE_BYTES}); ignoring it.`);
        this._loaded = true;
        return this.facts;
      }
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        logger.warn(`Could not read facts: ${/** @type {Error} */ (err).message}`);
      }
      this._loaded = true;
      return this.facts;
    }

    /** @type {Fact[]} */
    const parsed = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      if (parsed.length >= MAX_FACTS) break;

      /** @type {any} */
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // One bad line does not invalidate the rest of the file.
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      if (!KINDS.has(entry.kind)) continue;

      const text = neutralize(entry.text);
      if (!text) continue;

      parsed.push({
        kind: entry.kind,
        text,
        subject: typeof entry.subject === 'string' ? neutralize(entry.subject) : undefined,
        ts: typeof entry.ts === 'string' ? entry.ts : '',
      });
    }

    this.facts = parsed;
    this._loaded = true;
    return this.facts;
  }

  /**
   * Store one fact.
   *
   * @param {{kind: string, text: string, subject?: string}} fact
   * @returns {Promise<boolean>} False when it was rejected or already known.
   */
  async record(fact) {
    if (!fact || !KINDS.has(fact.kind)) return false;
    const text = neutralize(fact.text);
    if (!text) return false;

    await this.load();

    // A fact about the same subject supersedes the older one outright — "javac is
    // missing" recorded twice is one fact, and if the user installs a JDK the newer
    // observation should be the one that survives.
    const subject = fact.subject ? neutralize(fact.subject) : undefined;
    const before = this.facts.length;
    if (subject) {
      this.facts = this.facts.filter((existing) => existing.subject !== subject);
    }

    // Without a subject, fall back to the same near-match test session notes use: a
    // model-free detector will not vary its wording, but a hand-edited file might.
    if (!subject && this.facts.some((existing) => similarity(existing.text, text) >= DUPLICATE_THRESHOLD)) {
      return false;
    }

    const superseded = before - this.facts.length;
    /** @type {Fact} */
    const entry = { kind: fact.kind, text, subject, ts: new Date().toISOString() };
    this.facts.push(entry);
    if (this.facts.length > MAX_FACTS) this.facts.shift();

    // Superseding removed a line from the middle, so the file is rewritten to match.
    // A plain append stays a single cheap write, which is the common case.
    const rewrite = superseded > 0 || this.facts.length === MAX_FACTS;
    const snapshot = rewrite ? [...this.facts] : null;

    this._queue = this._queue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        if (snapshot) {
          await fs.promises.writeFile(this.filePath, `${snapshot.map((f) => JSON.stringify(f)).join('\n')}\n`, 'utf8');
        } else {
          await fs.promises.appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
        }
      })
      .catch((err) => {
        // Facts are an optimization, never a hard dependency of a turn.
        logger.warn(`Could not persist a fact: ${/** @type {Error} */ (err).message}`);
      });

    if (superseded > 0) logger.debug(`Fact about "${subject}" replaced ${superseded} older one(s).`);
    logger.info(`Learned: ${text}`);
    return true;
  }

  /**
   * Record whatever a set of executed steps established. Steps that establish nothing
   * — the overwhelming majority — cost one regex sweep each.
   *
   * @param {Array<{action: string, command?: string, ok: boolean, error?: string, observation?: string}>} steps
   * @returns {Promise<number>} How many facts were stored.
   */
  async learnFrom(steps) {
    let stored = 0;
    for (const step of steps || []) {
      const fact = observe(step);
      if (fact && (await this.record(fact))) stored += 1;
    }
    return stored;
  }

  /**
   * The block that goes into a prompt, grouped by kind.
   *
   * Empty when there is nothing to say — a heading over no facts spends budget to tell
   * the model that nothing is known, which it would otherwise have assumed.
   *
   * @param {number} [limit]
   * @returns {Promise<string>}
   */
  async renderForPrompt(limit = DEFAULT_RECALL) {
    await this.load();
    if (this.facts.length === 0) return '';

    const recalled = this.facts.slice(-Math.max(1, limit));

    /** @type {string[]} */
    const lines = [];
    for (const kind of KIND_ORDER) {
      for (const fact of recalled) {
        if (fact.kind !== kind) continue;
        // Neutralized again on the way out: the cache can outlive an edit to the file.
        lines.push(`- [${KIND_LABEL[kind]}] ${neutralize(fact.text)}`);
      }
    }

    return lines.join('\n');
  }

  /** Forget everything about this workspace. */
  async clear() {
    this.facts = [];
    this._loaded = true;
    await this.flush();
    try {
      await fs.promises.unlink(this.filePath);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        logger.warn(`Could not clear facts: ${/** @type {Error} */ (err).message}`);
      }
    }
  }

  /** Resolves once every queued write has landed. */
  flush() {
    return this._queue;
  }
}

module.exports = {
  FactStore,
  observe,
  binaryOf,
  KINDS,
  KIND_ORDER,
  KIND_LABEL,
  MAX_FACTS,
  MAX_FILE_BYTES,
  DEFAULT_RECALL,
};
