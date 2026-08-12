'use strict';

const assert = require('assert');

const { PermissionModes } = require('../../app/security/permissionModes');

describe('PermissionModes defaults', () => {
  it('starts in the safest state on a fresh install', () => {
    const modes = new PermissionModes();
    assert.deepStrictEqual(modes.snapshot(), { autoEdit: false, autoApproveScripts: false });
    assert.strictEqual(modes.editMode(), 'approve-edits');
    assert.strictEqual(modes.scriptMode(), 'approve-scripts');
    assert.strictEqual(modes.requiresEditApproval(), true);
    assert.strictEqual(modes.requiresScriptApproval(), true);
  });

  it('exposes the four states as two independent toggles', async () => {
    const modes = new PermissionModes();
    await modes.setAutoEdit(true);
    // Turning edits automatic must not loosen scripts.
    assert.strictEqual(modes.requiresEditApproval(), false);
    assert.strictEqual(modes.requiresScriptApproval(), true);
    assert.strictEqual(modes.editMode(), 'auto-edit');
    assert.strictEqual(modes.scriptMode(), 'approve-scripts');
  });

  it('renders badges for the UI', async () => {
    const modes = new PermissionModes();
    assert.deepStrictEqual(modes.badges(), { edits: 'Edits: Approve', scripts: 'Scripts: Approve' });
    await modes.setAutoEdit(true);
    assert.strictEqual(modes.badges().edits, 'Edits: Auto');
  });
});

describe('PermissionModes auto-approve-scripts opt-in', () => {
  it('refuses to enable without a confirmation step', async () => {
    const modes = new PermissionModes();
    await assert.rejects(() => modes.setAutoApproveScripts(true), /requires an explicit confirmation/i);
    assert.strictEqual(modes.state.autoApproveScripts, false);
  });

  it('stays off when the user declines', async () => {
    const modes = new PermissionModes();
    await modes.setAutoApproveScripts(true, async () => false);
    assert.strictEqual(modes.state.autoApproveScripts, false);
  });

  it('turns on only when the user confirms', async () => {
    const modes = new PermissionModes();
    let asked = 0;
    await modes.setAutoApproveScripts(true, async () => {
      asked += 1;
      return true;
    });
    assert.strictEqual(asked, 1);
    assert.strictEqual(modes.requiresScriptApproval(), false);
    assert.strictEqual(modes.scriptMode(), 'auto-approve-scripts');
  });

  it('does not re-prompt when already enabled', async () => {
    const modes = new PermissionModes({ initial: { autoApproveScripts: true } });
    let asked = 0;
    await modes.setAutoApproveScripts(true, async () => {
      asked += 1;
      return true;
    });
    assert.strictEqual(asked, 0);
  });

  it('turns off without any friction', async () => {
    // Moving toward the safer state is always frictionless.
    const modes = new PermissionModes({ initial: { autoApproveScripts: true } });
    await modes.setAutoApproveScripts(false);
    assert.strictEqual(modes.state.autoApproveScripts, false);
  });

  it('resets both toggles to the safe state', async () => {
    const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: true } });
    await modes.reset();
    assert.deepStrictEqual(modes.snapshot(), { autoEdit: false, autoApproveScripts: false });
  });
});

describe('PermissionModes persistence', () => {
  it('persists every change', async () => {
    /** @type {object[]} */
    const saved = [];
    const modes = new PermissionModes({ persist: (state) => saved.push(state) });
    await modes.setAutoEdit(true);
    await modes.setAutoApproveScripts(true, async () => true);
    assert.deepStrictEqual(saved, [
      { autoEdit: true, autoApproveScripts: false },
      { autoEdit: true, autoApproveScripts: true },
    ]);
  });

  it('does not persist a declined enable', async () => {
    /** @type {object[]} */
    const saved = [];
    const modes = new PermissionModes({ persist: (state) => saved.push(state) });
    await modes.setAutoApproveScripts(true, async () => false);
    assert.strictEqual(saved.length, 0);
  });

  it('notifies listeners so the status bar repaints', async () => {
    let changes = 0;
    const modes = new PermissionModes({ onChange: () => (changes += 1) });
    await modes.setAutoEdit(true);
    modes.hydrate({ autoApproveScripts: true });
    assert.strictEqual(changes, 2);
  });

  it('hydrates from settings without re-persisting', async () => {
    /** @type {object[]} */
    const saved = [];
    const modes = new PermissionModes({ persist: (state) => saved.push(state) });
    modes.hydrate({ autoEdit: true, autoApproveScripts: true });
    assert.strictEqual(modes.state.autoEdit, true);
    assert.strictEqual(saved.length, 0, 'hydrate must not write back and loop');
  });

  it('ignores non-boolean values on hydrate', () => {
    const modes = new PermissionModes();
    modes.hydrate(/** @type {any} */ ({ autoEdit: 'yes', autoApproveScripts: null }));
    assert.deepStrictEqual(modes.snapshot(), { autoEdit: false, autoApproveScripts: false });
  });

  it('snapshot is a copy, not a live reference', async () => {
    const modes = new PermissionModes();
    const before = modes.snapshot();
    await modes.setAutoEdit(true);
    assert.strictEqual(before.autoEdit, false);
  });
});
