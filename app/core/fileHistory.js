'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Every fs call targets `this.filePath`, built from the VS Code workspace root and a
 * fixed filename. No component derives from model output. */

/**
 * What the agent changed, and what it changed it from: `.hirayacoder/history.jsonl`.
 *
 * ## The gap this fills
 *
 * A `ChangeSet` holds the before and after of every write, and holds them for exactly
 * as long as the turn lasts. The review UI renders a diff from it and then it is gone.
 * Session memory keeps a sentence — "Edited src/todo_manager.py: added priority
 * handling" — which says a file was touched and nothing about what happened to it.
 *
 * So two questions had no answer anywhere. The user's: *what did it change, and what
 * was there before?* And the agent's own, which is the more expensive one: asked to
 * modify a file it edited three turns ago, it has no idea what it did, and so re-does
 * or undoes it. Observed repeatedly — a model that had correctly wired `TodoApp` to
 * `TodoManager` rewrote it later without the wiring, because nothing in its context
 * said the wiring was its own work.
 *
 * ## Diffs, not snapshots
 *
 * Storing both versions of every file would duplicate the workspace on every write, and
 * in a git repository it would duplicate git. What is stored is a **unified diff**,
 * bounded, plus the line counts — enough to answer "what changed" and to reconstruct a
 * small edit, without becoming a second copy of the project.
 *
 * The trade is deliberate and worth stating: a large rewrite is recorded as a truncated
 * diff and cannot be reversed from this file. Git is the tool for that, and this one is
 * for seeing what happened without leaving the editor.
 *
 * ## This file holds workspace content
 *
 * Unlike `outcomes.jsonl`, which holds counts and enums precisely so it can never leak
 * a project, this one holds fragments of the user's code by design — that is the whole
 * feature. Two consequences, both enforced here: every diff is passed through the
 * secrets scanner on the way in, and the file is capped so a long session cannot grow
 * it without bound.
 *
 * @module core/fileHistory
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
const { JsonlLog } = require('../utils/jsonlLog');
const { redact } = require('../security/secretsScanner');
const { toLf } = require('../utils/platform');

/**
 * Larger than the outcome ledger's cap, because entries here carry code. Still small
 * enough that the file stays greppable and cheap to rotate.
 */
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

/** Lines of diff kept per entry. Past this, the edit is summarised rather than stored. */
const MAX_DIFF_LINES = 120;

/** Characters per diff line, so one minified bundle cannot fill an entry by itself. */
const MAX_DIFF_LINE_CHARS = 300;

/** Entries fed back to the model, newest first. */
const DEFAULT_RECALL = 6;

/**
 * How many lines a file has, not counting the newline that ends the last one.
 *
 * `'a\nb\n'.split('\n')` is three elements, the last of them empty, so a naive count
 * reports a two-line file as three. That is tolerable inside a diff, where the number
 * describes a region, and wrong in a record a user reads: "deleted old.js (3 lines)"
 * for a two-line file is a small lie in a file whose whole job is being accurate about
 * what happened.
 *
 * @param {string | null} text
 * @returns {number}
 */
function countLines(text) {
  if (text === null || text === '') return 0;
  return toLf(text).replace(/\n$/, '').split('\n').length;
}

/**
 * A unified-ish diff of two versions of a file.
 *
 * Not a real diff algorithm — no Myers, no move detection. It trims the common head and
 * tail, which is what `writeFile.summarizeChange` already does to count lines, and
 * renders what is left. For the edits a coding agent makes, one contiguous changed
 * region is the overwhelmingly common shape, and a proper diff would cost a dependency
 * or a few hundred lines to be prettier about the rest.
 *
 * Being approximate is safe here because nothing depends on it: the diff is read by a
 * human and used as context by a model, and neither is applying it as a patch.
 *
 * @param {string | null} before Null for a newly created file.
 * @param {string} after
 * @returns {{diff: string, added: number, removed: number, truncated: boolean}}
 */
