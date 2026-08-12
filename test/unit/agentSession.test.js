'use strict';

/**
 * End-to-end agent sessions against a scripted mock Ollama and a real temp
 * workspace. These exercise the whole Phase 4 stack — router, loop, registry,
 * tools, permission gate, change set, memory — without needing a model.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentSession, ChangeSet } = require('../../app/agent/agentSession');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');

const TIER_B = { tier: 'B', strategy: 'react', label: 'Lite', model: 'llama3.2:1b' };
const TIER_A = { tier: 'A', strategy: 'native', label: 'Agentic', model: 'qwen2.5-coder:7b' };

/**
 * Mock Ollama replaying scripted assistant messages in order.
 *
 * @param {Array<string | object>} replies Strings become `message.content`;
 *   objects are used as the whole `message` (for native tool calls).
 */
function scriptedClient(replies) {
  return {
    calls: 0,
    prompts: /** @type {string[]} */ ([]),
    bodies: /** @type {any[]} */ ([]),
    async chat(body) {
      this.bodies.push(body);
      this.prompts.push(JSON.stringify(body.messages));
      const reply = replies[Math.min(this.calls, replies.length - 1)];
      this.calls += 1;
      return { message: typeof reply === 'string' ? { content: reply } : reply };
    },
  };
}

/** @param {object} action */
const json = (action) => JSON.stringify(action);

