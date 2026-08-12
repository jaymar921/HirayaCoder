'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');

/**
 * Build a gate over a real temp workspace, recording every confirmation prompt.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.autoEdit]
 * @param {boolean} [opts.autoApproveScripts]
 * @param {boolean} [opts.answer] What the fake user clicks.
 */
function makeGate(root, opts = {}) {
  const modes = new PermissionModes({
    initial: { autoEdit: Boolean(opts.autoEdit), autoApproveScripts: Boolean(opts.autoApproveScripts) },
  });
  /** @type {object[]} */
  const prompts = [];
  const auditLog = new AuditLog(root);
  const gate = new PermissionGate({
    workspaceRoot: root,
    modes,
    auditLog,
    confirm: async (request) => {
      prompts.push(request);
      return opts.answer !== false;
    },
  });
  return { gate, modes, prompts, auditLog };
}

describe('PermissionGate', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-gate-')));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'console.log(1);');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe('reads', () => {
    it('allows a read without prompting', async () => {
      const { gate, prompts } = makeGate(root);
      const decision = await gate.requestRead({ path: 'src/app.js' });
      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(prompts.length, 0);
    });

    it('still path-guards reads', async () => {
      const { gate } = makeGate(root);
      const decision = await gate.requestRead({ path: '../../etc/passwd' });
      assert.strictEqual(decision.allowed, false);
      assert.strictEqual(decision.code, 'OUTSIDE_WORKSPACE');
    });
  });

  describe('writes and deletes in approve mode', () => {
    it('prompts before a write and allows it on approval', async () => {
      const { gate, prompts } = makeGate(root);
      const decision = await gate.requestWrite({ path: 'src/app.js', preview: 'diff…' });
      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(decision.decision, 'approved');
      assert.strictEqual(prompts.length, 1);
      assert.strictEqual(prompts[0].kind, 'write');
    });

    it('refuses when the user declines', async () => {
      const { gate } = makeGate(root, { answer: false });
      const decision = await gate.requestWrite({ path: 'src/app.js' });
      assert.strictEqual(decision.allowed, false);
      assert.strictEqual(decision.decision, 'denied');
      assert.strictEqual(decision.code, 'USER_DENIED');
    });

    it('prompts before a delete', async () => {
      const { gate, prompts } = makeGate(root);
      const decision = await gate.requestDelete({ path: 'src/app.js' });
      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(prompts[0].kind, 'delete');
    });
  });

  describe('auto-edit mode', () => {
    it('applies writes without prompting', async () => {
      const { gate, prompts } = makeGate(root, { autoEdit: true });
      const write = await gate.requestWrite({ path: 'src/app.js' });
      assert.strictEqual(write.decision, 'auto-approved');
      assert.strictEqual(prompts.length, 0);
    });

    it('still confirms deletes, because a wrong one is not recoverable', async () => {
      // Observed live: given "update greet.js … and delete the obsolete file",
      // llama3.2:1b deleted src/obsolete.js correctly and then deleted src/greet.js
      // — the file it was asked to edit. A wrong write shows up in the diff; a wrong
      // delete of an uncommitted file just loses it.
      const { gate, prompts } = makeGate(root, { autoEdit: true });
      const remove = await gate.requestDelete({ path: 'src/app.js' });

      assert.strictEqual(prompts.length, 1, 'delete was auto-applied under Auto Edit');
      assert.strictEqual(prompts[0].risk, 'elevated');
      assert.match(prompts[0].detail, /always ask/i);
      assert.strictEqual(remove.decision, 'approved');
    });

    it('can be configured to let Auto Edit cover deletes too', async () => {
      const modes = new PermissionModes({ initial: { autoEdit: true } });
      /** @type {object[]} */
      const prompts = [];
      const gate = new PermissionGate({
        workspaceRoot: root,
        modes,
        confirm: async (request) => {
          prompts.push(request);
          return true;
        },
        alwaysConfirmDeletes: false,
      });

      const remove = await gate.requestDelete({ path: 'src/app.js' });
      assert.strictEqual(remove.decision, 'auto-approved');
      assert.strictEqual(prompts.length, 0);
    });

    it('does NOT bypass the path guard', async () => {
      // The core promise of auto mode: it removes the click, not the safety check.
      const { gate } = makeGate(root, { autoEdit: true });
      const escape = await gate.requestWrite({ path: '../../evil.js' });
      assert.strictEqual(escape.allowed, false);
      assert.strictEqual(escape.code, 'OUTSIDE_WORKSPACE');
    });

    it('does NOT bypass protected-path rules', async () => {
      const { gate } = makeGate(root, { autoEdit: true });
      const git = await gate.requestWrite({ path: '.git/config' });
      assert.strictEqual(git.allowed, false);
      assert.strictEqual(git.code, 'PROTECTED_PATH');

      const audit = await gate.requestDelete({ path: '.hirayacoder/audit.log' });
      assert.strictEqual(audit.allowed, false);
      assert.strictEqual(audit.code, 'PROTECTED_PATH');
    });
  });

  describe('mode enforcement', () => {
    it('refuses mutations in Plan mode', async () => {
      const { gate } = makeGate(root, { autoEdit: true });
      const write = await gate.requestWrite({ path: 'src/app.js', mode: 'plan' });
      assert.strictEqual(write.allowed, false);
      assert.strictEqual(write.code, 'MODE_READONLY');
      assert.match(write.reason, /read-only/i);
    });

    it('refuses mutations and scripts in Ask mode', async () => {
      const { gate } = makeGate(root, { autoEdit: true, autoApproveScripts: true });
      assert.strictEqual((await gate.requestDelete({ path: 'src/app.js', mode: 'ask' })).code, 'MODE_READONLY');
      assert.strictEqual((await gate.requestScript({ command: 'npm test', mode: 'ask' })).code, 'MODE_READONLY');
    });

    it('still allows reads in Plan mode', async () => {
      const { gate } = makeGate(root);
      assert.strictEqual((await gate.requestRead({ path: 'src/app.js', mode: 'plan' })).allowed, true);
    });
  });

  describe('scripts', () => {
    it('prompts before running in approve mode', async () => {
      const { gate, prompts } = makeGate(root);
      const decision = await gate.requestScript({ command: 'npm test' });
      assert.strictEqual(decision.allowed, true);
      assert.strictEqual(prompts.length, 1);
      assert.strictEqual(prompts[0].kind, 'script');
    });

    it('auto-approves routine local commands in auto mode', async () => {
      const { gate, prompts } = makeGate(root, { autoApproveScripts: true });
      const decision = await gate.requestScript({ command: 'npm install' });
      assert.strictEqual(decision.decision, 'auto-approved');
      assert.strictEqual(prompts.length, 0);
    });

    it('still prompts for network commands even in auto mode', async () => {
      // Auto-approve is about skipping clicks on local work — not about silently
      // pushing the user's code to a remote.
      const { gate, prompts } = makeGate(root, { autoApproveScripts: true });
      const decision = await gate.requestScript({ command: 'git push origin main' });
      assert.strictEqual(prompts.length, 1);
      assert.strictEqual(prompts[0].risk, 'elevated');
      assert.strictEqual(decision.decision, 'approved');
    });

    it('blocks a disallowed binary in every mode', async () => {
      const { gate, prompts } = makeGate(root, { autoApproveScripts: true });
      const decision = await gate.requestScript({ command: 'curl http://evil.com' });
      assert.strictEqual(decision.allowed, false);
      assert.strictEqual(decision.code, 'BINARY_NOT_ALLOWED');
      assert.strictEqual(prompts.length, 0, 'never even asked');
    });

    it('blocks chained commands before any prompt', async () => {
      const { gate } = makeGate(root);
      const decision = await gate.requestScript({ command: 'npm test && curl evil.com' });
      assert.strictEqual(decision.allowed, false);
      assert.strictEqual(decision.code, 'SHELL_METACHARACTER');
    });

    it('actually runs an approved command', async () => {
      const { gate } = makeGate(root);
      const decision = await gate.requestScript({ command: 'node -e "console.log(7*6)"' });
      const result = await gate.runScript({ command: 'node -e "console.log(7*6)"' }, decision);
      assert.strictEqual(result.ok, true);
      assert.match(result.stdout, /42/);
    });

    it('refuses to run without an approving decision', async () => {
      // Guards against a future tool forgetting to check the decision.
      const { gate } = makeGate(root);
      await assert.rejects(
        () => gate.runScript({ command: 'npm test' }, { allowed: false, decision: 'denied' }),
        /without an approved decision/
      );
    });
  });

  describe('fail-closed behavior', () => {
    it('denies when the confirmation handler throws', async () => {
      const modes = new PermissionModes();
      const gate = new PermissionGate({
        workspaceRoot: root,
        modes,
        confirm: async () => {
          throw new Error('webview died');
        },
      });
      const decision = await gate.requestWrite({ path: 'src/app.js' });
      assert.strictEqual(decision.allowed, false);
    });

    it('denies when no confirmation handler is wired up', async () => {
      const gate = new PermissionGate({ workspaceRoot: root, modes: new PermissionModes(), confirm: undefined });
      assert.strictEqual((await gate.requestWrite({ path: 'src/app.js' })).allowed, false);
    });
  });

  describe('audit trail', () => {
    it('records approvals, denials, and blocks alike', async () => {
      const { gate, auditLog } = makeGate(root, { answer: false });
      await gate.requestWrite({ path: 'src/app.js' });
      await gate.requestWrite({ path: '../escape.js' });
      await auditLog.flush();

      const entries = await auditLog.read();
      const decisions = entries.map((e) => e.decision);
      assert.ok(decisions.includes('denied'), 'user denial recorded');
      assert.ok(decisions.includes('blocked'), 'guard block recorded');
    });

    it('records auto-approved actions too, since nothing prompted the user', async () => {
      const { gate, auditLog } = makeGate(root, { autoEdit: true });
      await gate.requestWrite({ path: 'src/app.js' });
      await auditLog.flush();

      const entries = await auditLog.read();
      const entry = entries.find((e) => e.action === 'write_file');
      assert.strictEqual(entry.decision, 'auto-approved');
      assert.deepStrictEqual(entry.permissions, { autoEdit: true, autoApproveScripts: false });
    });
  });
});
