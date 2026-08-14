'use strict';

/**
 * What the agent already has, and what the loop does when it asks for it again.
 *
 * The reproduction at the bottom is the `qwen3.5:0.8b` session shape verbatim: three
 * identical `list_files` calls, which on 0.7.0 ended the run at two steps with nothing
 * written. It happened seven times in one evaluation.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { WorkingSet, isRecon, shortPath } = require('../../app/agent/workingSet');
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

const ok = (observation) => ({ ok: true, observation });

describe('workingSet', () => {
  describe('recording', () => {
    it('remembers a file it read', () => {
      const set = new WorkingSet();
      set.record({ action: 'read_file', path: 'src/App.jsx' }, ok('contents'), 1);

      assert.strictEqual(set.hasRead('src/App.jsx'), true);
      assert.match(set.render(), /ALREADY READ.*src\/App\.jsx/s);
    });

    it('counts a file it wrote as a file it has', () => {
      // The pair that cost the 4B session most: write App.jsx, then immediately read it
      // back. The model sent those contents — it does not need them returned.
      const set = new WorkingSet();
      set.record({ action: 'write_file', path: 'src/App.jsx', code: 'x' }, ok('written'), 1);

      assert.strictEqual(set.hasRead('src/App.jsx'), true);
      assert.match(set.render(), /ALREADY WRITTEN.*src\/App\.jsx/s);
    });

    it('treats the root listed as "." and "" as one folder', () => {
      const set = new WorkingSet();
      set.record({ action: 'list_files', path: '' }, ok('a\nb'), 1);
      set.record({ action: 'list_files', path: '.' }, ok('a\nb'), 2);

      assert.strictEqual(set.timesListed('.'), 2, 'the root was tracked as two different folders');
    });

    it('stops claiming a deleted file still exists', () => {
      const set = new WorkingSet();
      set.record({ action: 'read_file', path: 'src/old.js' }, ok('contents'), 1);
      set.record({ action: 'delete_file', path: 'src/old.js' }, ok('deleted'), 2);

      assert.strictEqual(set.hasRead('src/old.js'), false);
      assert.match(set.render(), /DELETED.*src\/old\.js/s);
      assert.doesNotMatch(set.render(), /ALREADY READ/);
    });

    it('records a failed step as a struggle rather than as something it has', () => {
      const set = new WorkingSet();
      set.record({ action: 'read_file', path: 'src/nope.js' }, { ok: false, observation: 'ENOENT: no such file' }, 1);

      assert.strictEqual(set.hasRead('src/nope.js'), false);
      assert.match(set.render({ includeStruggles: true }), /went wrong.*ENOENT/s);
    });

    it('keeps the folder a command ran in, because that is what made it work', () => {
      const set = new WorkingSet();
      set.record({ action: 'run_script', command: 'npm install', cwd: 'todo-glass-app' }, ok('added 24'), 1);

      assert.match(set.render(), /npm install.*in todo-glass-app/s);
    });

    it('renders nothing at all before anything has happened', () => {
      assert.strictEqual(new WorkingSet().render(), '');
    });

    it('elides a long list rather than pasting a whole workspace into every turn', () => {
      const set = new WorkingSet();
      for (let i = 0; i < 30; i += 1) {
        set.record({ action: 'read_file', path: `src/file${i}.js` }, ok('x'), i + 1);
      }

      const rendered = set.render();
      assert.match(rendered, /\+20 more/);
      assert.ok(rendered.length < 900, `the block grew without bound (${rendered.length} chars)`);
    });
  });

  describe('isRecon', () => {
    it('counts read-only lookups and nothing else', () => {
      for (const action of ['read_file', 'list_files', 'search_workspace']) {
        assert.strictEqual(isRecon(action), true, `${action} should be recon`);
      }
      // Repeating one of these can install packages or start a server. "It was only a
      // repeat" is no comfort there.
      for (const action of ['write_file', 'run_script', 'delete_file', 'run_tests']) {
        assert.strictEqual(isRecon(action), false, `${action} must not be treated as recon`);
      }
    });
  });

  describe('shortPath', () => {
    it('trims from the front, because the filename is the informative end', () => {
      const long = `src/${'deeply/'.repeat(20)}App.jsx`;
      assert.ok(shortPath(long).length <= 81);
      assert.match(shortPath(long), /App\.jsx$/);
    });
  });

  describe('in the loop', () => {
    /** @type {string} */
    let root;

    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-ws-')));
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

    it('answers a repeated listing instead of ending the session', async () => {
      // The 0.7.0 `qwen3.5:0.8b` session, verbatim: list, list, list. It ended four
      // separate runs at exactly two steps with nothing written, seven times across the
      // evaluation. The third call must now be answered, not fatal.
      const client = scriptedClient([
        json({ action: 'list_files', path: '.' }),
        json({ action: 'list_files', path: '.' }),
        json({ action: 'list_files', path: '.' }),
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 2;\n}\n' }),
        json({ action: 'done', summary: 'Changed the return value.' }),
      ]);

      const result = await makeSession(client).run('Make app() return 2', { mode: 'agent' });

      assert.notStrictEqual(result.stopReason, 'repeating', 'a repeated listing still ended the run');
      assert.strictEqual(result.stopReason, 'done');
      assert.match(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), /return 2/);
    });

    it('tells the model to write, and hands back what it already had', async () => {
      const client = scriptedClient([
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 2;\n}\n' }),
        json({ action: 'done', summary: 'Done.' }),
      ]);

      await makeSession(client).run('Make app() return 2', { mode: 'agent' });

      const afterSubstitution = client.prompts[3];
      assert.match(afterSubstitution, /STOP/, 'the substitution said nothing forceful');
      assert.match(afterSubstitution, /write_file/, 'it did not name the next move');
      // The content, not just the assertion about it — the reason a hint alone failed
      // is that it described something the model could no longer see.
      assert.match(afterSubstitution, /return 1/, 'the file it already had was not handed back');
    });

    it('still stops a model that ignores the substitution', async () => {
      // Forgiveness is capped at one. A model that repeats with the content and an
      // instruction both in front of it is stuck, not disoriented.
      const client = scriptedClient([json({ action: 'list_files', path: '.' })]);

      const result = await makeSession(client).run('Do something', { mode: 'agent' });

      assert.strictEqual(result.stopReason, 'repeating');
    });

    it('does not forgive a repeated command, which can cost real time', async () => {
      const client = scriptedClient([json({ action: 'run_script', command: 'npm install' })]);

      const result = await makeSession(client).run('Install the dependencies', { mode: 'agent' });

      assert.strictEqual(result.stopReason, 'repeating', 'a repeated run_script was forgiven');
    });

    it('carries exactly one working-set block on Tier A, however long the run', async () => {
      // Tier A keeps the whole exchange in `messages`, so a block pushed each turn would
      // leave a trail of stale copies — each accurate when written and contradicted by
      // the next one down. There must be one, and it must be the current one.
      const calls = [];
      const client = {
        prompts: [],
        async chat(body) {
          this.prompts.push(body.messages);
          const reply = calls.shift();
          return { message: reply || { content: 'All done.' } };
        },
      };
      for (const file of ['src/app.js', 'src/app.js', 'src/app.js']) {
        calls.push({ tool_calls: [{ function: { name: 'read_file', arguments: { path: file } } }] });
      }

      const session = new AgentSession({
        client: /** @type {any} */ (client),
        model: 'qwen3.5:4b',
        capability: { tier: 'A', strategy: 'native', label: 'Agentic', model: 'qwen3.5:4b' },
        gate: new PermissionGate({
          workspaceRoot: root,
          modes: new PermissionModes({ initial: { autoEdit: true } }),
          auditLog: new AuditLog(root),
          confirm: async () => true,
        }),
        workspaceRoot: root,
        thinkingCapacity: 'medium',
        sessionId: '1',
      });
      await session.run('Look at the file', { mode: 'agent' });

      const last = client.prompts[client.prompts.length - 1];
      const blocks = last.filter((m) => typeof m.content === 'string' && m.content.includes('WHAT YOU ALREADY HAVE'));
      assert.strictEqual(blocks.length, 1, `the block accumulated (${blocks.length} copies)`);
      assert.strictEqual(last[last.length - 1], blocks[0], 'the block drifted away from the decision');
      assert.match(blocks[0].content, /src\/app\.js/);
    });

    it('puts what the agent holds into the next prompt', async () => {
      const client = scriptedClient([
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'done', summary: 'Read it.' }),
      ]);

      await makeSession(client).run('Look at the file', { mode: 'agent' });

      assert.match(client.prompts[1], /ALREADY READ/);
      assert.match(client.prompts[1], /src\/app\.js/);
    });
  });
});
