'use strict';

/**
 * Step sessions, end to end, against the React + Vite + Tailwind benchmark that
 * produced them.
 *
 * Every scenario here is one that five local models failed on v0.4.0 with the same
 * result: components written in isolation, `App.jsx` left holding Vite's scaffolded
 * counter demo, and a summary reporting the run as complete.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentSession, ChangeSet } = require('../../app/agent/agentSession');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');
const { MemoryStore } = require('../../app/core/memoryStore');

const TIER_TODO = {
  tier: 'B',
  strategy: 'react',
  label: 'Lite',
  model: 'qwen3.5:4b',
  canPlanTodos: true,
  supportsThinking: true,
};

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

describe('step sessions', function () {
  // Each scenario runs several loops that each write a file and an audit entry. On a
  // synced or spinning disk that comfortably outlives Mocha's default.
  this.timeout(20000);

  /** @type {string} */
  let root;

  function session(client, opts = {}) {
    const modes = new PermissionModes({ initial: { autoEdit: true } });
    return new AgentSession({
      client,
      model: 'qwen3.5:4b',
      capability: TIER_TODO,
      gate: new PermissionGate({
        workspaceRoot: root,
        modes,
        auditLog: new AuditLog(root),
        confirm: async () => true,
      }),
      workspaceRoot: root,
      thinkingCapacity: 'medium',
      sessionId: '1',
      stepSessions: opts.stepSessions !== false,
      memory: opts.memory,
    });
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-steps-')));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'App.jsx'), 'export default function App() {\n  return <h1>Vite</h1>;\n}\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  describe('ChangeSet.since', () => {
    it('reports an edit to a file an earlier step created', () => {
      // `size()` cannot: the map is the same size before and after, so the step that
      // assembles App.jsx from files the scaffold step made looks like it did nothing.
      const changes = new ChangeSet();
      changes.record({ kind: 'create', path: 'src/App.jsx', before: null, after: 'a', added: 1, removed: 0 });
      const mark = changes.revision;

      changes.record({ kind: 'edit', path: 'src/App.jsx', before: 'a', after: 'b', added: 1, removed: 1 });

      assert.strictEqual(changes.size(), 1, 'the map did grow, so size() would have been enough');
      assert.deepStrictEqual(
        changes.since(mark).map((c) => c.path),
        ['src/App.jsx']
      );
    });

    it('reports nothing when nothing happened since the mark', () => {
      const changes = new ChangeSet();
      changes.record({ kind: 'create', path: 'a.js', before: null, after: 'a', added: 1, removed: 0 });
      assert.deepStrictEqual(changes.since(changes.revision), []);
    });
  });

  it('shows a step what the earlier steps wrote, not just that they finished', async () => {
    const client = scriptedClient([
      '1. Create src/hooks/useTodos.js\n2. Assemble App.jsx to use the hook',
      json({ action: 'write_file', path: 'src/hooks/useTodos.js', code: 'export function useTodos() {}\n' }),
      json({ action: 'done', summary: 'hook written' }),
      json({
        action: 'write_file',
        path: 'src/App.jsx',
        // A real assembly keeps the default export; dropping it is refused by
        // `writeFile`'s export guard, which is a different test's subject.
        code: "import { useTodos } from './hooks/useTodos';\n\nexport default function App() {\n  useTodos();\n  return <h1>Todo</h1>;\n}\n",
      }),
      json({ action: 'done', summary: 'app assembled' }),
    ]);

    const result = await session(client).run('Create the hook and then assemble App.jsx', { mode: 'agent' });

    assert.deepStrictEqual(
      result.todos.map((t) => t.status),
      ['done', 'done']
    );
    // The second step's prompt has to state the first step's output. Without it the
    // model has an import to write and no evidence the file exists.
    const secondStep = client.prompts.slice(3).join('\n');
    assert.ok(
      secondStep.includes('wrote src/hooks/useTodos.js'),
      'the second step was not told what the first step produced'
    );
  });

  it('fails a step that wrote a different file than the one it named', async () => {
    // gemma2:latest edited vite.config.js and README.md while working a list about
    // useTodos, TodoInput and App.jsx — and every item was scored as having changed
    // something.
    const client = scriptedClient([
      '1. Assemble src/App.jsx layout\n2. Update the README',
      // First attempt.
      json({ action: 'write_file', path: 'README.md', code: '# Todo\n' }),
      json({ action: 'done', summary: 'done' }),
      // The retry does the same wrong thing again.
      json({ action: 'write_file', path: 'README.md', code: '# Todo app\n' }),
      json({ action: 'done', summary: 'done' }),
    ]);

    const result = await session(client).run('Assemble App.jsx and update the README', { mode: 'agent' });

    assert.strictEqual(result.todos[0].status, 'failed');
    assert.match(result.todos[0].outcome, /this step is about src\/App\.jsx/);
    assert.match(result.todos[0].outcome, /what changed was README\.md/);
    // The App.jsx the fixture started with is untouched, which is the point.
    assert.match(fs.readFileSync(path.join(root, 'src', 'App.jsx'), 'utf8'), /Vite/);
  });

  it('retries a step that produced nothing, exactly once, with the reason stated', async () => {
    const client = scriptedClient([
      '1. Assemble src/App.jsx layout\n2. Update the README',
      // First attempt: reads and claims done.
      json({ action: 'read_file', path: 'src/App.jsx' }),
      json({ action: 'done', summary: 'looks fine' }),
      json({ action: 'done', summary: 'still fine' }),
      // Retry: writes.
      json({ action: 'write_file', path: 'src/App.jsx', code: 'export default function App() {\n  return <h1>Todo</h1>;\n}\n' }),
      json({ action: 'done', summary: 'written' }),
      json({ action: 'write_file', path: 'README.md', code: '# Todo\n' }),
      json({ action: 'done', summary: 'readme' }),
    ]);

    const events = [];
    const result = await session(client).run('Assemble App.jsx and update the README', {
      mode: 'agent',
      onEvent: (e) => events.push(e),
    });

    const retry = events.find((e) => e.type === 'todo-item-retry');
    assert.ok(retry, 'a step that produced nothing was written off without a second attempt');
    assert.strictEqual(retry.index, 1);

    assert.strictEqual(result.todos[0].status, 'done');
    assert.strictEqual(result.todos[0].attempts, 2);
    assert.match(fs.readFileSync(path.join(root, 'src', 'App.jsx'), 'utf8'), /<h1>Todo<\/h1>/);

    // The retry has to say what went wrong, or it is the first attempt again.
    assert.ok(
      client.prompts.some((prompt) => prompt.includes('This is attempt 2')),
      'the retry was not told the first attempt had failed'
    );
  });

  it('judges a retried step on both attempts, and records what both wrote', async () => {
    // A retried item is one item. Attempt one writing the wrong file and attempt two
    // writing the right one is a step that succeeded — and the file attempt one touched
    // still has to reach the steps that come after.
    const client = scriptedClient([
      '1. Assemble src/App.jsx layout\n2. Update the README',
      // Attempt 1: off target.
      json({ action: 'write_file', path: 'src/notes.txt', code: 'scratch\n' }),
      json({ action: 'done', summary: 'wrote notes' }),
      // Attempt 2: the real thing.
      json({ action: 'write_file', path: 'src/App.jsx', code: 'export default function App() {\n  return <h1>Todo</h1>;\n}\n' }),
      json({ action: 'done', summary: 'assembled' }),
      // Item 2.
      json({ action: 'write_file', path: 'README.md', code: '# Todo\n' }),
      json({ action: 'done', summary: 'readme' }),
    ]);

    const result = await session(client).run('Assemble App.jsx and update the README', { mode: 'agent' });

    assert.strictEqual(result.todos[0].status, 'done', 'the retry that landed was not credited to the step');
    assert.strictEqual(result.todos[0].attempts, 2);
    assert.deepStrictEqual(result.todos[0].changedPaths.sort(), ['src/App.jsx', 'src/notes.txt']);
    // One write per attempt — `done` is not a step — so both attempts counted is 2, and
    // only the last attempt counted would be 1.
    assert.strictEqual(result.todos[0].steps, 2, 'the first attempt was not counted towards the step');
    // The run did not stop, because the step ultimately succeeded.
    assert.strictEqual(result.todos[1].status, 'done');
  });

  it('stops the run when a step fails twice, rather than cascading', async () => {
    // Session 5 of the benchmark: the scaffold step failed and the remaining five ran
    // anyway against a project that had never been created, producing a wall of
    // missing-path errors with no statement of which one mattered.
    const client = scriptedClient([
      '1. Scaffold src/main.jsx\n2. Assemble src/App.jsx\n3. Update the README',
      json({ action: 'done', summary: 'nothing to do' }),
      json({ action: 'done', summary: 'still nothing' }),
      json({ action: 'done', summary: 'nothing again' }),
      json({ action: 'done', summary: 'and again' }),
    ]);

    const result = await session(client).run('Scaffold, assemble and document the app', { mode: 'agent' });

    assert.strictEqual(result.todos[0].status, 'failed');
    assert.deepStrictEqual(
      result.todos.slice(1).map((t) => t.status),
      ['skipped', 'skipped']
    );
    assert.match(result.summary, /Stopped at step 1/);
    assert.match(result.summary, /were not attempted/);
    assert.match(result.summary, /What to try/);
    // The README file must not exist: the later steps never ran.
    assert.ok(!fs.existsSync(path.join(root, 'README.md')));
  });

  it('leaves the ordinary TODO path alone when the toggle is off', async () => {
    const client = scriptedClient([
      '1. Assemble src/App.jsx layout\n2. Update the README',
      json({ action: 'write_file', path: 'README.md', code: '# Todo\n' }),
      json({ action: 'done', summary: 'done' }),
      json({ action: 'write_file', path: 'README.md', code: '# Todo app\n' }),
      json({ action: 'done', summary: 'done' }),
    ]);

    const result = await session(client, { stepSessions: false }).run('Assemble App.jsx and update the README', {
      mode: 'agent',
    });

    // Off-target work is not failed, no retry happens, and the run does not stop —
    // exactly the v0.4.0 behaviour, kept because the toggle is experimental.
    assert.strictEqual(result.todos[0].status, 'done');
    assert.strictEqual(result.todos[1].status, 'done');
    assert.ok(!result.summary.includes('Stopped at step'));
  });

  it('recalls the note about the file a step needs, not merely the latest note', async () => {
    const memory = new MemoryStore(root, 1);
    await memory.appendMany([
      'Created src/hooks/useTodos.js: a hook returning todos, addTodo and removeTodo',
      'Ran `npm install`: dependencies installed',
      'Edited vite.config.js: added the tailwind plugin',
      'Edited README.md: described the glassy blue theme',
      'Ran `npm run build`: the build succeeded',
    ]);

    const client = scriptedClient([
      '1. Assemble src/App.jsx using useTodos\n2. Update the README',
      json({
        action: 'write_file',
        path: 'src/App.jsx',
        // A real assembly keeps the default export; dropping it is refused by
        // `writeFile`'s export guard, which is a different test's subject.
        code: "import { useTodos } from './hooks/useTodos';\n\nexport default function App() {\n  useTodos();\n  return <h1>Todo</h1>;\n}\n",
      }),
      json({ action: 'done', summary: 'assembled' }),
      json({ action: 'write_file', path: 'README.md', code: '# Todo\n' }),
      json({ action: 'done', summary: 'readme' }),
    ]);

    await session(client, { memory }).run('Assemble App.jsx and update the README', { mode: 'agent' });

    // The useTodos note is the oldest of the five. On a recency window it is the first
    // to fall out — and it is the one the step cannot do its job without.
    const firstStep = client.prompts.slice(1, 3).join('\n');
    assert.ok(firstStep.includes('useTodos.js'), 'the step was not given the note about the file it had to import');
  });
});
