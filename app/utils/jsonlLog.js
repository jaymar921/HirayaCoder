'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Every fs call in this module targets `this.filePath`, which each subclass builds
 * from the VS Code workspace root and a fixed filename. No part of it derives from
 * model output or from a tool argument. */

/**
 * The append-only JSONL discipline, shared by the two local records HirayaCoder keeps.
 *
 * `security/auditLog` (what the agent did) and `core/outcomeLedger` (how it went) are
 * different files with different contents and different audiences, but they need the
 * same four properties, and getting any of them subtly wrong in a second copy is how
 * a record stops being trustworthy:
 *
 *  - **Serialized.** Appends run through a promise chain, so concurrent callers can't
 *    interleave partial lines and corrupt the JSONL.
 *  - **Bounded.** Fields are truncated and the file is rotated, so a runaway session
 *    cannot fill a disk.
 *  - **Non-fatal.** A write failure never propagates to the work being recorded; it
 *    degrades to a warning.
 *  - **Tolerant on read.** The file is user-editable, so it is treated as untrusted
 *    input: a corrupt line is skipped, never thrown.
 *
 * Subclasses supply `_sanitize`, which is the only thing that differs — what a record
 * is allowed to contain.
 *
 * @module utils/jsonlLog
 */

const fs = require('fs');
const path = require('path');

const logger = require('./logger');

/** Rotate once the file passes this size, keeping one previous generation. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Values longer than this are truncated — these files are records, not backups. */
const MAX_FIELD_CHARS = 2000;

class JsonlLog {
  /**
   * @param {string} filePath   Absolute path to the .jsonl / .log file.
   * @param {object} [opts]
   * @param {number} [opts.maxBytes]
   * @param {string} [opts.label] Used in warnings, e.g. 'audit log'.
   */
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.maxBytes = opts.maxBytes || MAX_LOG_BYTES;
    this.label = opts.label || 'log';
    /** @type {Promise<void>} Tail of the serialized write chain. */
    this._queue = Promise.resolve();
    this._enabled = true;
  }

  /**
   * Record one entry. Resolves once the line is durably queued; callers may await
   * it, but nothing depends on it succeeding.
   *
   * @param {object} entry
   * @returns {Promise<void>}
   */
  append(entry) {
    if (!this._enabled) return Promise.resolve();

    const line = JSON.stringify(this._sanitize(entry));
    this._queue = this._queue
      .then(() => this._write(line))
      .catch((err) => {
        // Never let a logging failure take down the action it was describing.
        logger.warn(`Could not write to the HirayaCoder ${this.label}: ${/** @type {Error} */ (err).message}`);
      });
    return this._queue;
  }

  /**
   * Normalize and bound an entry before serialization. Subclasses decide what a
   * record may contain; the base class stores it as given.
   *
   * @param {object} entry
   * @returns {object}
   * @protected
   */
  _sanitize(entry) {
    return entry;
  }

  /**
   * @param {string} value
   * @param {number} [maxChars]
   * @returns {string}
   * @protected
   */
  _bound(value, maxChars = MAX_FIELD_CHARS) {
    const text = String(value);
    return text.length > maxChars ? `${text.slice(0, maxChars)}…[truncated]` : text;
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
      logger.info(`Rotated the HirayaCoder ${this.label}.`);
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

module.exports = { JsonlLog, MAX_LOG_BYTES, MAX_FIELD_CHARS };
