'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Attached file paths are validated by pathGuard before any read, and the index
 * file path is derived from the workspace root plus a fixed name. */

/**
 * Tracks the reference files a user attaches with the `+` button.
 *
 * These are *directional* context — a spec to follow, a module to match the style
 * of — as distinct from the files the agent reads and edits on its own. The agent
 * never writes to them; they are read once, redacted, trimmed, and included in
 * every prompt for the session.
 *
 * Only references are persisted (`.hirayacoder/context-files/index.json`), plus a
 * bounded excerpt. Copying whole files would duplicate the user's workspace into a
 * hidden folder, which is both wasteful and a second place for secrets to live.
 * The excerpt exists so a prompt can be assembled without re-reading from disk on
 * every turn, and it is re-validated against mtime so an edited file isn't served
 * stale.
 *
 * @module core/contextFilesManager
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
const pathGuard = require('../security/pathGuard');
const { scan } = require('../security/secretsScanner');
const { estimateTokens, truncateToTokens } = require('../utils/tokenBudget');

/** Files past this size are excerpted rather than included whole. */
const MAX_EXCERPT_TOKENS = 1500;

/** A hard byte cap so a giant file can't be read into memory at all. */
const MAX_READ_BYTES = 2 * 1024 * 1024;

/** More than this and the prompt is all reference and no task. */
const MAX_ATTACHED_FILES = 10;

/**
 * @typedef {object} ContextFile
 * @property {string} relativePath   Workspace-relative, forward slashes.
 * @property {string} excerpt        Redacted, possibly truncated content.
 * @property {number} bytes
 * @property {number} tokens
 * @property {boolean} truncated
 * @property {number} mtimeMs        Used to detect an edit and re-read.
 * @property {number} secretsRedacted
 */

class ContextFilesManager {
  /**
   * @param {string} workspaceRoot
   * @param {object} [opts]
   * @param {number} [opts.maxExcerptTokens]
   */
  constructor(workspaceRoot, opts = {}) {
    this.workspaceRoot = workspaceRoot;
    this.maxExcerptTokens = opts.maxExcerptTokens || MAX_EXCERPT_TOKENS;
    this.indexPath = path.join(workspaceRoot, '.hirayacoder', 'context-files', 'index.json');
    /** @type {Map<string, ContextFile>} Keyed by relative path. */
    this.files = new Map();
  }

  /**
   * Attach a file.
   *
   * @param {string} candidatePath Absolute or workspace-relative.
   * @returns {Promise<{ok: true, file: ContextFile} | {ok: false, error: string, code: string}>}
   */
  async add(candidatePath) {
    if (this.files.size >= MAX_ATTACHED_FILES) {
      return {
        ok: false,
        code: 'TOO_MANY_FILES',
        error: `You can attach at most ${MAX_ATTACHED_FILES} context files. Remove one first.`,
      };
    }

    /** @type {import('../security/pathGuard').ResolvedPath} */
    let resolved;
    try {
      // Context files are read-only, so the plain guard applies — a user may
      // legitimately want to attach something inside .git or .hirayacoder.
      resolved = pathGuard.resolvePath(this.workspaceRoot, candidatePath);
      await pathGuard.assertRealPath(resolved);
    } catch (err) {
      const error = /** @type {Error & {code?: string}} */ (err);
      return { ok: false, code: error.code || 'BLOCKED', error: error.message };
    }

    /** @type {fs.Stats} */
    let stats;
    try {
      stats = await fs.promises.stat(resolved.absolute);
    } catch (err) {
      return { ok: false, code: 'NOT_FOUND', error: `Could not read "${resolved.relative}".` };
    }

    if (stats.isDirectory()) {
      return { ok: false, code: 'IS_DIRECTORY', error: `"${resolved.relative}" is a folder. Attach individual files.` };
    }
    if (stats.size > MAX_READ_BYTES) {
      return {
        ok: false,
        code: 'TOO_LARGE',
        error: `"${resolved.relative}" is ${Math.round(stats.size / 1024)}KB — too large to attach as context.`,
      };
    }

    let raw;
    try {
      raw = await fs.promises.readFile(resolved.absolute, 'utf8');
    } catch (err) {
      return { ok: false, code: 'READ_FAILED', error: `Could not read "${resolved.relative}".` };
    }

    if (raw.includes('\0')) {
      return { ok: false, code: 'BINARY', error: `"${resolved.relative}" looks like a binary file.` };
    }

    const file = this._buildEntry(resolved.relative, raw, stats);
    this.files.set(file.relativePath, file);
    await this.persist();

    logger.info(
      `Attached context file ${file.relativePath} (~${file.tokens} tokens` +
        `${file.truncated ? ', truncated' : ''}${file.secretsRedacted > 0 ? `, ${file.secretsRedacted} secret(s) redacted` : ''}).`
    );
    return { ok: true, file };
  }

