'use strict';

/**
 * The chat tab's message handling.
 *
 * Everything here is about the trust boundary the module documents: the webview sends
 * requests, and this side decides. What is asserted is that a request actually reaches
 * something — the failure being guarded against is a click that silently does nothing.
 */

const assert = require('assert');

const stub = require('./stubVscode').install();

const { ChatTab } = require('../../app/features/chatTab');
const { PermissionModes } = require('../../app/security/permissionModes');

/**
 * A ChatTab wired to a fake panel, so posts to the webview can be read back.
 *
 * @param {object} [app] Overrides for the app singleton bag.
 */
function makeTab(app = {}) {
  const tab = new ChatTab({
    context: { subscriptions: [], extensionUri: { fsPath: '/ext' } },
    sessionId: 1,
    app: {
      // No workspace, so no transcript store is built and nothing touches disk.
      workspaceRoot: null,
      settings: {},
      modes: new PermissionModes({ initial: { autoEdit: false, autoApproveScripts: false } }),
      ...app,
    },
  });

  /** @type {object[]} */
  const posted = [];
  tab.panel = /** @type {any} */ ({ webview: { postMessage: (message) => posted.push(message) } });
  return { tab, posted };
}

describe('ChatTab', () => {
  describe('permissions', () => {
    /** @type {string[]} */
    let executed;
    /** @type {Function} */
    let originalExecute;

    beforeEach(() => {
      executed = [];
      originalExecute = stub.commands.executeCommand;
      stub.commands.executeCommand = async (command) => {
        executed.push(command);
      };
    });

    afterEach(() => {
      stub.commands.executeCommand = originalExecute;
    });

    it('routes the permissions button to the one menu that can apply a change', async () => {
      // The regression: this handler used to render its own quick pick and apply the
      // answer with `modes.toggle(id)` — a method PermissionModes has never had. Every
      // click threw a TypeError into an unhandled rejection, so both permissions were
      // unreachable from the chat tab and auto-approve-scripts in particular could be
      // clicked forever with no effect and no error.
      const { tab } = makeTab();

      await tab._onMessage({ type: 'permissions' });

      assert.deepStrictEqual(executed, ['hirayacoder.permissions']);
    });

    it('posts the resulting state back so the header stops lying about it', async () => {
      const modes = new PermissionModes({ initial: { autoEdit: false, autoApproveScripts: false } });
      const { tab, posted } = makeTab({ modes });
      stub.commands.executeCommand = async () => {
        // Stand in for the user turning auto-edit on inside the menu.
        await modes.setAutoEdit(true);
      };

      await tab._onMessage({ type: 'permissions' });

      const update = posted.find((message) => message.type === 'permissions');
      assert.ok(update, 'the webview was never told');
      assert.strictEqual(update.permissions.autoEdit, true);
    });

    it('never calls a method the permission model does not have', async () => {
      // Belt and braces on the specific shape of the original bug: a handler that
      // reaches for an absent method fails as an unhandled rejection, which is exactly
      // the failure mode that let this sit unnoticed.
      const modes = new PermissionModes({ initial: {} });
      assert.strictEqual(typeof (/** @type {any} */ (modes).toggle), 'undefined');

      const { tab } = makeTab({ modes });
      await assert.doesNotReject(() => tab._onMessage({ type: 'permissions' }));
    });
  });

  describe('mode selection', () => {
    it('accepts the three real modes and refuses anything else', async () => {
      const { tab } = makeTab();

      await tab._onMessage({ type: 'mode', mode: 'plan' });
      assert.strictEqual(tab.mode, 'plan');

      await tab._onMessage({ type: 'mode', mode: 'not-a-mode' });
      assert.strictEqual(tab.mode, 'agent', 'an unknown mode must fall back to the default');
    });
  });

  describe('step sessions', () => {
    const capability = { tier: 'B', label: 'Lite', canPlanTodos: true };

    it('is seeded from the setting', () => {
      assert.strictEqual(makeTab({ settings: { stepSessions: true } }).tab.stepSessions, true);
      assert.strictEqual(makeTab().tab.stepSessions, false);
    });

    it('is owned by the tab, so trying it here does not turn it on everywhere', async () => {
      // Like mode and thinking capacity: the header toggle changes this conversation,
      // not the user's global preference.
      const settings = { stepSessions: false };
      const { tab } = makeTab({ settings, capability });

      await tab._onMessage({ type: 'step-sessions', enabled: true });

      assert.strictEqual(tab.stepSessions, true);
      assert.strictEqual(settings.stepSessions, false, 'the global setting was written');
    });

    it('takes only a real boolean, so a malformed message cannot half-enable it', async () => {
      const { tab } = makeTab({ settings: { stepSessions: true }, capability });

      await tab._onMessage({ type: 'step-sessions', enabled: 'yes' });
      assert.strictEqual(tab.stepSessions, false);
    });

    it('says so in the status line, but only where a list can exist', async () => {
      const { tab, posted } = makeTab({ settings: { stepSessions: true }, capability });
      await tab._onMessage({ type: 'step-sessions', enabled: true });
      assert.match(posted.filter((m) => m.type === 'status').pop().text, /step sessions/);

      // A model that cannot hold a TODO list has no list to run step-wise, and saying
      // "step sessions" under it would promise something that never happens.
      const solo = makeTab({ settings: {}, capability: { ...capability, canPlanTodos: false } });
      await solo.tab._onMessage({ type: 'step-sessions', enabled: true });
      assert.ok(!solo.posted.filter((m) => m.type === 'status').pop().text.includes('step sessions'));
    });
  });
});
