'use strict';

/**
 * The single chokepoint every filesystem and execution action passes through.
 *
 * Any agent loop step — native tool call or ReAct JSON action — that wants to read,
 * write, delete, or execute goes through here, and nothing else in the codebase is
 * permitted to call `fs.writeFile`, `fs.unlink`, or `scriptRunner.run` directly.
 * That is what makes "was this approved, and under which mode?" answerable from one
 * file instead of reconstructed from seven tools.
 *
 * Order of checks, which matters:
 *
 *   1. **Mode** — in Plan/Ask, mutations are refused outright. The tool schemas are
 *      already withheld from the model in those modes (`promptRouter`), so reaching
 *      here means something went wrong; this is the backstop, not the mechanism.
 *   2. **Path guard / allow-list** — never bypassed, in any permission mode. Auto
 *      modes remove the confirmation click, not the safety checks.
 *   3. **Permission mode** — auto-apply, or ask the user.
 *   4. **Audit** — every outcome, including denials and blocks, in every mode.
 *
 * A refused action resolves to `{allowed: false}` rather than throwing: the agent
 * loop needs to feed the refusal back to the model as an observation so it can
 * adapt, not crash the session.
 *
 * @module security/permissionGate
 */

const logger = require('../utils/logger');
const pathGuard = require('./pathGuard');
const scriptRunner = require('./scriptRunner');

/**
 * @typedef {object} Decision
 * @property {boolean} allowed
 * @property {'approved' | 'auto-approved' | 'denied' | 'blocked'} decision
 * @property {string} [reason]         Why it was refused, phrased for the model.
 * @property {string} [code]           Machine-readable refusal code.
 * @property {import('./pathGuard').ResolvedPath} [resolved]
 * @property {import('./scriptRunner').ParsedCommand} [parsed]
 */

/**
 * @typedef {object} ConfirmRequest
 * @property {'write' | 'delete' | 'script' | 'read'} kind
 * @property {string} title
 * @property {string} detail
 * @property {'normal' | 'elevated'} risk  'elevated' for always-confirm commands.
 * @property {string} [path]
 * @property {string} [absolute]           Resolved path, for a UI that opens the file.
 * @property {string | null} [before]      Current file content; null for a new file.
 * @property {string} [after]              Proposed content. Present only for writes.
 * @property {string} [command]
 */

/**
 * @typedef {object} GateOptions
 * @property {string} workspaceRoot
 * @property {import('./permissionModes').PermissionModes} modes
 * @property {import('./auditLog').AuditLog} [auditLog]
 * @property {(request: ConfirmRequest) => Promise<boolean>} confirm
 * @property {string[]} [allowedBinaries]
 * @property {string[]} [protectedPrefixes]
 * @property {import('./ignoreRules').IgnoreRules} [ignoreRules]
 */

class PermissionGate {
  /**
   * @param {GateOptions} options
   */
  constructor(options) {
    this.workspaceRoot = options.workspaceRoot;
    this.modes = options.modes;
    this.auditLog = options.auditLog || null;
    this.confirm = options.confirm;
    this.allowedBinaries = options.allowedBinaries;
    this.protectedPrefixes = options.protectedPrefixes;
    /**
     * Which paths need asking about before a read. Optional: a gate constructed without
     * one auto-approves every confined read, which is the behaviour every caller had
     * before this existed.
     *
     * @type {import('./ignoreRules').IgnoreRules | null}
     */
    this.ignoreRules = options.ignoreRules || null;
    /**
     * Deletes ask even under Auto Edit, unless explicitly disabled.
     *
     * Auto Edit exists so routine writes don't need a click, and a wrong write is
     * visible in the diff and recoverable from the change set. A wrong delete is
     * neither, for a file the user had not yet committed.
     *
     * This is not theoretical. Given "update greet.js, note it in the README, and
     * delete the obsolete file", `llama3.2:1b` deleted `src/obsolete.js` correctly,
     * then deleted `src/greet.js` — the file it was asked to edit — while reporting
     * its thought as "Added a note to README.md". Small models misidentify delete
     * targets, and Auto Edit should not turn that into silent data loss.
     */
    this.alwaysConfirmDeletes = options.alwaysConfirmDeletes !== false;
  }