describe('AgentSession', () => {
  /** @type {string} */
  let root;
  /** @type {object[]} */
  let prompts;

  /**
   * @param {object} opts
   */
  function makeSession(opts = {}) {
    const modes = new PermissionModes({
      initial: { autoEdit: opts.autoEdit !== false, autoApproveScripts: Boolean(opts.autoApproveScripts) },
    });
    prompts = [];
    const gate = new PermissionGate({
      workspaceRoot: root,
      modes,
      auditLog: new AuditLog(root),
      confirm: async (request) => {
        prompts.push(request);
        return opts.answer !== false;
      },
    });

    return new AgentSession({
      client: /** @type {any} */ (opts.client),
      model: 'test-model',
      capability: opts.capability || TIER_B,
      gate,
      workspaceRoot: root,
      thinkingCapacity: opts.thinkingCapacity || 'medium',
      sessionId: '1',
    });
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-agent-')));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'export function app() {\n  return 1;\n}\n');
    fs.writeFileSync(path.join(root, 'src', 'old.js'), 'export const legacy = true;\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# Test project\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe('Ask mode', () => {
    it('invokes zero tools, however task-like the request sounds', async () => {
      // The acceptance criterion: Ask never triggers a tool call, even when the
      // phrasing reads as an instruction to act.
      const client = scriptedClient(['You would add the validation in src/app.js.']);
      const session = makeSession({ client });

      const result = await session.run('Delete src/old.js and rewrite src/app.js right now', { mode: 'ask' });

      assert.strictEqual(result.steps.length, 0);
      assert.strictEqual(result.stopReason, 'answered');
      assert.strictEqual(client.calls, 1, 'exactly one call, no loop');
      assert.strictEqual(result.changeSet.isEmpty(), true);
      // The file is untouched.
      assert.ok(fs.existsSync(path.join(root, 'src', 'old.js')));
    });

    it('offers no tools in the request body', async () => {
      const client = scriptedClient(['An answer.']);
      await makeSession({ client, capability: TIER_A, thinkingCapacity: 'low' }).run('Explain this', { mode: 'ask' });
      assert.strictEqual(client.bodies[0].tools, undefined);
    });
  });

  describe('Plan mode', () => {
    it('explores read-only and produces a checklist without touching disk', async () => {
      const client = scriptedClient([
        json({ thought: 'look around', action: 'list_files' }),
        json({ thought: 'read it', action: 'read_file', path: 'src/app.js' }),
        json({
          action: 'done',
          summary: '1. Add validation to src/app.js\n2. Delete src/old.js\n3. Run the tests',
        }),
      ]);
      const session = makeSession({ client });

      const result = await session.run('Add validation and clean up', { mode: 'plan' });

      assert.deepStrictEqual(result.plan, [
        'Add validation to src/app.js',
        'Delete src/old.js',
        'Run the tests',
      ]);
      assert.strictEqual(result.changeSet.isEmpty(), true);
      assert.ok(fs.existsSync(path.join(root, 'src', 'old.js')), 'plan mode deleted a file');
    });

    it('refuses a mutation at the executor even if the loop produces one', async () => {
      // Defense in depth: the tool is not offered, the parser rejects it, and the
      // executor refuses it. This asserts the last of the three.
      const client = scriptedClient([
        json({ action: 'write_file', path: 'src/app.js', code: 'hacked' }),
        json({ action: 'done', summary: '1. Do the thing' }),
      ]);
      const session = makeSession({ client, autoEdit: true });

      await session.run('Change the file', { mode: 'plan' });

      assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8').includes('hacked'), false);
      assert.strictEqual(prompts.length, 0, 'no permission prompt — it never got that far');
    });
  });

  describe('Agent mode', () => {
    it('completes a multi-file task including a delete and a script', async () => {
      // The headline acceptance criterion, minus the real model: find a file it was
      // not given, edit two files, delete one, and run a command.
      const client = scriptedClient([
        json({ thought: 'find the files', action: 'list_files' }),
        json({ thought: 'read the entry point', action: 'read_file', path: 'src/app.js' }),
        json({ thought: 'update it', action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 2;\n}\n' }),
        json({ thought: 'add a helper', action: 'write_file', path: 'src/helper.js', code: 'export const help = true;\n' }),
        json({ thought: 'drop the legacy file', action: 'delete_file', path: 'src/old.js' }),
        json({ thought: 'install deps', action: 'run_script', command: 'node --version' }),
        json({ action: 'done', summary: 'Updated app.js, added helper.js, removed old.js.' }),
      ]);
      const session = makeSession({ client, autoEdit: true, autoApproveScripts: true });

      const result = await session.run('Modernize the app and remove the legacy file');

      assert.strictEqual(result.stopReason, 'done');
      assert.match(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), /return 2/);
      assert.ok(fs.existsSync(path.join(root, 'src', 'helper.js')));
      assert.ok(!fs.existsSync(path.join(root, 'src', 'old.js')), 'delete did not happen');

      const changes = result.changeSet.list();
      assert.strictEqual(changes.length, 3, 'one grouped change set for the whole session');
      assert.deepStrictEqual(
        changes.map((c) => `${c.kind} ${c.path}`).sort(),
        ['create src/helper.js', 'delete src/old.js', 'edit src/app.js']
      );
      assert.strictEqual(result.changeSet.commands.length, 1);
    });

    it('blocks every mutation pending approval in the default mode', async () => {
      const client = scriptedClient([
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 0;\n}\n' }),
        json({ action: 'delete_file', path: 'src/old.js' }),
        json({ action: 'done', summary: 'Stopped.' }),
      ]);
      const session = makeSession({ client, autoEdit: false, answer: false });

      const result = await session.run('Change things');

      assert.strictEqual(prompts.length, 2, 'both mutations asked for approval');
      assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8').includes('return 0'), false);
      assert.ok(fs.existsSync(path.join(root, 'src', 'old.js')));
      assert.strictEqual(result.changeSet.isEmpty(), true);
    });

    it('applies mutations without prompting under auto-edit', async () => {
      const client = scriptedClient([
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 42;\n}\n' }),
        json({ action: 'done', summary: 'Done.' }),
      ]);
      await makeSession({ client, autoEdit: true }).run('Change it');

      assert.strictEqual(prompts.length, 0);
      assert.match(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), /return 42/);
    });

    it('refuses a truncated write that would obliterate a file', async () => {
      // Observed live: llama3.2:1b emitted `"code": "{"` for an 80-byte source
      // file and the write went through, leaving a 1-byte file.
      const original = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8');
      const client = scriptedClient([
        json({ action: 'write_file', path: 'src/app.js', code: '{' }),
        json({ action: 'done', summary: 'Stopped.' }),
      ]);

      const result = await makeSession({ client, autoEdit: true }).run('Update the app');

      assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), original, 'file was destroyed');
      assert.strictEqual(result.steps[0].result.ok, false);
      assert.strictEqual(result.steps[0].result.error, 'SUSPICIOUS_TRUNCATION');
      // The refusal has to teach the model what to send instead.
      assert.match(result.steps[0].result.observation, /COMPLETE updated file/);
    });

    it('still allows a legitimate substantial rewrite', async () => {
      const client = scriptedClient([
        json({ action: 'write_file', path: 'src/app.js', code: 'export function app() {\n  return 99;\n}\n' }),
        json({ action: 'done', summary: 'Done.' }),
      ]);
      const result = await makeSession({ client, autoEdit: true }).run('Rewrite it');
      assert.strictEqual(result.steps[0].result.ok, true);
    });

    it('feeds a refusal back so the model can adapt', async () => {
      const client = scriptedClient([
        json({ action: 'write_file', path: '../escape.js', code: 'x' }),
        json({ action: 'done', summary: 'Could not do that.' }),
      ]);
      const result = await makeSession({ client, autoEdit: true }).run('Escape the workspace');

      const refusal = result.steps[0];
      assert.strictEqual(refusal.result.ok, false);
      assert.match(refusal.result.observation, /outside the workspace/i);
      assert.strictEqual(result.stopReason, 'done');
    });
  });

  describe('resilience', () => {
    it('ends cleanly when the model never produces valid JSON', async () => {
      const client = scriptedClient(['I would probably edit the file.']);
      const result = await makeSession({ client }).run('Do something');

      assert.strictEqual(result.stopReason, 'unparseable');
      // The user sees what the model actually said.
      assert.match(result.summary, /edit the file/);
    });

    it('recovers when a single turn is malformed', async () => {
      const client = scriptedClient([
        'oops not json',
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'done', summary: 'Recovered.' }),
      ]);
      const result = await makeSession({ client }).run('Read the app');

      assert.strictEqual(result.stopReason, 'done');
      assert.strictEqual(result.steps.length, 1);
    });

    it('stops a model that repeats the same action forever', async () => {
      // The characteristic small-model failure: a plausible action, repeated.
      const client = scriptedClient([json({ action: 'read_file', path: 'src/app.js' })]);
      const result = await makeSession({ client }).run('Read it');

      assert.strictEqual(result.stopReason, 'repeating');
      assert.ok(result.steps.length < 8, `ran ${result.steps.length} steps before noticing`);
    });

    it('honors the step budget', async () => {
      const client = scriptedClient([
        json({ action: 'list_files' }),
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'read_file', path: 'README.md' }),
        json({ action: 'search_workspace', query: 'app' }),
        json({ action: 'search_workspace', query: 'legacy' }),
        json({ action: 'read_file', path: 'src/old.js' }),
        json({ action: 'list_files', path: 'src' }),
        json({ action: 'search_workspace', query: 'export' }),
        json({ action: 'search_workspace', query: 'function' }),
        json({ action: 'search_workspace', query: 'return' }),
      ]);
      const result = await makeSession({ client, thinkingCapacity: 'low' }).run('Explore forever');

      // Low on Tier B is a 4-step budget.
      assert.ok(result.steps.length <= 4, `ran ${result.steps.length} steps against a budget of 4`);
      assert.strictEqual(result.stopReason, 'budget');
    });

    it('survives a tool that throws', async () => {
      const client = scriptedClient([
        json({ action: 'read_file', path: 'src/app.js' }),
        json({ action: 'done', summary: 'ok' }),
      ]);
      const session = makeSession({ client });
      session.gate.requestRead = async () => {
        throw new Error('gate exploded');
      };

      const result = await session.run('Read it');
      assert.strictEqual(result.steps[0].result.ok, false);
      assert.match(result.steps[0].result.observation, /gate exploded/);
    });

    it('can be cancelled', async () => {
      const session = makeSession({
        client: scriptedClient([json({ action: 'list_files' })]),
      });
      const promise = session.run('Explore');
      session.cancel();
      const result = await promise;
      assert.ok(['cancelled', 'repeating', 'budget'].includes(result.stopReason));
    });
  });

  describe('Tier A native loop', () => {
    it('executes tool calls and finishes on a plain reply', async () => {
      const client = scriptedClient([
        { content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'src/app.js' } } }] },
        {
          content: '',
          tool_calls: [
            {
              function: {
                name: 'write_file',
                arguments: { path: 'src/app.js', code: 'export function app() {\n  return 7;\n}\n' },
              },
            },
          ],
        },
        { content: 'Updated src/app.js.' },
      ]);
      const result = await makeSession({ client, capability: TIER_A, autoEdit: true, thinkingCapacity: 'low' }).run('Update the app');

      assert.strictEqual(result.stopReason, 'done');
      assert.match(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), /return 7/);
      assert.strictEqual(result.summary, 'Updated src/app.js.');
    });

    it('passes tool schemas on the request', async () => {
      const client = scriptedClient([{ content: 'done' }]);
      await makeSession({ client, capability: TIER_A, thinkingCapacity: 'low' }).run('Something');
      assert.ok(Array.isArray(client.bodies[0].tools));
      assert.ok(client.bodies[0].tools.length > 0);
    });
  });
});

