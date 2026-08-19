'use strict';

/**
 * A structured request, end to end: split from its own headings, one step at a time,
 * with the files it names written by dictation.
 *
 * The tests that matter most here are the refusals. Dictation writes files without the
 * model choosing to, so what it must *never* target is the part worth pinning down: a
 * file the request did not name, a file that already exists and was not annotated, and
 * a manifest the scaffolding command owns.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentSession } = require('../../app/agent/agentSession');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');

const TIER_B = { tier: 'B', strategy: 'react', label: 'Lite', model: 'llama3.2:1b', canPlanTodos: false, params: 1.2 };
const TIER_A = { tier: 'A', strategy: 'native', label: 'Agentic', model: 'big:9b', canPlanTodos: true, params: 9 };

/** A request with a drawn tree, of the shape this whole feature was built for. */
const REQUEST = [
  'Build a small notes app. Follow every instruction below.',
  '',
  '## Tech Stack',
  '- Plain JavaScript modules',
  '- No frameworks and no dependencies at all',
  '',
  '## Folder Structure',
  '',
  'Enforce this exact structure — do not flatten it:',
  '',
  '```',
  'notes-app/',
  '├── src/',
  '│   ├── store.js          # Holds the notes in memory, add/remove/list',
  '│   └── render.js         # Turns a note list into HTML',
  '├── index.html',
  '└── package.json',
  '```',
  '',
  '## Features',
  '',
  'Add a note, remove a note by id, and list every note that is not archived. Keep the',
  'storage logic out of the rendering code so each can be tested on its own, and make',
  'sure removing a note that does not exist is a no-op rather than an error — the UI',
  'calls it optimistically and we do not want a thrown exception to take the page down.',
  '',
  '## Rendering',
  '',
  'Escape the note text before it goes into the HTML. Notes come from the user and this',
  'is the one place where getting it wrong is a real problem rather than a cosmetic one.',
  'Show the id next to each note so a bug report can name one.',
].join('\n');

/**
 * A mock Ollama that answers a dictation with a file and anything else with `done`.
 *
 * The split is on the prompt, exactly as the real division works: a dictation asks for
 * "the complete contents of the file X" and nothing else does.
 */
function dictatingClient() {
  return {
    dictatedPaths: /** @type {string[]} */ ([]),
    bodies: /** @type {any[]} */ ([]),
    async chat(body) {
      this.bodies.push(body);
      const prompt = body.messages.map((message) => message.content).join('\n');
      const asked = /complete contents of the file (\S+)/.exec(prompt);
      if (asked) {
        this.dictatedPaths.push(asked[1]);
        return {
          message: {
            content: '```js\nexport function fromDictation() {\n  return "' + asked[1] + '";\n}\n```',
          },
        };
      }
      return { message: { content: JSON.stringify({ action: 'done', summary: 'nothing else to do' }) } };
    },
  };
}

describe('a structured request, split and dictated', () => {
  /** @type {string} */
  let root;

  function makeSession(client, capability) {
    const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: false } });
    const gate = new PermissionGate({
      workspaceRoot: root,
      modes,
      auditLog: new AuditLog(root),
      confirm: async () => true,
    });
    return new AgentSession({
      client,
      model: 'test-model',
      capability: capability || TIER_B,
      gate,
      workspaceRoot: root,
      thinkingCapacity: 'low',
      sessionId: '1',
    });
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-structured-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('writes the annotated files the request drew, at their full paths', async () => {
    const client = dictatingClient();
    await makeSession(client).run(REQUEST, { mode: 'agent' });

    assert.ok(fs.existsSync(path.join(root, 'notes-app', 'src', 'store.js')), 'store.js was not written');
    assert.ok(fs.existsSync(path.join(root, 'notes-app', 'src', 'render.js')), 'render.js was not written');
    assert.match(fs.readFileSync(path.join(root, 'notes-app', 'src', 'store.js'), 'utf8'), /fromDictation/);
  });

  it('never dictates package.json, which the scaffolding command owns', async () => {
    // A model asked to "write package.json for this app" produces a plausible one with
    // the wrong versions and no scripts. The 0.9.0 baseline recorded `qwen3.5:0.8b`
    // doing exactly that, leaving a project whose `npm run build` did not exist.
    const client = dictatingClient();
    await makeSession(client).run(REQUEST, { mode: 'agent' });

    assert.strictEqual(
      client.dictatedPaths.some((target) => /package\.json$/.test(target)),
      false,
      'package.json must never be dictated'
    );
    assert.strictEqual(fs.existsSync(path.join(root, 'notes-app', 'package.json')), false);
  });

  it('leaves an existing file alone when the request said nothing about it', async () => {
    // `index.html` is in the tree with no comment: the author is saying where it goes,
    // not asking for it to be authored. An existing one is somebody else's file.
    fs.mkdirSync(path.join(root, 'notes-app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes-app', 'index.html'), '<!doctype html><title>mine</title>');

    const client = dictatingClient();
    await makeSession(client).run(REQUEST, { mode: 'agent' });

    assert.strictEqual(fs.readFileSync(path.join(root, 'notes-app', 'index.html'), 'utf8'), '<!doctype html><title>mine</title>');
  });

  it('does rewrite an existing file the request annotated', async () => {
    // The counterpart, and the case the whole rule exists for: `npm create vite` leaves
    // App.jsx holding its counter demo, and the brief's tree comments that file. Both
    // baseline runs that got as far as building shipped the demo.
    fs.mkdirSync(path.join(root, 'notes-app', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes-app', 'src', 'store.js'), '// scaffolded placeholder\n');

    const client = dictatingClient();
    await makeSession(client).run(REQUEST, { mode: 'agent' });

    const written = fs.readFileSync(path.join(root, 'notes-app', 'src', 'store.js'), 'utf8');
    assert.match(written, /fromDictation/, 'the annotated file should have been rewritten');
  });

  it('shows the step only its own section of the request', async () => {
    const client = dictatingClient();
    await makeSession(client).run(REQUEST, { mode: 'agent' });

    const loopPrompts = client.bodies
      .filter((body) => body.format)
      .map((body) => body.messages.map((message) => message.content).join('\n'));
    assert.ok(loopPrompts.length > 0, 'the loop should have run for at least one step');

    const structureStep = loopPrompts.find((prompt) => /Folder Structure/.test(prompt));
    if (structureStep) {
      assert.match(structureStep, /own words/, 'the step should be given its own section');
      assert.match(structureStep, /No frameworks/, 'project-wide rules should ride under every step');
    }
  });

  it('does not dictate for a model on the agentic tier', async () => {
    // A Tier A model orchestrates tools well enough to be left to it. The finding
    // behind dictation is about the tier that does not.
    const client = dictatingClient();
    await makeSession(client, TIER_A).run(REQUEST, { mode: 'agent' });
    assert.deepStrictEqual(client.dictatedPaths, []);
  });

  it('does not split a request with no structure, and dictates nothing', async () => {
    const client = dictatingClient();
    const result = await makeSession(client).run('Fix the typo in the heading.', { mode: 'agent' });
    assert.deepStrictEqual(client.dictatedPaths, []);
    assert.strictEqual(result.changeSet.isEmpty(), true);
  });
});
