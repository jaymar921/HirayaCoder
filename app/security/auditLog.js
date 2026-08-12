'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Every fs call in this module targets `this.filePath`, which is the VS Code
 * workspace root joined with a fixed filename. No part of it derives from model
 * output or from a tool argument. */

/**
 * Append-only local record of every agent-initiated action.
 *
 * One JSON object per line at `.hirayacoder/audit.log`. Never transmitted anywhere —
 * it exists so the user can answer "what did this thing actually do?" after the
 * fact, including in auto modes where nothing prompted them at the time.
 *
 * Three properties the implementation guarantees:
 *
 *  - **Serialized.** Appends run through a promise chain, so concurrent tool calls
 *    can't interleave partial lines and corrupt the JSONL.
 *  - **Redacted.** Entries pass through `secretsScanner` before hitting disk. A
 *    command like `npm config set _authToken=…` would otherwise persist a live
 *    credential in plain text.
 *  - **Non-fatal.** A logging failure never blocks or fails the action being
 *    logged; it degrades to a warning.
 *
 * @module security/auditLog
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
const { redact } = require('./secretsScanner');

/** Rotate once the log passes this size, keeping one previous generation. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Values longer than this are truncated — the log is a record, not a backup. */
const MAX_FIELD_CHARS = 2000;

/**
 * @typedef {object} AuditEntry
 * @property {string} action        'write_file' | 'delete_file' | 'run_script' | …
 * @property {'approved' | 'denied' | 'auto-approved' | 'failed' | 'blocked'} decision
 * @property {string} [path]        Workspace-relative target.
 * @property {string} [command]     For script actions.
 * @property {string} [reason]      Why it was denied or blocked.
 * @property {string} [sessionId]
 * @property {string} [mode]        Agent / Plan / Ask.
 * @property {object} [permissions] Permission state at the time of the action.
 * @property {object} [detail]      Anything else worth recording.
 */

class AuditLog {
  /**
   * @param {string} workspaceRoot
   * @param {object} [opts]
   * @param {string} [opts.fileName] Default '.hirayacoder/audit.log'.
   * @param {number} [opts.maxBytes]
   */
  constructor(workspaceRoot, opts = {}) {
    this.root = workspaceRoot;
    this.filePath = path.join(workspaceRoot, opts.fileName || path.join('.hirayacoder', 'audit.log'));
    this.maxBytes = opts.maxBytes || MAX_LOG_BYTES;
    /** @type {Promise<void>} Tail of the serialized write chain. */
    this._queue = Promise.resolve();
    this._enabled = true;
  }

  /**
   * Record an action. Resolves once the line is durably queued; callers may await
   * it, but nothing depends on it succeeding.
   *
   * @param {AuditEntry} entry
   * @returns {Promise<void>}
   */
  append(entry) {
    if (!this._enabled) return Promise.resolve();

    const line = JSON.stringify(this._sanitize(entry));
    this._queue = this._queue
      .then(() => this._write(line))
      .catch((err) => {
        // Never let an audit failure take down the action it was describing.
        logger.warn(`Audit log write failed: ${/** @type {Error} */ (err).message}`);
      });
    return this._queue;
  }

  /**
   * Normalize, redact, and bound an entry before serialization.
   *
   * @param {AuditEntry} entry
   * @returns {object}
   * @private
   */
  _sanitize(entry) {
    const safe = {
      ts: new Date().toISOString(),
      action: String(entry.action || 'unknown'),
      decision: String(entry.decision || 'unknown'),
    };

    // An empty relative path is the *workspace root*, not a missing value — it is what
    // `list_files` and `search_workspace` resolve to when they operate on the whole
    // project. A plain truthiness test dropped the key entirely, so those actions were
    // recorded as `read_file` with no target at all: from a real session, ten of
    // fourteen entries could not say what had been read.
    //
    // An audit log exists to answer "what was touched". A record that omits the target
    // is worse than a noisy one, because it reads as complete.
    if (typeof entry.path === 'string') {
      safe.path = entry.path === '' ? '.' : this._bound(entry.path);
    } else if (entry.path) {
      safe.path = this._bound(String(entry.path));
    }
    // Commands and free-text reasons are the fields most likely to carry a token.
    if (entry.command) safe.command = this._bound(redact(entry.command));
    if (entry.reason) safe.reason = this._bound(redact(entry.reason));
    if (entry.sessionId) safe.sessionId = String(entry.sessionId);
    if (entry.mode) safe.mode = String(entry.mode);
    if (entry.permissions) safe.permissions = entry.permissions;

    if (entry.detail && typeof entry.detail === 'object') {
      try {
        safe.detail = JSON.parse(this._bound(redact(JSON.stringify(entry.detail))));
      } catch {
        // Truncation can invalidate the JSON; keep a marker rather than dropping it.
        safe.detail = { truncated: true };
      }
    }

    return safe;
  }

  /**
   * @param {string} value
   * @returns {string}
   * @private
   */
  _bound(value) {
    const text = String(value);
    return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…[truncated]` : text;
  }

  /**
   * @param {string} line
   * @returns {Promise<void>}
   * @private
   */
  async _write(line) {
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await this._rotateIfNeeded();
    await fs.promises.appendFile(this.filePath, `${line}\n`, 'utf8');
  }

  /**
   * @returns {Promise<void>}
   * @private
   */
  async _rotateIfNeeded() {
    try {
      const stats = await fs.promises.stat(this.filePath);
      if (stats.size < this.maxBytes) return;
      await fs.promises.rename(this.filePath, `${this.filePath}.1`);
      logger.info('Rotated the HirayaCoder audit log.');
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'ENOENT') throw err;
    }
  }

  /**
   * Read entries back, newest last. Malformed lines are skipped rather than
   * throwing — the file is treated as untrusted input, since a user or another
   * process may have edited it.
   *
   * @param {number} [limit]
   * @returns {Promise<object[]>}
   */
  async read(limit = 200) {
    let raw;
    try {
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
      throw err;
    }

    const entries = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        /* skip a corrupted line */
      }
    }
    return entries.slice(-limit);
  }

  /** Resolves once every queued write has landed. */
  flush() {
    return this._queue;
  }

  /** @param {boolean} enabled */
  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
  }
}

module.exports = { AuditLog, MAX_LOG_BYTES, MAX_FIELD_CHARS };