describe('ChangeSet', () => {
  it('groups repeated edits to one file, keeping the original before state', () => {
    const set = new ChangeSet();
    set.record({ kind: 'edit', path: 'a.js', before: 'v1', after: 'v2', added: 1, removed: 1 });
    set.record({ kind: 'edit', path: 'a.js', before: 'v2', after: 'v3', added: 1, removed: 1 });

    const changes = set.list();
    assert.strictEqual(changes.length, 1, 'the user reviews the net effect, not each draft');
    assert.strictEqual(changes[0].before, 'v1');
    assert.strictEqual(changes[0].after, 'v3');
  });

  it('keeps a file created then edited marked as a creation', () => {
    const set = new ChangeSet();
    set.record({ kind: 'create', path: 'new.js', before: null, after: 'v1', added: 1, removed: 0 });
    set.record({ kind: 'edit', path: 'new.js', before: 'v1', after: 'v2', added: 1, removed: 1 });
    assert.strictEqual(set.list()[0].kind, 'create');
  });

  it('describes a mixed session', () => {
    const set = new ChangeSet();
    set.record({ kind: 'create', path: 'a.js', before: null, after: 'x', added: 1, removed: 0 });
    set.record({ kind: 'delete', path: 'b.js', before: 'y', after: null, added: 0, removed: 1 });
    set.recordCommand({ command: 'npm test', exitCode: 0, ok: true });

    const description = set.describe();
    assert.match(description, /created a\.js/);
    assert.match(description, /deleted b\.js/);
    assert.match(description, /1 command/);
  });

  it('reports empty for an untouched session', () => {
    assert.strictEqual(new ChangeSet().isEmpty(), true);
    assert.strictEqual(new ChangeSet().describe(), 'No files were changed.');
  });
});