  /**
   * Reads need path confinement, and a confirmation click for anything the project has
   * marked as not-source.
   *
   * ## Why a read ever asks
   *
   * This used to auto-approve unconditionally, documented as "reads need path
   * confinement but never a confirmation click", on the reasoning that reading damages
   * nothing. It damages nothing in the workspace. It does move the file's contents into
   * a prompt, a session transcript on disk, and the context of every later turn — and
   * `api/.env` went through here twice, auto-approved, in a project whose `.gitignore`
   * begins `*.env`.
   *
   * So the confinement check is now joined by a sensitivity check. Ordinary source is
   * unaffected and still never prompts; a `.env`, a private key, or anything the
   * project's own `.gitignore` excludes is shown to the user first, and remembered for
   * the session once allowed.
   *
   * A gate with no `ignoreRules` configured behaves exactly as before, which is what
   * keeps every existing caller and test valid.
   *
   * @param {{path: string, sessionId?: string, mode?: string}} request
   * @returns {Promise<Decision>}
   */
  async requestRead(request) {
    /** @type {import('./pathGuard').ResolvedPath} */
    let resolved;
    try {
      resolved = pathGuard.resolvePath(this.workspaceRoot, request.path);
      await pathGuard.assertRealPath(resolved);
    } catch (err) {
      return this._blocked('read_file', request, err);
    }

    const verdict = this.ignoreRules ? this.ignoreRules.classify(resolved.relative) : { sensitive: false };

    if (!verdict.sensitive || this.ignoreRules.isGranted(resolved.relative)) {
      await this._audit({
        action: 'read_file',
        decision: 'auto-approved',
        path: resolved.relative,
        ...this._context(request),
      });
      return { allowed: true, decision: 'auto-approved', resolved };
    }

    const approved = await this.confirm({
      kind: 'read',
      title: `Read ${resolved.relative}?`,
      detail:
        verdict.because === 'always'
          ? `${resolved.relative} looks like it holds credentials. Reading it puts its contents into the model's context and this session's transcript.`
          : `${resolved.relative} is excluded by this project's .gitignore, so it is not source the agent would normally see. Reading it puts its contents into the model's context and this session's transcript.`,
      // Always elevated. A read that reaches this branch is a secret or a deliberate
      // exclusion, and neither should be a one-glance approval.
      risk: 'elevated',
      path: resolved.relative,
      absolute: resolved.absolute,
    });

    await this._audit({
      action: 'read_file',
      decision: approved ? 'approved' : 'denied',
      path: resolved.relative,
      sensitive: verdict.because,
      ...this._context(request),
    });

    if (!approved) {
      return {
        allowed: false,
        decision: 'denied',
        code: 'USER_DENIED',
        // Phrased for the model, which must not treat this as a problem to route
        // around by reading the same secret through `search_workspace` instead.
        reason: `You declined to let me read ${resolved.relative}. That was the user's decision, not an error — do not try to read it again or reach its contents another way. Carry on without it, and say so if the answer genuinely depends on it.`,
      };
    }

    this.ignoreRules.grant(resolved.relative);
    return { allowed: true, decision: 'approved', resolved };
  }

  /**
   * `before` and `after` are optional and carry no authority — they are passed
   * through to the confirmation UI so it can show a real diff. The decision is still
   * made from the resolved path and the permission mode.
   *
   * @param {{path: string, sessionId?: string, mode?: string, preview?: string, isNew?: boolean, before?: string | null, after?: string}} request
   * @returns {Promise<Decision>}
   */
  async requestWrite(request) {
    return this._requestMutation('write_file', request, {
      title: request.isNew ? `Create ${request.path}?` : `Apply changes to ${request.path}?`,
      detail: request.preview || '',
      before: request.isNew ? null : typeof request.before === 'string' ? request.before : undefined,
      after: typeof request.after === 'string' ? request.after : undefined,
    });
  }

  /**
   * @param {{path: string, sessionId?: string, mode?: string}} request
   * @returns {Promise<Decision>}
   */
  async requestDelete(request) {
    return this._requestMutation('delete_file', request, {
      title: `Delete ${request.path}?`,
      detail: 'This removes the file from your workspace.',
    });
  }

  /**
   * Creating an empty directory. The least consequential mutation there is — it
   * destroys nothing and `write_file` already does it implicitly — so it follows the
   * ordinary edit permission rather than getting a rule of its own.
   *
   * @param {{path: string, sessionId?: string, mode?: string}} request
   * @returns {Promise<Decision>}
   */
  async requestCreateFolder(request) {
    return this._requestMutation('create_folder', request, {
      title: `Create folder ${request.path}?`,
      detail: 'This adds an empty directory to your workspace.',
    });
  }

