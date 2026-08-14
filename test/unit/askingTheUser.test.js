'use strict';

/**
 * The 0.7.0 recovery path, end to end against a scripted Ollama and a real workspace.
 *
 * Three separate mechanisms meet in `AgentSession` and the interesting properties are
 * all in how they compose, which is why these are here rather than split across the
 * three unit files:
 *
 *  - a request is read before it is routed (`core/commonSense`),
 *  - a failure that repeats escalates and eventually asks (`agent/errorRecovery`),
 *  - what the user answers changes the run and the checklist (`agent/clarification`).
 *
 * The property that matters most is the negative one: **a session with nothing to ask
 * must never block.** Every path is exercised with `onClarify` absent as well as
 * present, because that is the configuration a benchmark, a detached tab, and every
 * pre-0.7.0 caller runs in.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentSession } = require('../../app/agent/agentSession');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');
const { MemoryStore } = require('../../app/core/memoryStore');

const TIER_B = { tier: 'B', strategy: 'react', label: 'Lite', model: 'llama3.2:1b' };

/** @param {Array<string | object>} replies */
function scriptedClient(replies) {
  return {
    calls: 0,
    bodies: /** @type {any[]} */ ([]),
    async chat(body) {
      this.bodies.push(body);
      const reply = replies[Math.min(this.calls, replies.length - 1)];
      this.calls += 1;
      return { message: typeof reply === 'string' ? { content: reply } : reply };
    },
  };
}

const json = (action) => JSON.stringify(action);