  /**
   * @param {string} relativePath
   * @param {string} raw
   * @param {fs.Stats} stats
   * @returns {ContextFile}
   * @private
   */
  _buildEntry(relativePath, raw, stats) {
    // Redact before truncating, so a secret can't survive by sitting past the cut
    // and then reappearing when the budget changes.
    const scanned = scan(raw);
    const trimmed = truncateToTokens(scanned.redacted, this.maxExcerptTokens, { keep: 'both' });

    return {
      relativePath,
      excerpt: trimmed.text,
      bytes: stats.size,
      tokens: estimateTokens(trimmed.text),
      truncated: trimmed.truncated,
      mtimeMs: stats.mtimeMs,
      secretsRedacted: scanned.findings.length,
    };
  }

  /**
   * Detach a file.
   *
   * @param {string} relativePath
   * @returns {Promise<boolean>}
   */
  async remove(relativePath) {
    const key = String(relativePath).split(path.sep).join('/');
    const existed = this.files.delete(key);
    if (existed) await this.persist();
    return existed;
  }

  /** @returns {ContextFile[]} */
  list() {
    return [...this.files.values()];
  }

  /** @returns {Promise<void>} */
  async clear() {
    this.files.clear();
    await this.persist();
  }

  /**
   * Re-read any attached file whose mtime changed since it was attached.
   *
   * Without this, editing a file you attached ten minutes ago would leave the
   * agent reasoning about the old version with no indication anything was stale.
   *
   * @returns {Promise<string[]>} Paths that were refreshed.
   */
  async refresh() {
    /** @type {string[]} */
    const refreshed = [];
    for (const [key, file] of this.files) {
      const absolute = path.join(this.workspaceRoot, ...key.split('/'));
      try {
        const stats = await fs.promises.stat(absolute);
        if (stats.mtimeMs === file.mtimeMs) continue;
        const raw = await fs.promises.readFile(absolute, 'utf8');
        this.files.set(key, this._buildEntry(key, raw, stats));
        refreshed.push(key);
      } catch {
        // Deleted or unreadable: drop it rather than serving a phantom.
        this.files.delete(key);
        refreshed.push(key);
        logger.warn(`Context file ${key} is no longer readable; detached.`);
      }
    }
    if (refreshed.length > 0) await this.persist();
    return refreshed;
  }

  /**
   * Render the attached files as a prompt block.
   *
   * @returns {string} Empty when nothing is attached.
   */
  renderForPrompt() {
    if (this.files.size === 0) return '';
    return this.list()
      .map((file) => {
        const note = file.truncated ? ' (excerpt)' : '';
        return `--- ${file.relativePath}${note} ---\n${file.excerpt}`;
      })
      .join('\n\n');
  }

  /** @returns {number} */
  totalTokens() {
    return this.list().reduce((sum, file) => sum + file.tokens, 0);
  }

  /**
   * Write the reference index. Excerpts are included so a reopened session doesn't
   * have to re-read every attachment before its first prompt.
   *
   * @returns {Promise<void>}
   */
  async persist() {
    try {
      await fs.promises.mkdir(path.dirname(this.indexPath), { recursive: true });
      await fs.promises.writeFile(this.indexPath, JSON.stringify({ version: 1, files: this.list() }, null, 2), 'utf8');
    } catch (err) {
      logger.warn(`Could not save context file index: ${/** @type {Error} */ (err).message}`);
    }
  }

  /**
   * Restore attachments from a previous session. Treated as untrusted input: a
   * malformed index is discarded rather than trusted into a prompt.
   *
   * @returns {Promise<void>}
   */
  async load() {
    let raw;
    try {
      raw = await fs.promises.readFile(this.indexPath, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        logger.warn(`Could not read context file index: ${/** @type {Error} */ (err).message}`);
      }
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.files)) return;
      for (const entry of parsed.files.slice(0, MAX_ATTACHED_FILES)) {
        if (!entry || typeof entry.relativePath !== 'string' || typeof entry.excerpt !== 'string') continue;
        this.files.set(entry.relativePath, {
          relativePath: entry.relativePath,
          excerpt: entry.excerpt,
          bytes: Number(entry.bytes) || 0,
          tokens: Number(entry.tokens) || estimateTokens(entry.excerpt),
          truncated: Boolean(entry.truncated),
          mtimeMs: Number(entry.mtimeMs) || 0,
          secretsRedacted: Number(entry.secretsRedacted) || 0,
        });
      }
      // mtimes are re-checked immediately, so a stale excerpt never reaches a prompt.
      await this.refresh();
    } catch {
      logger.warn('Context file index is malformed; ignoring it.');
    }
  }
}

module.exports = {
  ContextFilesManager,
  MAX_EXCERPT_TOKENS,
  MAX_ATTACHED_FILES,
  MAX_READ_BYTES,
};
