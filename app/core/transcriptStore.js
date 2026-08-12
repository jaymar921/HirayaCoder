'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * The path is built from the workspace root and a numeric session id, never from
 * model output or a webview message. */

/**
 * The visible conversation for a session, kept across tab closes.
 *
 * ## Why this is separate from `memoryStore`
 *
 * They look similar and answer different questions. Memory is what the *agent* recalls:
 * composed notes, redacted, injection-neutralised, deliberately lossy, and fed back
 * into the model's context. This is what the *user* sees: the messages as they were
 * written, in order, and never sent to the model at all.
 *
 * Keeping the transcript out of the model's context is what makes it safe to store
 * verbatim. It is display state, so it cannot influence a later turn, and restoring it
 * changes what a reopened tab looks like rather than how the agent behaves.
 *
 * ## The file is not trusted
 *
 * It lives under `.hirayacoder/`, which a user or another process can edit, so it is
 * validated on the way in exactly as `memoryStore` validates its own: shape-checked,
 * role-checked, and bounded. A corrupted or oversized file yields an empty transcript
 * rather than an error or a blown-up webview — losing scrollback is a nuisance, and
 * failing to open the tab at all is not.
 *
 * @module core/transcriptStore
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');

/** Roles the webview knows how to render. Anything else is dropped. */
const ROLES = new Set(['user', 'assistant']);

/**
 * Entries kept per session. A long session is worth scrolling; an unbounded one costs
 * memory on every tab open and buys nothing a user would read.
 */
const MAX_ENTRIES = 200;

/** Per-message ceiling. A pasted file is plausible; a megabyte of it is not. */
const MAX_TEXT_CHARS = 20000;

/** Refuse to parse a file larger than this rather than loading it to find out. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

class TranscriptStore {
  /**
   * @param {string} workspaceRoot
   * @param {number | string} sessionId
   */
  constructor(workspaceRoot, sessionId) {
    this.workspaceRoot = workspaceRoot;
    this.sessionId = sessionId;
    this.filePath = path.join(workspaceRoot, '.hirayacoder', 'transcripts', `session${sessionId}.json`);

    /** @type {Array<{role: string, text: string}>} */
    this.entries = [];
    this.loaded = false;

    // Writes are serialized through one chain, so two quick turns cannot interleave
    // into a half-written file. Same discipline as `memoryStore` and `auditLog`.
    this._queue = Promise.resolve();
  }

  /**
   * Read the stored transcript. Safe to call repeatedly; only the first read hits disk.
   *
   * @returns {Promise<Array<{role: string, text: string}>>}
   */
  async load() {
    if (this.loaded) return this.entries;
    this.loaded = true;

    try {
      const stat = await fs.promises.stat(this.filePath);
      if (stat.size > MAX_FILE_BYTES) {
        logger.warn(`Transcript for session ${this.sessionId} is ${stat.size} bytes; ignoring it.`);
        return this.entries;
      }

      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      this.entries = sanitize(JSON.parse(raw));
    } catch (err) {
      // A missing file is the normal case for a new session.
      if (err && err.code !== 'ENOENT') {
        logger.warn(`Could not read the transcript for session ${this.sessionId}: ${err.message}`);
      }
    }

    return this.entries;
  }

  /**
   * Record one message and persist.
   *
   * @param {string} role
   * @param {string} text
   */
  append(role, text) {
    if (!ROLES.has(role)) return;
    const trimmed = String(text == null ? '' : text).slice(0, MAX_TEXT_CHARS);
    if (!trimmed) return;

    this.entries.push({ role, text: trimmed });
    // Oldest first: the recent exchange is the part worth keeping.
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }

    this._write();
  }

  /** Forget this session's conversation. */
  async clear() {
    this.entries = [];
    this.loaded = true;
    this._queue = this._queue.then(async () => {
      try {
        await fs.promises.unlink(this.filePath);
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          logger.warn(`Could not clear the transcript for session ${this.sessionId}: ${err.message}`);
        }
      }
    });
    return this._queue;
  }

  /** Wait for pending writes — for tests and for shutdown. */
  flush() {
    return this._queue;
  }

  /** @private */
  _write() {
    const snapshot = this.entries.slice();
    this._queue = this._queue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.promises.writeFile(this.filePath, JSON.stringify(snapshot), 'utf8');
      })
      .catch((err) => {
        // Losing scrollback must never take the session down with it.
        logger.warn(`Could not save the transcript for session ${this.sessionId}: ${err.message}`);
      });
  }
}

/**
 * Keep only what the webview can render, from a file that may have been edited.
 *
 * @param {unknown} parsed
 * @returns {Array<{role: string, text: string}>}
 */
function sanitize(parsed) {
  if (!Array.isArray(parsed)) return [];

  const entries = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role;
    const text = item.text;
    if (!ROLES.has(role) || typeof text !== 'string' || !text) continue;
    entries.push({ role, text: text.slice(0, MAX_TEXT_CHARS) });
  }

  return entries.slice(-MAX_ENTRIES);
}

module.exports = { TranscriptStore, sanitize, MAX_ENTRIES, MAX_TEXT_CHARS };
