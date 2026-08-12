'use strict';

/**
 * Activation, commands, and configuration — the things a user hits before typing
 * anything, and the things the mocked unit suite cannot see.
 */

const assert = require('assert');
const vscode = require('vscode');

const EXTENSION_ID = 'jaymar921.hirayacoder';

/** Every command the manifest promises. A registration that silently fails is invisible until clicked. */
const COMMANDS = [
  'hirayacoder.openChat',
  'hirayacoder.selectModel',
  'hirayacoder.refreshModels',
  'hirayacoder.showStatus',
  'hirayacoder.showLogs',
  'hirayacoder.permissions',
  'hirayacoder.showAuditLog',
  'hirayacoder.showMemory',
  'hirayacoder.clearMemory',
  'hirayacoder.attachContextFile',
  'hirayacoder.pullModel',
  'hirayacoder.explain',
  'hirayacoder.refactor',
  'hirayacoder.document',
  'hirayacoder.fix',
  'hirayacoder.generateTests',
];

describe('activation', () => {
  it('finds the extension in the host', () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} was not found. Check publisher/name in package.json.`);
  });

  it('activates and exposes its singletons', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    const api = await extension.activate();

    assert.ok(api, 'activate() returned nothing');
    assert.ok(api.app, 'activate() did not expose `app`');
    assert.ok(api.app.modes, 'permission modes are missing');
  });

  it('opens on a trusted workspace with a folder', () => {
    // Without a workspace root the gate is deliberately null and every tool refuses,
    // so a test run without a folder would pass for the wrong reason.
    assert.ok(vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0);
    assert.strictEqual(vscode.workspace.isTrusted, true);
  });

  it('registers every command the manifest declares', async () => {
    const registered = await vscode.commands.getCommands(true);
    const missing = COMMANDS.filter((id) => !registered.includes(id));
    assert.deepStrictEqual(missing, [], `commands declared but not registered: ${missing.join(', ')}`);
  });

  it('builds a permission gate bound to the open workspace', async () => {
    const { app } = await vscode.extensions.getExtension(EXTENSION_ID).activate();
    assert.ok(app.gate, 'no permission gate — the agent would refuse every action');
    assert.strictEqual(
      app.gate.workspaceRoot,
      vscode.workspace.workspaceFolders[0].uri.fsPath,
      'the gate is confined to a different folder than the one that is open'
    );
  });

  it('starts with both automatic permission modes off', async () => {
    const { app } = await vscode.extensions.getExtension(EXTENSION_ID).activate();
    const snapshot = app.modes.snapshot();
    // The safe default is the whole point: a fresh install must never auto-apply.
    assert.strictEqual(snapshot.autoEdit, false);
    assert.strictEqual(snapshot.autoApproveScripts, false);
  });

  it('refuses a non-loopback endpoint instead of trying to reach it', async () => {
    const config = vscode.workspace.getConfiguration('hirayacoder');
    const original = config.get('ollama.endpoint');
    const remote = 'http://10.0.0.5:11434';

    try {
      await config.update('ollama.endpoint', remote, vscode.ConfigurationTarget.Workspace);
      // The change is applied asynchronously through onDidChangeConfiguration.
      await new Promise((resolve) => setTimeout(resolve, 800));

      const { app } = await vscode.extensions.getExtension(EXTENSION_ID).activate();

      assert.ok(app.configError, 'a remote endpoint was accepted');
      assert.match(String(app.configError), /loopback|127\.0\.0\.1|localhost/i);

      // The guard throws before `reconfigure`, so the client is never repointed at the
      // remote host. The previous loopback client is kept rather than discarded, and
      // `refresh()` refuses to act at all while `configError` is set — fail closed on
      // activity, rather than fail closed by throwing the object away.
      if (app.client) {
        assert.notStrictEqual(app.client.endpoint, remote, 'the client was pointed at a remote host');
        assert.match(String(app.client.endpoint), /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i);
      }

      // A refresh in this state must not issue a request; it repaints as offline.
      await app.refresh({ force: true });
      assert.ok(app.configError, 'the refusal was cleared by a refresh');
    } finally {
      await config.update('ollama.endpoint', original, vscode.ConfigurationTarget.Workspace);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  });
});
