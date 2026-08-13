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

  describe('a tab closed while the agent is working', () => {
    /** @type {Function} */
    let originalInfo;

    beforeEach(() => {
      originalInfo = stub.window.showInformationMessage;
      stub.window.showInformationMessage = async () => undefined;
    });

    afterEach(() => {
      stub.window.showInformationMessage = originalInfo;
    });

    it('keeps a running turn alive instead of cancelling it', () => {
      // Closing a tab is not the same decision as pressing Stop. On CPU inference a
      // turn is minutes long, so this used to throw away a whole autonomous run on a
      // misclick, at the moment it could least afford it.
      let cancelled = false;
      const retired = [];
      const { tab } = makeTab();
      tab.onRetire = () => retired.push(true);
      tab.session = /** @type {any} */ ({ cancel: () => { cancelled = true; } });

      tab._dispose();

      assert.strictEqual(cancelled, false, 'the run was cancelled');
      assert.strictEqual(tab.isDetached(), true);
      assert.deepStrictEqual(retired, [], 'a running session must stay tracked, or it can never be reopened');
    });

    it('gives up its place in the queue when nothing has started yet', () => {
      // The other half of the rule: a queued turn has done nothing worth saving, and
      // holding the lane for a tab nobody is watching starves every other session.
      let aborted = false;
      const retired = [];
      const { tab } = makeTab();
      tab.onRetire = () => retired.push(true);
      tab._starting = true;
      tab._queueAbort = /** @type {any} */ ({ abort: () => { aborted = true; } });

      tab._dispose();

      assert.strictEqual(aborted, true);
      assert.deepStrictEqual(retired, [true]);
    });

    it('ignores a late dispose from a panel it has already replaced', () => {
      const { tab } = makeTab();
      const stale = /** @type {any} */ ({ webview: {} });
      const live = tab.panel;

      tab._dispose(stale);

      assert.strictEqual(tab.panel, live, 'the reopened panel was torn down by the old one');
    });

    it('shows the turn as still running when the session is reopened', async () => {
      const { tab, posted } = makeTab({ listModels: async () => [] });
      tab.session = /** @type {any} */ ({ cancel: () => {} });
      tab._detachedAt = Date.now();

      await tab._sendInit();

      assert.ok(posted.some((m) => m.type === 'start'), 'the composer would look idle over a live session');
      assert.match(posted.filter((m) => m.type === 'status').pop().text, /kept running/i);
      assert.strictEqual(tab.isDetached(), false);
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