function renderDiff(before, after) {
  const beforeLines = before === null ? [] : toLf(before).split('\n');
  const afterLines = toLf(after).split('\n');

  let head = 0;
  // Numeric indices into arrays, as in `writeFile.summarizeChange`.
  /* eslint-disable security/detect-object-injection */
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1;
  }
  /* eslint-enable security/detect-object-injection */

  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const removedLines = beforeLines.slice(head, beforeLines.length - tail);
  const addedLines = afterLines.slice(head, afterLines.length - tail);

  const clip = (line) =>
    line.length > MAX_DIFF_LINE_CHARS ? `${line.slice(0, MAX_DIFF_LINE_CHARS)}…` : line;

  /** @type {string[]} */
  const lines = [`@@ line ${head + 1} @@`];
  let truncated = false;

  for (const line of removedLines) {
    if (lines.length > MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    lines.push(`- ${clip(line)}`);
  }
  for (const line of addedLines) {
    if (lines.length > MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    lines.push(`+ ${clip(line)}`);
  }
  if (truncated) lines.push(`… (${removedLines.length + addedLines.length} changed lines in total)`);

  return {
    diff: lines.join('\n'),
    added: addedLines.length,
    removed: removedLines.length,
    truncated,
  };
}

class FileHistory extends JsonlLog {
  /**
   * @param {string} workspaceRoot
   * @param {object} [opts]
   * @param {string} [opts.fileName]
   * @param {number} [opts.maxBytes]
   */
  constructor(workspaceRoot, opts = {}) {
    super(path.join(workspaceRoot, opts.fileName || path.join('.hirayacoder', 'history.jsonl')), {
      maxBytes: opts.maxBytes || MAX_HISTORY_BYTES,
      label: 'file history',
    });
    this.root = workspaceRoot;
  }

  /**
   * Record one change to one file.
   *
   * @param {{path: string, kind: 'create' | 'edit' | 'delete', before: string | null, after: string | null, sessionId?: string, model?: string}} change
   * @returns {Promise<void>}
   */
  record(change) {
    const isDelete = change.kind === 'delete';
    const rendered = isDelete
      ? { diff: '', added: 0, removed: countLines(change.before), truncated: false }
      : renderDiff(change.before, String(change.after == null ? '' : change.after));

    return this.append({
      path: change.path,
      kind: change.kind,
      sessionId: change.sessionId,
      model: change.model,
      added: rendered.added,
      removed: rendered.removed,
      truncated: rendered.truncated,
      diff: rendered.diff,
    });
  }

  /**
   * Record everything one turn changed.
   *
   * @param {Array<{path: string, kind: string, before: string | null, after: string | null}>} changes
   * @param {{sessionId?: string, model?: string}} [context]
   * @returns {Promise<void>}
   */
  async recordAll(changes, context = {}) {
    for (const change of changes || []) {
      try {
        await this.record({ ...change, ...context });
      } catch (err) {
        // History is a record, never a dependency. A failure to write it must not
        // affect a change that has already landed on disk.
        logger.warn(`Could not record a file change: ${/** @type {Error} */ (err).message}`);
      }
    }
  }

  /**
   * Bound every field and redact the one that carries code.
   *
   * @param {object} entry
   * @returns {object}
   * @protected
   */
  _sanitize(entry) {
    const text = (value, max) =>
      typeof value === 'string' && value !== '' ? this._bound(value, max) : undefined;
    const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined);

    const safe = {
      ts: new Date().toISOString(),
      path: text(entry.path, 400),
      kind: text(entry.kind, 20),
      sessionId: text(entry.sessionId, 20),
      model: text(entry.model, 120),
      added: count(entry.added),
      removed: count(entry.removed),
      truncated: entry.truncated === true ? true : undefined,
      // The one field that carries the user's code, and the reason this file is capped
      // and scanned while `outcomes.jsonl` needs neither.
      diff: text(entry.diff ? redact(entry.diff) : '', MAX_DIFF_LINES * MAX_DIFF_LINE_CHARS),
    };

    return Object.fromEntries(Object.entries(safe).filter(([, value]) => value !== undefined));
  }

  /**
   * The most recent changes, newest first.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {string} [opts.sessionId] Only this session's changes.
   * @returns {Promise<object[]>}
   */
  async recent(opts = {}) {
    const limit = opts.limit || DEFAULT_RECALL;
    try {
      const all = await this.read(500);
      const filtered = opts.sessionId ? all.filter((e) => e.sessionId === opts.sessionId) : all;
      return filtered.slice(-limit).reverse();
    } catch (err) {
      logger.warn(`Could not read the file history: ${/** @type {Error} */ (err).message}`);
      return [];
    }
  }

  /**
   * What this session has already changed, as a prompt block.
   *
   * Paths and line counts only — the diffs stay on disk. The model needs to know *that*
   * it already edited a file and roughly how much, so it stops re-doing and undoing its
   * own work; handing it back the full diffs would spend a Tier B budget re-reading
   * changes it could simply read the file for.
   *
   * @param {string} sessionId
   * @param {number} [limit]
   * @returns {Promise<string>}
   */
  async renderForPrompt(sessionId, limit = DEFAULT_RECALL) {
    const entries = await this.recent({ sessionId, limit });
    if (entries.length === 0) return '';

    const lines = entries.map((entry) => {
      if (entry.kind === 'delete') return `- deleted ${entry.path}`;
      if (entry.kind === 'create') return `- created ${entry.path} (${entry.added} lines)`;
      return `- edited ${entry.path} (+${entry.added} / -${entry.removed})`;
    });

    return `Files you have already changed in this session — do not redo this work:\n${lines.join('\n')}`;
  }

  /** Forget the history for this workspace. */
  async clear() {
    await this.flush();
    for (const file of [this.filePath, `${this.filePath}.1`]) {
      try {
        await fs.promises.unlink(file);
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
          logger.warn(`Could not clear the file history: ${/** @type {Error} */ (err).message}`);
        }
      }
    }
  }
}

module.exports = {
  FileHistory,
  renderDiff,
  countLines,
  MAX_HISTORY_BYTES,
  MAX_DIFF_LINES,
  MAX_DIFF_LINE_CHARS,
  DEFAULT_RECALL,
};
