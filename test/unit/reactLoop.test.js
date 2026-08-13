'use strict';

/**
 * The Tier B loop's recovery behaviour, which is where small models spend most of
 * their time. Every case below was first observed against a real model — the loop
 * looked correct in isolation and still lost the session.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { recoveryHint, nextStepHint, goalReminder } = require('../../app/agent/reactLoop');
const { AgentSession } = require('../../app/agent/agentSession');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');

const TIER_B = { tier: 'B', strategy: 'react', label: 'Lite', model: 'qwen3.5:0.8b' };

/** @param {Array<string | object>} replies */
function scriptedClient(replies) {
  return {
    calls: 0,
    prompts: /** @type {string[]} */ ([]),
    async chat(body) {
      this.prompts.push(JSON.stringify(body.messages));
      const reply = replies[Math.min(this.calls, replies.length - 1)];
      this.calls += 1;
      return { message: typeof reply === 'string' ? { content: reply } : reply };
    },
  };
}

/** @param {object} action */
const json = (action) => JSON.stringify(action);

describe('reactLoop', () => {
  describe('recoveryHint', () => {
    it('tells the model to send whole-file content when "code" is missing', () => {
      const hint = recoveryHint('The "write_file" action is missing: code.');
      assert.match(hint, /COMPLETE new contents/);
      // The failure mode it must not encourage is sending only the changed lines.
      assert.match(hint, /every line/);
    });

    it('names the relative-path convention when "path" is missing', () => {
      assert.match(recoveryHint('The "read_file" action is missing: path.'), /relative to the project root/);
    });

    it('falls back to restating the error it does not recognise', () => {
      assert.match(recoveryHint('something unexpected'), /something unexpected/);
    });
  });

  describe('goalReminder', () => {
    it('restates the task where the model is about to decide', () => {
      const reminder = goalReminder('Build a TODO app with six components', 0, 8);

      assert.match(reminder, /Build a TODO app with six components/);
      assert.match(reminder, /step 1 of 8/);
    });

    it('cuts a spec down rather than pasting it in whole', () => {
      const spec = `Build a TODO app. ${'Every detail matters. '.repeat(60)}`;
      const reminder = goalReminder(spec, 2, 8);

      assert.ok(reminder.length < 400, 'the whole spec went back into every turn');
      assert.match(reminder, /Build a TODO app/);
      assert.match(reminder, /…/);
    });

    it('turns "keep exploring" into "finish" as the budget runs out', () => {
      assert.doesNotMatch(goalReminder('do the thing', 0, 8), /finish with "done"/);
      assert.match(goalReminder('do the thing', 6, 8), /finish with "done"/);
    });

    it('says nothing when there is no task to restate', () => {
      assert.strictEqual(goalReminder('', 0, 8), '');
      assert.strictEqual(goalReminder(undefined, 0, 8), '');
    });
  });

  describe('nextStepHint', () => {
    const route = { allowedActions: new Set(['read_file', 'write_file', 'done']) };
    const ok = { ok: true, observation: 'fine' };

    it('points at "done" after a successful write instead of leaving the model idle', () => {
      // Without a hint here the model re-reads the file it just wrote and the repeat
      // guard ends an otherwise finished session as "repeating".
      const hint = nextStepHint({ action: 'write_file', path: 'src/app.js' }, ok, 1, route);
      assert.match(hint, /saved/);
      assert.match(hint, /done/);
      assert.match(hint, /Do NOT read or write it again/);
    });

    it('asks for a corrected retry after a content refusal, not a different action', () => {
      // The two guards must not contradict each other: writeFile says "resend it
      // with live code", so this must not say "never write that path again".
      const refused = { ok: false, observation: 'Refused: …', error: 'FULLY_COMMENTED' };
      const hint = nextStepHint({ action: 'write_file', path: 'src/app.js' }, refused, 1, route);
      assert.match(hint, /same path again/);
      assert.ok(!/Do NOT try write_file/.test(hint));
    });

    it('treats a user refusal as a decision, not an obstacle', () => {
      // Live on `qwen3.5:2b`: its delete was declined, so it retried, then reached
      // for `rm -rf` via run_script. The allow-list blocked that, but nothing had
      // told the model to stop looking for another route.
      const denied = { ok: false, observation: 'You declined this change.', error: 'USER_DENIED' };
      const hint = nextStepHint({ action: 'delete_file', path: 'src/old.js' }, denied, 1, route);

      assert.match(hint, /the user said no/);
      assert.match(hint, /do NOT try to achieve the same thing another way/i);
      assert.match(hint, /no shell commands/);
    });

    it('still steers away from an action that failed for any other reason', () => {
      const refused = { ok: false, observation: 'no such file', error: 'NOT_FOUND' };
      const hint = nextStepHint({ action: 'read_file', path: 'nope.js' }, refused, 1, route);
      assert.match(hint, /Do NOT try read_file/);
    });

    it('tells the model to edit, not re-read, after a read', () => {
      const hint = nextStepHint({ action: 'read_file', path: 'src/app.js' }, ok, 1, route);
      assert.match(hint, /write_file/);
    });

    it('does not offer write_file as the next step when the mode has no write', () => {
      const readOnly = { allowedActions: new Set(['read_file', 'done']) };
      const hint = nextStepHint({ action: 'read_file', path: 'src/app.js' }, ok, 1, readOnly);
      assert.ok(!hint.includes('write_file'));
    });
  });

  describe('recovering from an unparseable turn', () => {
    /** @type {string} */
    let root;

    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-react-')));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export function app() {\n  return 1;\n}\n');
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

    function makeSession(client) {
      const modes = new PermissionModes({ initial: { autoEdit: true } });
      return new AgentSession({
        client: /** @type {any} */ (client),
        model: 'qwen3.5:0.8b',
        capability: TIER_B,
        gate: new PermissionGate({
          workspaceRoot: root,
          modes,
          auditLog: new AuditLog(root),
          confirm: async () => true,
        }),
        workspaceRoot: root,
        thinkingCapacity: 'medium',
        sessionId: '1',
      });
    }

    it('keeps the last observation so the model can retry without re-reading', async () => {
      // Observed on `qwen3.5:0.8b`: read the file, emit write_file with no "code",
      // and the following turn arrived with the file contents erased — so the model
      // read the same file again and the session died as "repeating". The bad reply
      // says nothing about the world; the observation must survive it.
      const client = scriptedClient([
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'write_file', path: 'src/app.js' }), // no `code`
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 2;\n}\n' }),
        json({ action: 'done', summary: 'Changed the return value.' }),
      ]);

      const result = await makeSession(client).run('Make app() return 2', { mode: 'agent' });

      const afterFailure = client.prompts[2];
      assert.match(afterFailure, /return 1/, 'the file contents were dropped after the parse failure');
      assert.match(afterFailure, /COMPLETE new contents/, 'no correction was offered');

      assert.strictEqual(result.stopReason, 'done');
      assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8').includes('return 2'), true);
    });

    it('does not lose the task hint when a reply fails to parse', async () => {
      const client = scriptedClient([
        json({ action: 'read_file', path: 'src/app.js' }),
        'not json at all',
        json({ action: 'done', summary: 'Done.' }),
      ]);

      await makeSession(client).run('Look at the file', { mode: 'agent' });

      // The read hint and the parse correction are independent and must coexist.
      assert.match(client.prompts[2], /full contents of src\/app\.js/);
      assert.match(client.prompts[2], /no JSON at all/);
    });

    it('lets a refused write be retried without the repeat guard stopping it', async () => {
      const commented = '// function app() {\n//   return 1;\n// }\n// export {};\n';
      const client = scriptedClient([
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'write_file', path: 'src/app.js', code: commented }), // refused
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 2;\n}\n' }),
        json({ action: 'done', summary: 'Changed it.' }),
      ]);

      const result = await makeSession(client).run('Make app() return 2', { mode: 'agent' });

      assert.strictEqual(result.stopReason, 'done', 'the corrected retry was punished as a repeat');
      assert.match(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), /return 2/);
    });

    it('still stops a model that cannot produce valid content at all', async () => {
      const commented = '// function app() {\n//   return 1;\n// }\n// export {};\n';
      const client = scriptedClient([json({ action: 'write_file', path: 'src/app.js', code: commented })]);

      const result = await makeSession(client).run('Make app() return 2', { mode: 'agent' });

      // Forgiveness is bounded — this must not run until the step budget is gone.
      assert.strictEqual(result.stopReason, 'repeating');
      assert.match(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), /return 1/);
    });

    it('refuses a write that pastes the loop\'s own status message into the file', async () => {
      // Live on `llama3.2:1b`, which left this on disk:
      //   function greet(name) { ... } Updated src/greet.js (+1 / -6 lines).
      const client = scriptedClient([
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 2;\n}\n' }),
        json({
          action: 'write_file',
          path: 'src/app.js',
          code: 'export function app() {\n  return 3;\n}\nUpdated src/app.js (+1 / -1 lines).\n',
        }),
        json({ action: 'done', summary: 'stopping' }),
      ]);

      await makeSession(client).run('Edit it twice', { mode: 'agent' });

      const onDisk = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
      assert.ok(!onDisk.includes('Updated src/app.js'), 'a status message was written into the file');
      assert.match(onDisk, /return 2/, 'the earlier legitimate write was lost');
    });

    it('does not mistake real file content for an echoed status message', async () => {
      // A read's observation *is* the file, and the write that follows is supposed to
      // contain it. Treating that as contamination would block every ordinary edit.
      const client = scriptedClient([
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 2;\n}\n' }),
        json({ action: 'done', summary: 'done' }),
      ]);

      const result = await makeSession(client).run('Make app() return 2', { mode: 'agent' });

      assert.strictEqual(result.stopReason, 'done');
      assert.match(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), /return 2/);
    });

    it('numbers steps by work done, not by turns consumed', async () => {
      const client = scriptedClient([
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'write_file', path: 'src/app.js' }), // unparseable
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 2;\n}\n' }),
        json({ action: 'done', summary: 'ok' }),
      ]);

      /** @type {number[]} */
      const numbers = [];
      await makeSession(client).run('Make app() return 2', {
        mode: 'agent',
        onEvent: (event) => {
          if (event.type === 'action') numbers.push(event.step);
        },
      });

      // The unparseable turn produced no step, so the write is 2 and not 3.
      assert.deepStrictEqual(numbers, [1, 2]);
    });
  });
});
