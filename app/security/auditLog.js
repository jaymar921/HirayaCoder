'use strict';

/**
 * Append-only local record of every agent-initiated action.
 *
 * One JSON object per line at `.hirayacoder/audit.log`. Never transmitted anywhere —
 * it exists so the user can answer "what did this thing actually do?" after the
 * fact, including in auto modes where nothing prompted them at the time.
 *
 * The file plumbing — serialized appends, rotation, tolerant reads, and the rule that
 * a logging failure never fails the action being logged — lives in `utils/jsonlLog`
 * and is shared with `core/outcomeLedger`. What stays here is the part that is
 * specific to an audit record:
 *
 *  - **Redacted.** Entries pass through `secretsScanner` before hitting disk. A
 *    command like `npm config set _authToken=…` would otherwise persist a live
 *    credential in plain text.
 *  - **Append-only.** Deliberately no `clear()`. The ledger next door has one because
 *    a learned profile must be discardable; a record of what was done to the user's
 *    files must not be erasable from inside the extension.
 *
 * @module security/auditLog
 */

const path = require('path');

const { JsonlLog, MAX_LOG_BYTES, MAX_FIELD_CHARS } = require('../utils/jsonlLog');
const { redact } = require('./secretsScanner');

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

class AuditLog extends JsonlLog {
  /**
   * @param {string} workspaceRoot
   * @param {object} [opts]
   * @param {string} [opts.fileName] Default '.hirayacoder/audit.log'.
   * @param {number} [opts.maxBytes]
   */
  constructor(workspaceRoot, opts = {}) {
    super(path.join(workspaceRoot, opts.fileName || path.join('.hirayacoder', 'audit.log')), {
      maxBytes: opts.maxBytes,
      label: 'audit log',
    });
    this.root = workspaceRoot;
  }

  /**
   * Normalize, redact, and bound an entry before serialization.
   *
   * @param {AuditEntry} entry
   * @returns {object}
   * @protected
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
}

module.exports = { AuditLog, MAX_LOG_BYTES, MAX_FIELD_CHARS };