describe('appendUnfinishedNote', () => {
  const { appendUnfinishedNote } = require('../../app/agent/agentSession');

  it('contradicts a summary that claims a declined delete happened', () => {
    // Live on `gemma4:e2b`: the user declined the confirmation and the summary still
    // reported the file as deleted.
    const steps = [
      { action: { action: 'delete_file', path: 'src/obsolete.js' }, result: { ok: true, observation: 'ok' } },
      {
        action: { action: 'delete_file', path: 'src/obsolete.js' },
        result: { ok: false, observation: 'src/obsolete.js was not deleted: You declined this change.' },
      },
    ];

    const out = appendUnfinishedNote('Task complete. src/obsolete.js was deleted.', steps);

    assert.match(out, /These steps did not complete:/);
    assert.match(out, /was not deleted: You declined this change\./);
  });

  it('leaves a clean session untouched', () => {
    const steps = [{ action: { action: 'write_file', path: 'a.js' }, result: { ok: true, observation: 'ok' } }];
    assert.strictEqual(appendUnfinishedNote('All done.', steps), 'All done.');
  });

  it('reports one line per target however many times it was retried', () => {
    const failure = { ok: false, observation: 'Refused: truncated content.' };
    const steps = [
      { action: { action: 'write_file', path: 'a.js' }, result: failure },
      { action: { action: 'write_file', path: 'a.js' }, result: failure },
      { action: { action: 'write_file', path: 'a.js' }, result: failure },
    ];

    const out = appendUnfinishedNote('Edited a.js.', steps);
    assert.strictEqual(out.split('Refused: truncated content.').length - 1, 1);
  });

  it('survives a session with no steps at all', () => {
    assert.strictEqual(appendUnfinishedNote('Nothing to do.', []), 'Nothing to do.');
    assert.strictEqual(appendUnfinishedNote('Nothing to do.', undefined), 'Nothing to do.');
  });
});