  /**
   * Removing a directory, and everything under it.
   *
   * The one mutation that always asks, in every permission mode, with no setting that
   * turns it off — `alwaysConfirmDeletes` governs files and is deliberately not
   * consulted here. A wrong file delete costs one file and the change set can restore
   * it; a wrong recursive delete costs a subtree and nothing can. The gap between
   * "delete src/main/java" and "delete src" is one token of model output.
   *
   * `entries` is what the tool counted underneath, so the confirmation can say how
   * much is actually at stake instead of asking the user to guess.
   *
   * @param {{path: string, sessionId?: string, mode?: string, entries?: number}} request
   * @returns {Promise<Decision>}
   */
  async requestDeleteFolder(request) {
    const count = Number(request.entries) || 0;
    return this._requestMutation('delete_folder', request, {
      title: `Delete folder ${request.path}?`,
      detail:
        count > 0
          ? `This removes the folder and everything in it — ${count} item(s). Folder deletions always ask, in every permission mode.`
          : 'This removes an empty folder. Folder deletions always ask, in every permission mode.',
    });
  }

  /**
   * Shared write/delete flow.
   *
   * @param {'write_file' | 'delete_file' | 'create_folder' | 'delete_folder'} action
   * @param {{path: string, sessionId?: string, mode?: string}} request
   * @param {{title: string, detail: string, before?: string | null, after?: string}} prompt
   * @returns {Promise<Decision>}
   * @private
   */
  async _requestMutation(action, request, prompt) {
    const modeRefusal = this._checkMode(request.mode);
    if (modeRefusal) return this._refuse(action, request, modeRefusal.code, modeRefusal.reason);

    /** @type {import('./pathGuard').ResolvedPath} */
    let resolved;
    try {
      resolved = pathGuard.resolveForMutation(this.workspaceRoot, request.path, {
        protectedPrefixes: this.protectedPrefixes,
      });
      await pathGuard.assertRealPath(resolved);
    } catch (err) {
      return this._blocked(action, request, err);
    }

    // A folder delete is unconditional — see `requestDeleteFolder`.
    const deleteNeedsConfirmation =
      action === 'delete_folder' || (action === 'delete_file' && this.alwaysConfirmDeletes);

    if (!this.modes.requiresEditApproval() && !deleteNeedsConfirmation) {
      await this._audit({ action, decision: 'auto-approved', path: resolved.relative, ...this._context(request) });
      return { allowed: true, decision: 'auto-approved', resolved };
    }

    const destructive = action === 'delete_file' || action === 'delete_folder';

    const approved = await this._ask({
      kind: destructive ? 'delete' : 'write',
      title: prompt.title,
      detail:
        deleteNeedsConfirmation && !this.modes.requiresEditApproval() && action === 'delete_file'
          ? `${prompt.detail} Deletions always ask, even in Auto Edit mode.`
          : prompt.detail,
      risk: destructive ? 'elevated' : 'normal',
      path: resolved.relative,
      // The guard's own output, never the model's string — a confirmation UI that
      // opens this path must not be handed something that skipped resolution.
      absolute: resolved.absolute,
      before: prompt.before,
      after: prompt.after,
    });

    await this._audit({
      action,
      decision: approved ? 'approved' : 'denied',
      path: resolved.relative,
      ...this._context(request),
    });

    return approved
      ? { allowed: true, decision: 'approved', resolved }
      : { allowed: false, decision: 'denied', code: 'USER_DENIED', reason: 'You declined this change.' };
  }

  /**
   * Validate and seek approval for a command. Does not run it — call `runScript`
   * with the returned decision.
   *
   * @param {{command: string, sessionId?: string, mode?: string}} request
   * @returns {Promise<Decision>}
   */
  async requestScript(request) {
    const modeRefusal = this._checkMode(request.mode);
    if (modeRefusal) return this._refuse('run_script', request, modeRefusal.code, modeRefusal.reason);

    /** @type {import('./scriptRunner').ParsedCommand} */
    let parsed;
    try {
      parsed = scriptRunner.validate(request.command, { allowedBinaries: this.allowedBinaries });
    } catch (err) {
      return this._blocked('run_script', request, err);
    }

    // Some allow-listed commands publish code or hit the network. Those never
    // auto-approve, no matter what the permission mode says.
    const elevatedReason = scriptRunner.requiresExplicitApproval(parsed);

    if (!elevatedReason && !this.modes.requiresScriptApproval()) {
      await this._audit({ action: 'run_script', decision: 'auto-approved', command: request.command, ...this._context(request) });
      return { allowed: true, decision: 'auto-approved', parsed };
    }

    const approved = await this._ask({
      kind: 'script',
      title: `Run \`${request.command}\`?`,
      detail: elevatedReason
        ? `This always asks, even in auto-approve mode, because ${elevatedReason}.`
        : `Runs in ${this.workspaceRoot} with no shell interpretation.`,
      risk: elevatedReason ? 'elevated' : 'normal',
      command: request.command,
    });

    await this._audit({
      action: 'run_script',
      decision: approved ? 'approved' : 'denied',
      command: request.command,
      reason: elevatedReason || undefined,
      ...this._context(request),
    });

    return approved
      ? { allowed: true, decision: 'approved', parsed }
      : { allowed: false, decision: 'denied', code: 'USER_DENIED', reason: 'You declined to run this command.' };
  }