describe('asking the user', () => {
  /** @type {string} */
  let root;
  /** @type {object[]} */
  let events;

  function makeSession(opts = {}) {
    const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: true } });
    const gate = new PermissionGate({
      workspaceRoot: root,
      modes,
      auditLog: new AuditLog(root),
      confirm: async () => true,
    });

    return new AgentSession({
      client: /** @type {any} */ (opts.client),
      model: 'test-model',
      capability: TIER_B,
      gate,
      workspaceRoot: root,
      sessionId: '1',
      memory: opts.memory,
      onClarify: opts.onClarify,
    });
  }

  /** @param {object} [options] */
  function run(session, task, options = {}) {
    events = [];
    return session.run(task, { onEvent: (event) => events.push(event), ...options });
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-ask-')));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.js'), 'export function main() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# Test project\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe('reading the request', () => {
    it('opens the file the user meant, not the one they typed', async () => {
      const client = scriptedClient([json({ action: 'read_file', path: 'src/main.js' }), json({ action: 'done' })]);
      const session = makeSession({ client });

      const result = await run(session, 'update mian.js to add a comment');

      const note = events.find((event) => event.type === 'interpretation');
      assert.ok(note, 'the reading was not reported to the panel');
      assert.match(note.note, /mian\.js/);
      assert.match(note.note, /src\/main\.js/);
      // And the summary says so, so a user can disagree with it.
      assert.match(result.summary, /How I read the request/);
    });

    it('records the reading in memory, so the same slip is not re-derived', async () => {
      const memory = new MemoryStore(root, 1);
      const client = scriptedClient([json({ action: 'done' })]);
      const session = makeSession({ client, memory });

      await run(session, 'update mian.js to add a comment');
      await memory.flush();

      assert.ok((await memory.readAll()).some((entry) => entry.includes('mian.js')));
    });

    it('leaves a request that names a real file exactly as it was', async () => {
      const client = scriptedClient([json({ action: 'done' })]);
      const session = makeSession({ client });

      const result = await run(session, 'read src/main.js');
      assert.strictEqual(events.some((event) => event.type === 'interpretation'), false);
      assert.doesNotMatch(result.summary, /How I read the request/);
    });

    it('asks which file when two are equally plausible', async () => {
      fs.writeFileSync(path.join(root, 'src', 'todo.js'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(root, 'src', 'todos.js'), 'export const b = 2;\n');

      /** @type {object | null} */
      let asked = null;
      const client = scriptedClient([json({ action: 'done' })]);
      const session = makeSession({
        client,
        onClarify: async (request) => {
          asked = request;
          return { id: request.id, optionId: request.options[0].id };
        },
      });

      await run(session, 'update todoo.js');

      assert.ok(asked, 'the run did not ask');
      assert.ok(asked.options.length >= 2 && asked.options.length <= 4);
      assert.strictEqual(asked.options.filter((option) => option.recommended).length, 1);
    });

    it('does not ask when there is nobody to ask', async () => {
      fs.writeFileSync(path.join(root, 'src', 'todo.js'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(root, 'src', 'todos.js'), 'export const b = 2;\n');

      const client = scriptedClient([json({ action: 'done' })]);
      const session = makeSession({ client });

      // The assertion is that this resolves at all.
      const result = await run(session, 'update todoo.js');
      assert.ok(result.summary);
    });

    it('stops before starting when the user says stop', async () => {
      fs.writeFileSync(path.join(root, 'src', 'todo.js'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(root, 'src', 'todos.js'), 'export const b = 2;\n');

      const client = scriptedClient([json({ action: 'done' })]);
      const session = makeSession({
        client,
        onClarify: async (request) => ({ id: request.id, cancelled: true }),
      });

      const result = await run(session, 'update todoo.js');

      assert.strictEqual(result.stopReason, 'cancelled');
      assert.strictEqual(client.calls, 0, 'nothing should have been sent to the model');
    });
  });

  describe('a failure that will not go away', () => {
    /** A script that always fails the same way. */
    function failingScript() {
      return json({ action: 'run_script', command: 'node src/broken.js' });
    }

    it('tells the model to change approach when there is nobody to ask', async () => {
      const client = scriptedClient([failingScript(), failingScript(), json({ action: 'done' })]);
      const session = makeSession({ client });

      await run(session, 'run the broken script');

      // The second failure's observation should carry the escalation. It is the only
      // channel back to the model on a Tier B loop.
      const observations = events.filter((event) => event.type === 'observation');
      const escalated = observations.some((event) => /same failure as before/i.test(event.result.observation));
      assert.ok(escalated, 'the repeat was never called out to the model');
    });

    it('asks on the second failure, which is before the loop gives up', async () => {
      // `reactLoop.REPEAT_LIMIT` is 2: the loop ends a run once the model has sent the
      // same action twice. This is the last point at which asking can change anything.
      /** @type {object | null} */
      let asked = null;
      const client = scriptedClient([failingScript(), failingScript(), json({ action: 'done' })]);
      const session = makeSession({
        client,
        onClarify: async (request) => {
          asked = request;
          return { id: request.id, text: 'the entry point is src/main.js, not src/broken.js' };
        },
      });

      const result = await run(session, 'run the broken script');

      assert.ok(asked, 'the run never asked, having failed twice');
      assert.strictEqual(asked.kind, 'error');
      assert.match(result.summary, /What you told me when I asked/);
      assert.match(result.summary, /src\/main\.js, not src\/broken\.js/);
    });

    it('never blocks a run that has nobody to ask', async () => {
      const client = scriptedClient([
        failingScript(),
        failingScript(),
        failingScript(),
        failingScript(),
        json({ action: 'done' }),
      ]);
      const session = makeSession({ client });

      const result = await run(session, 'run the broken script');
      assert.ok(result.summary);
    });

    it('reports what it kept hitting rather than only what it completed', async () => {
      const client = scriptedClient([failingScript(), failingScript(), json({ action: 'done' })]);
      const session = makeSession({ client });

      const result = await run(session, 'run the broken script');
      assert.match(result.summary, /What kept going wrong/);
    });

    it('says nothing extra about a run where nothing went wrong twice', async () => {
      const client = scriptedClient([json({ action: 'read_file', path: 'src/main.js' }), json({ action: 'done' })]);
      const session = makeSession({ client });

      const result = await run(session, 'read the main file');
      assert.doesNotMatch(result.summary, /What kept going wrong/);
    });
  });

  describe('the checklist, when the user changes it mid-run', () => {
    const TIER_A = { tier: 'A', strategy: 'react', label: 'Agentic', model: 'test', canPlanTodos: true };

    /**
     * A session whose model can hold a checklist, so `_runWithTodos` is the path taken.
     *
     * @param {object} opts
     */
    function planningSession(opts) {
      const session = makeSession(opts);
      session.capability = TIER_A;
      return session;
    }

    /**
     * The planner replies with a numbered list, then each item runs its own loop.
     *
     * @param {string[]} items
     * @param {string[]} rest
     */
    function withPlan(items, rest) {
      return scriptedClient([items.map((text, index) => `${index + 1}. ${text}`).join('\n'), ...rest]);
    }

    const failing = () => json({ action: 'run_script', command: 'node src/broken.js' });

    it('records a skip as the user’s decision, not as a failed step', async () => {
      const client = withPlan(
        ['Update src/broken.js', 'Update README.md'],
        [
          failing(),
          failing(),
          json({ action: 'write_file', path: 'README.md', code: '# Updated\n' }),
          json({ action: 'done', summary: 'readme updated' }),
        ]
      );

      const session = planningSession({
        client,
        onClarify: async (request) => {
          const skip = request.options.find((option) => option.effect === 'skip');
          return { id: request.id, optionId: skip.id };
        },
      });

      const result = await run(session, 'update src/broken.js and update README.md');

      assert.strictEqual(result.todos[0].status, 'skipped', 'a step the user closed must not read as failed');
      assert.match(result.summary, /you asked me to skip this one/);
      // And the rest of the list still ran.
      assert.notStrictEqual(result.todos[1].status, 'skipped');
    });

    it('rewords the running item to carry what the user said', async () => {
      const client = withPlan(
        ['Update src/broken.js', 'Update README.md'],
        [
          failing(),
          failing(),
          json({ action: 'done', summary: 'gave up' }),
          json({ action: 'write_file', path: 'README.md', code: '# Updated\n' }),
          json({ action: 'done', summary: 'readme updated' }),
        ]
      );

      const session = planningSession({
        client,
        onClarify: async (request) => ({ id: request.id, text: 'the entry point is src/main.js' }),
      });

      const result = await run(session, 'update src/broken.js and update README.md');

      // The item's text is what a retry is briefed on, what stepGuard checks against,
      // and what the summary reads back.
      assert.match(result.todos[0].text, /the entry point is src\/main\.js/);
      assert.match(result.summary, /The checklist changed while it ran/);
      assert.match(result.summary, /reworded/);
    });

    it('leaves the checklist alone when nothing was asked', async () => {
      const client = withPlan(
        ['Update README.md', 'Update src/main.js'],
        [
          json({ action: 'write_file', path: 'README.md', code: '# One\n' }),
          json({ action: 'done', summary: 'readme' }),
          json({ action: 'write_file', path: 'src/main.js', code: 'export function main() {\n  return 2;\n}\n' }),
          json({ action: 'done', summary: 'main' }),
        ]
      );
      const session = planningSession({ client });

      const result = await run(session, 'update README.md and update src/main.js');
      assert.doesNotMatch(result.summary, /The checklist changed/);
    });
  });
});
