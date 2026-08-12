'use strict';

/**
 * The four permission states, as two independent toggles.
 *
 *   Edits   : approve-edits (default)   ⟷ auto-edit
 *   Scripts : approve-scripts (default) ⟷ auto-approve-scripts
 *
 * Independent because they carry very different risk: auto-applying an edit is
 * recoverable through the diff review and version control, while auto-running a
 * command is not. `auto-approve-scripts` therefore requires a deliberate one-time
 * confirmation to enable and can never be turned on by anything the model says —
 * `enableAutoScripts` is the only path in, and it demands a confirm callback.
 *
 * Persistence is injected rather than imported, so this module has no `vscode`
 * dependency and the whole state machine is unit-testable.
 *
 * @module security/permissionModes
 */

/** @typedef {'approve-edits' | 'auto-edit'} EditMode */
/** @typedef {'approve-scripts' | 'auto-approve-scripts'} ScriptMode */

/**
 * @typedef {object} PermissionState
 * @property {boolean} autoEdit
 * @property {boolean} autoApproveScripts
 */

/**
 * @typedef {object} PermissionModesOptions
 * @property {PermissionState} [initial]
 * @property {(state: PermissionState) => void | Promise<void>} [persist]
 *   Called whenever state changes, to mirror into VS Code settings.
 * @property {() => void} [onChange] Repaint hook for the status bar / webview.
 */

class PermissionModes {
  /**
   * @param {PermissionModesOptions} [options]
   */
  constructor(options = {}) {
    const initial = options.initial || {};
    /** @type {PermissionState} */
    this.state = {
      autoEdit: Boolean(initial.autoEdit),
      autoApproveScripts: Boolean(initial.autoApproveScripts),
    };
    this._persist = options.persist || null;
    this._onChange = options.onChange || null;
  }

  /** @returns {PermissionState} */
  snapshot() {
    return { ...this.state };
  }

  /** @returns {EditMode} */
  editMode() {
    return this.state.autoEdit ? 'auto-edit' : 'approve-edits';
  }

  /** @returns {ScriptMode} */
  scriptMode() {
    return this.state.autoApproveScripts ? 'auto-approve-scripts' : 'approve-scripts';
  }

  /**
   * Does a write or delete need a confirmation click right now?
   *
   * @returns {boolean}
   */
  requiresEditApproval() {
    return !this.state.autoEdit;
  }

  /**
   * Does a script run need a confirmation click right now?
   *
   * @returns {boolean}
   */
  requiresScriptApproval() {
    return !this.state.autoApproveScripts;
  }

  /**
   * Short label pair for the status bar and the permissions menu badges.
   *
   * @returns {{edits: string, scripts: string}}
   */
  badges() {
    return {
      edits: this.state.autoEdit ? 'Edits: Auto' : 'Edits: Approve',
      scripts: this.state.autoApproveScripts ? 'Scripts: Auto' : 'Scripts: Approve',
    };
  }

  /**
   * Turning auto-edit on is a plain toggle — proposed writes still appear in the
   * trace, are still logged, and are still path-guarded.
   *
   * @param {boolean} enabled
   * @returns {Promise<PermissionState>}
   */
  async setAutoEdit(enabled) {
    return this._apply({ autoEdit: Boolean(enabled) });
  }

  /**
   * Turning auto-approve-scripts ON requires an explicit confirmation. Turning it
   * OFF never does — moving toward the safer state is always frictionless.
   *
   * @param {boolean} enabled
   * @param {(() => Promise<boolean>) | null} [confirm]
   *   Must resolve true to enable. Omitting it while enabling is refused.
   * @returns {Promise<PermissionState>}
   */
  async setAutoApproveScripts(enabled, confirm = null) {
    if (!enabled) return this._apply({ autoApproveScripts: false });
    if (this.state.autoApproveScripts) return this.snapshot();

    if (typeof confirm !== 'function') {
      throw new Error(
        'Enabling Auto Approve Running Scripts requires an explicit confirmation step.'
      );
    }
    const confirmed = await confirm();
    if (!confirmed) return this.snapshot();

    return this._apply({ autoApproveScripts: true });
  }

  /**
   * Reset to the safest configuration. Used on fresh installs and by an explicit
   * "lock down" action.
   *
   * @returns {Promise<PermissionState>}
   */
  async reset() {
    return this._apply({ autoEdit: false, autoApproveScripts: false });
  }

  /**
   * Adopt state from settings (e.g. a `workspace.onDidChangeConfiguration` event)
   * without re-triggering persistence.
   *
   * @param {Partial<PermissionState>} next
   */
  hydrate(next) {
    if (typeof next.autoEdit === 'boolean') this.state.autoEdit = next.autoEdit;
    if (typeof next.autoApproveScripts === 'boolean') this.state.autoApproveScripts = next.autoApproveScripts;
    if (this._onChange) this._onChange();
  }

  /**
   * @param {Partial<PermissionState>} patch
   * @returns {Promise<PermissionState>}
   * @private
   */
  async _apply(patch) {
    this.state = { ...this.state, ...patch };
    if (this._persist) await this._persist(this.snapshot());
    if (this._onChange) this._onChange();
    return this.snapshot();
  }
}

module.exports = { PermissionModes };