  /**
   * Execute a command that `requestScript` already approved.
   *
   * @param {{command: string, sessionId?: string, mode?: string, timeoutMs?: number, onOutput?: (stream: string, chunk: string) => void, signal?: AbortSignal}} request
   * @param {Decision} decision The result of `requestScript`.
   * @returns {Promise<import('./scriptRunner').RunResult>}
   * @throws {Error} If called without an allowing decision.
   */
  async runScript(request, decision) {
    if (!decision || !decision.allowed) {
      // A programming error, not a user-facing path — fail loudly.
      throw new Error('permissionGate.runScript called without an approved decision.');
    }

    try {
      const result = await scriptRunner.run(request.command, {
        cwd: this.workspaceRoot,
        allowedBinaries: this.allowedBinaries,
        timeoutMs: request.timeoutMs,
        onOutput: request.onOutput,
        signal: request.signal,
      });

      await this._audit({
        action: 'run_script',
        decision: result.ok ? 'approved' : 'failed',
        command: request.command,
        ...this._context(request),
        detail: { exitCode: result.code, timedOut: result.timedOut, durationMs: result.durationMs },
      });

      return result;
    } catch (err) {
      await this._audit({
        action: 'run_script',
        decision: 'failed',
        command: request.command,
        reason: /** @type {Error} */ (err).message,
        ...this._context(request),
      });
      throw err;
    }
  }

  /**
   * Mutations are Agent-mode only. Plan and Ask withhold the tools entirely, so
   * this is a backstop against a loop bug, not the primary enforcement.
   *
   * @param {string | undefined} mode
   * @returns {{code: string, reason: string} | null}
   * @private
   */
  _checkMode(mode) {
    if (mode === undefined || mode === 'agent') return null;
    return {
      code: 'MODE_READONLY',
      reason:
        mode === 'plan'
          ? 'Plan mode is read-only — propose this as a step in the plan instead of doing it now.'
          : 'Ask mode cannot modify the workspace.',
    };
  }

  /**
   * @param {ConfirmRequest} request
   * @returns {Promise<boolean>}
   * @private
   */
  async _ask(request) {
    if (typeof this.confirm !== 'function') {
      logger.warn('Permission gate has no confirm handler; refusing by default.');
      return false;
    }
    try {
      return Boolean(await this.confirm(request));
    } catch (err) {
      // A broken UI must fail closed.
      logger.error('Confirmation handler threw; treating as denied.', err);
      return false;
    }
  }

  /**
   * @param {string} action
   * @param {{path?: string, command?: string, sessionId?: string, mode?: string}} request
   * @param {unknown} err
   * @returns {Promise<Decision>}
   * @private
   */
  async _blocked(action, request, err) {
    const error = /** @type {Error & {code?: string}} */ (err);
    return this._refuse(action, request, error.code || 'BLOCKED', error.message);
  }

  /**
   * @param {string} action
   * @param {{path?: string, command?: string, sessionId?: string, mode?: string}} request
   * @param {string} code
   * @param {string} reason
   * @returns {Promise<Decision>}
   * @private
   */
  async _refuse(action, request, code, reason) {
    logger.warn(`Blocked ${action}: ${reason}`);
    await this._audit({
      action,
      decision: 'blocked',
      path: request.path,
      command: request.command,
      reason,
      ...this._context(request),
    });
    return { allowed: false, decision: 'blocked', code, reason };
  }

  /**
   * @param {{sessionId?: string, mode?: string}} request
   * @returns {object}
   * @private
   */
  _context(request) {
    return {
      sessionId: request.sessionId,
      mode: request.mode,
      permissions: this.modes.snapshot(),
    };
  }

  /**
   * @param {import('./auditLog').AuditEntry} entry
   * @returns {Promise<void>}
   * @private
   */
  async _audit(entry) {
    if (!this.auditLog) return;
    await this.auditLog.append(entry);
  }
}

module.exports = { PermissionGate };
