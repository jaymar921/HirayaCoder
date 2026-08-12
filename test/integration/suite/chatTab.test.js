'use strict';

/**
 * The chat tab: a real webview panel, the host side of its message protocol, and one
 * complete agent turn that ends with a file changed on disk.
 *
 * The turn runs against a stub Ollama on loopback rather than a real model, because
 * this suite is checking the wiring — client to loop to gate to tool to disk — and a
 * real model would make it slow and non-deterministic. Model behaviour is measured
 * separately by `tools/bench-agent.js`.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const { startStubOllama } = require('./stubOllama');
// A literal path, so the module cache returns the same instance the extension host
// loaded rather than a second copy with its own state.
const { ChatTab } = require('../../../app/features/chatTab.js');

const EXTENSION_ID = 'jaymar921.hirayacoder';

/** @returns {string} */
const workspaceRoot = () => vscode.workspace.workspaceFolders[0].uri.fsPath;

/** Wait for the extension to settle after a configuration change. */
async function settle(ms = 700) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Point the extension at a stub Ollama and wait until it has adopted the model.
 *
 * @param {string} endpoint
 */
async function useEndpoint(endpoint) {
  const config = vscode.workspace.getConfiguration('hirayacoder');
  await config.update('ollama.endpoint', endpoint, vscode.ConfigurationTarget.Workspace);
  await settle();

  const { app } = await vscode.extensions.getExtension(EXTENSION_ID).activate();
  await app.refresh({ force: true });
  return app;
}

describe('chat tab', () => {
  /** @type {any} */
  let stub = null;

  afterEach(async () => {
    if (stub) {
      await stub.close();
      stub = null;
    }
  });

  after(async () => {
    const config = vscode.workspace.getConfiguration('hirayacoder');
    await config.update('ollama.endpoint', undefined, vscode.ConfigurationTarget.Workspace);
    await config.update('permissions.autoEdit', undefined, vscode.ConfigurationTarget.Workspace);
    await settle();
  });

  it('opens a chat panel from the command', async () => {
    // The temp workspace has no prior sessions, so this does not stop on the
    // "resume or new" picker.
    await vscode.commands.executeCommand('hirayacoder.openChat');
    await settle(400);

    // Reaching here without throwing means the panel was created and its HTML — CSP
    // nonce, asset URIs, the lot — was built from disk without error.
    assert.ok(true);
  });

  it('answers a webview `ready` with the state the UI needs', async () => {
    stub = await startStubOllama({ replies: ['ok'] });
    const app = await useEndpoint(stub.endpoint);

    const tab = new ChatTab({ context: app.context, app, sessionId: 900 });
    tab.reveal();

    /** @type {any[]} */
    const posted = [];
    tab._post = (message) => posted.push(message);

    await tab._onMessage({ type: 'ready' });

    const init = posted.find((m) => m.type === 'init');
    assert.ok(init, 'no init message was sent to the webview');
    assert.strictEqual(init.sessionId, 900);
    assert.ok(Array.isArray(init.models), 'the model list was not sent');
    assert.ok(init.permissions, 'the permission state was not sent');

    // Both were dead code until this phase; a regression would be silent in the UI.
    assert.ok(posted.some((m) => m.type === 'vision'), 'no vision capability message');
    assert.ok(posted.some((m) => m.type === 'status'), 'no status message');

    tab._dispose();
  });

  it('ignores an unknown message from the webview instead of acting on it', async () => {
    stub = await startStubOllama({ replies: ['ok'] });
    const app = await useEndpoint(stub.endpoint);

    const tab = new ChatTab({ context: app.context, app, sessionId: 901 });

    /** @type {any[]} */
    const posted = [];
    tab._post = (message) => posted.push(message);

    // The webview is the untrusted side. An unrecognised type must be dropped.
    await tab._onMessage({ type: 'read-file', path: '../../../etc/passwd' });
    assert.deepStrictEqual(posted, []);
  });

  it('runs a full turn that reaches the disk', async () => {
    const target = path.join(workspaceRoot(), 'src', 'greet.js');
    const before = fs.readFileSync(target, 'utf8');

    const updated =
      'function greet(name) {\n' +
      '  if (!name) {\n' +
      '    return "Hello there";\n' +
      '  }\n' +
      '  return "Hello " + name;\n' +
      '}\n\n' +
      'module.exports = { greet };\n';

    stub = await startStubOllama({
      replies: [
        JSON.stringify({ action: 'write_file', path: 'src/greet.js', code: updated }),
        JSON.stringify({ action: 'done', summary: 'Handled the empty name.' }),
      ],
    });

    const config = vscode.workspace.getConfiguration('hirayacoder');
    // Auto Edit so the write applies without a modal — an unanswered dialog would
    // hang the run. Deletes are not exercised here; they always confirm.
    await config.update('permissions.autoEdit', true, vscode.ConfigurationTarget.Workspace);
    const app = await useEndpoint(stub.endpoint);

    const tab = new ChatTab({ context: app.context, app, sessionId: 902 });

    /** @type {any[]} */
    const posted = [];
    tab._post = (message) => posted.push(message);

    await tab._run('Make greet handle an empty name.');

    const after = fs.readFileSync(target, 'utf8');
    assert.notStrictEqual(after, before, 'the turn did not change the file');
    assert.match(after, /Hello there/);
    assert.match(after, /module\.exports/, 'the write guards should have preserved the exports');

    const done = posted.find((m) => m.type === 'done');
    assert.ok(done, 'the webview was never told the turn finished');
    assert.ok(
      done.changes.some((change) => change.path.replace(/\\/g, '/') === 'src/greet.js'),
      'the change set did not report the edited file'
    );

    // The request really went over a socket to the loopback stub.
    assert.ok(stub.state.calls > 0, 'the stub Ollama was never called');
    assert.ok(
      stub.state.requests.some((r) => r.url === '/api/chat'),
      'no chat request was made'
    );

    fs.writeFileSync(target, before);
  });

  it('restores the conversation when a closed session is reopened', async () => {
    // Reported from real use: close the tab, reopen session 1 from the picker, and the
    // panel comes up empty — the memory file was still on disk, but everything the
    // user had actually read was gone.
    stub = await startStubOllama({
      replies: [JSON.stringify({ action: 'done', summary: 'It prints Hello, World!' })],
    });
    const app = await useEndpoint(stub.endpoint);

    const first = new ChatTab({ context: app.context, app, sessionId: 910 });
    first._post = () => {};
    await first._run('explain myjava.java');
    await first.transcript.flush();
    first._dispose();

    // A brand-new tab object for the same session, exactly as reopening produces.
    const reopened = new ChatTab({ context: app.context, app, sessionId: 910 });
    /** @type {any[]} */
    const posted = [];
    reopened._post = (message) => posted.push(message);
    await reopened._onMessage({ type: 'ready' });

    const init = posted.find((m) => m.type === 'init');
    assert.ok(init, 'no init message');
    assert.deepStrictEqual(
      init.history.map((entry) => entry.role),
      ['user', 'assistant'],
      'the reopened session did not carry its conversation'
    );
    assert.strictEqual(init.history[0].text, 'explain myjava.java');
    assert.match(init.history[1].text, /Hello, World!/);
  });

  it('writes an audit record for the action it took', async () => {
    const auditPath = path.join(workspaceRoot(), '.hirayacoder', 'audit.log');
    assert.ok(fs.existsSync(auditPath), 'no audit log was written for a completed turn');

    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
    const events = lines.map((line) => JSON.parse(line));
    assert.ok(
      events.some((event) => event.action === 'write_file'),
      'the write never reached the audit log'
    );
  });
});