describe('TODO-driven sessions', () => {
  const os = require('os');
  const TIER_TODO = {
    tier: 'B',
    strategy: 'react',
    label: 'Lite',
    model: 'qwen3.5:4b',
    canPlanTodos: true,
    supportsThinking: true,
  };

  let todoRoot;

  function todoSession(client) {
    const modes = new PermissionModes({ initial: { autoEdit: true } });
    return new AgentSession({
      client,
      model: 'qwen3.5:4b',
      capability: TIER_TODO,
      gate: new PermissionGate({
        workspaceRoot: todoRoot,
        modes,
        auditLog: new AuditLog(todoRoot),
        confirm: async () => true,
      }),
      workspaceRoot: todoRoot,
      thinkingCapacity: 'medium',
      sessionId: '1',
    });
  }

  beforeEach(() => {
    todoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-todo-')));
    fs.mkdirSync(path.join(todoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(todoRoot, 'src', 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(todoRoot, 'src', 'b.js'), 'export const b = 1;\n');
  });

  afterEach(() => fs.rmSync(todoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  it('splits a multi-part request and finishes each item before the next', async () => {
    const client = scriptedClient([
      // The planning call.
      '1. Update src/a.js\n2. Update src/b.js',
      // Item 1.
      json({ action: 'write_file', path: 'src/a.js', code: 'export const a = 2;\n' }),
      json({ action: 'done', summary: 'a.js updated' }),
      // Item 2.
      json({ action: 'write_file', path: 'src/b.js', code: 'export const b = 2;\n' }),
      json({ action: 'done', summary: 'b.js updated' }),
    ]);

    const events = [];
    const result = await todoSession(client).run('Update a and also update b', {
      mode: 'agent',
      onEvent: (e) => events.push(e),
    });

    assert.deepStrictEqual(
      result.todos.map((t) => t.status),
      ['done', 'done']
    );
    assert.strictEqual(result.stopReason, 'done');
    assert.match(fs.readFileSync(path.join(todoRoot, 'src', 'a.js'), 'utf8'), /a = 2/);
    assert.match(fs.readFileSync(path.join(todoRoot, 'src', 'b.js'), 'utf8'), /b = 2/);

    const todoEvent = events.find((e) => e.type === 'todo');
    assert.deepStrictEqual(todoEvent.items, ['Update src/a.js', 'Update src/b.js']);
  });

  it('reports progress as it goes, not only at the end', async () => {
    const client = scriptedClient([
      '1. Update src/a.js\n2. Update src/b.js',
      json({ action: 'write_file', path: 'src/a.js', code: 'export const a = 2;\n' }),
      json({ action: 'done', summary: 'a.js updated' }),
      json({ action: 'write_file', path: 'src/b.js', code: 'export const b = 2;\n' }),
      json({ action: 'done', summary: 'b.js updated' }),
    ]);

    const events = [];
    await todoSession(client).run('Update a and also update b', {
      mode: 'agent',
      onEvent: (e) => events.push(e),
    });

    const statuses = events
      .filter((e) => e.type === 'todo-item' || e.type === 'todo-item-done')
      .map((e) => e.items.map((item) => item.status).join(','));

    // The point is the middle of the run: item 1 finished while item 2 was still to
    // come. A UI that only sees the final state cannot show that.
    assert.deepStrictEqual(statuses, [
      'active,pending',
      'done,active',
      'done,active',
      'done,done',
    ]);
  });

  it('snapshots the checklist so a later item cannot alter an earlier event', async () => {
    const client = scriptedClient([
      '1. Update src/a.js\n2. Update src/b.js',
      json({ action: 'done', summary: 'nothing to do' }),
      json({ action: 'done', summary: 'nothing to do' }),
    ]);

    const events = [];
    await todoSession(client).run('Update a and also update b', {
      mode: 'agent',
      onEvent: (e) => events.push(e),
    });

    const first = events.find((e) => e.type === 'todo-item-done');
    assert.strictEqual(first.items[1].status, 'active', 'the first event was mutated by later progress');
  });

  it('shows the model only the item it is working on', async () => {
    const client = scriptedClient([
      '1. Update src/a.js\n2. Update src/b.js',
      json({ action: 'done', summary: 'nothing to do' }),
      json({ action: 'done', summary: 'nothing to do' }),
    ]);

    await todoSession(client).run('Update a and also update b', { mode: 'agent' });

    // The first item's prompt must name item 1 as the current one, not item 2.
    const firstItemPrompt = client.prompts[1];
    assert.match(firstItemPrompt, /do only item 1/);
    assert.ok(!/do only item 2/.test(firstItemPrompt));
  });

  it('records an item whose work landed but never closed as done, with a caveat', async () => {
    const client = scriptedClient([
      '1. Update src/a.js\n2. Update src/b.js',
      // Item 1 writes correctly, then re-reads "to verify" until the repeat guard
      // stops it — reproduced on qwen3.5:2b in three consecutive runs.
      json({ action: 'write_file', path: 'src/a.js', code: 'export const a = 2;\n' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      // Item 2 is ordinary.
      json({ action: 'write_file', path: 'src/b.js', code: 'export const b = 2;\n' }),
      json({ action: 'done', summary: 'b.js updated' }),
    ]);

    const result = await todoSession(client).run('Update a and also update b', { mode: 'agent' });

    assert.strictEqual(result.todos[0].status, 'done-with-warning');
    assert.match(result.todos[0].outcome, /never closed the item off/);
    // The edit really did land — that is what separates this from a failure.
    assert.match(fs.readFileSync(path.join(todoRoot, 'src', 'a.js'), 'utf8'), /a = 2/);
    assert.match(result.summary, /2 of 2 item\(s\) completed/);
    assert.match(result.summary, /1 of those changed files without the model confirming/);
  });

  it('does not take the model\'s word for an item whose actions all failed', async () => {
    // Observed on gemma4:e2b: the user declined the delete, the file stayed, and the
    // model closed the item with `done`. The checklist read "Delete the obsolete file
    // — done" for a file that is still on disk.
    const client = scriptedClient([
      '1. Update src/a.js\n2. Delete src/gone.js',
      json({ action: 'write_file', path: 'src/a.js', code: 'export const a = 2;\n' }),
      json({ action: 'done', summary: 'a.js updated' }),
      json({ action: 'delete_file', path: 'src/nonexistent.js' }),
      json({ action: 'done', summary: 'deleted it' }),
    ]);

    const result = await todoSession(client).run('Update a and delete the old file', { mode: 'agent' });

    assert.strictEqual(result.todos[0].status, 'done');
    assert.strictEqual(result.todos[1].status, 'failed');
    assert.match(result.todos[1].outcome, /reported it finished, but its actions failed/);
  });

  it('still calls a check-only item done when nothing failed', async () => {
    const client = scriptedClient([
      '1. Update src/a.js\n2. Report what src/b.js exports',
      json({ action: 'write_file', path: 'src/a.js', code: 'export const a = 2;\n' }),
      json({ action: 'done', summary: 'a.js updated' }),
      json({ action: 'read_file', path: 'src/b.js' }),
      json({ action: 'done', summary: 'b.js exports b' }),
    ]);

    const result = await todoSession(client).run('Update a and tell me what b exports', { mode: 'agent' });

    assert.strictEqual(result.todos[1].status, 'done');
    assert.strictEqual(result.todos[1].outcome, 'no files changed');
  });

  it('does not soften an item that changed nothing into a caveated success', async () => {
    const client = scriptedClient([
      '1. Update src/a.js\n2. Update src/b.js',
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'done', summary: 'nothing to do' }),
    ]);

    const result = await todoSession(client).run('Update a and also update b', { mode: 'agent' });
    assert.strictEqual(result.todos[0].status, 'failed');
  });

  it('carries on to the next item after one fails', async () => {
    const client = scriptedClient([
      '1. Update src/a.js\n2. Update src/b.js',
      // Item 1 loops on a read and gets stopped.
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      json({ action: 'read_file', path: 'src/a.js' }),
      // Item 2 succeeds.
      json({ action: 'write_file', path: 'src/b.js', code: 'export const b = 2;\n' }),
      json({ action: 'done', summary: 'b.js updated' }),
    ]);

    const result = await todoSession(client).run('Update a and also update b', { mode: 'agent' });

    assert.strictEqual(result.todos[0].status, 'failed');
    assert.strictEqual(result.todos[1].status, 'done', 'a failed item abandoned the rest of the request');
    assert.strictEqual(result.stopReason, 'partial');
  });

  it('does not build a list for a single-part request', async () => {
    const client = scriptedClient([
      '1. Update src/a.js',
      json({ action: 'write_file', path: 'src/a.js', code: 'export const a = 2;\n' }),
      json({ action: 'done', summary: 'done' }),
    ]);

    const result = await todoSession(client).run('Update a', { mode: 'agent' });

    assert.strictEqual(result.todos, undefined, 'a one-item list was run through the TODO path');
    assert.match(fs.readFileSync(path.join(todoRoot, 'src', 'a.js'), 'utf8'), /a = 2/);
  });

  it('never builds a list for a model that cannot keep one', async () => {
    const client = scriptedClient([json({ action: 'done', summary: 'done' })]);
    const modes = new PermissionModes({ initial: { autoEdit: true } });
    const session = new AgentSession({
      client,
      model: 'llama3.2:1b',
      capability: { ...TIER_TODO, canPlanTodos: false },
      gate: new PermissionGate({
        workspaceRoot: todoRoot,
        modes,
        auditLog: new AuditLog(todoRoot),
        confirm: async () => true,
      }),
      workspaceRoot: todoRoot,
      thinkingCapacity: 'medium',
      sessionId: '1',
    });

    const result = await session.run('Update a and also update b', { mode: 'agent' });

    assert.strictEqual(result.todos, undefined);
    // The planning call must not have happened at all.
    assert.strictEqual(client.calls, 1);
  });
});
