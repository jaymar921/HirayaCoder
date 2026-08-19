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
      // The prompt ends that sentence with a full stop, and `\S+` swallows it — which
      // quietly made the assertion about what is *never* dictated vacuous, since no
      // path ever matched `/package\.json$/` with a trailing dot on it.
      const asked = /complete contents of the file (\S+?)\.?(?=\s|$)/.exec(prompt);
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

  /**
   * Stand in for the scaffolding step having worked.
   *
   * The session creates the project directory itself when the request names no scaffold
   * command, so these cases would pass without this — but starting from a project that
   * exists is what each of them is actually about, and saying so keeps them readable.
   */
  function scaffolded() {
    fs.mkdirSync(path.join(root, 'notes-app'), { recursive: true });
  }

  it('writes the annotated files the request drew, at their full paths', async () => {
    scaffolded();
    const client = dictatingClient();
    await makeSession(client).run(REQUEST, { mode: 'agent' });

    assert.ok(fs.existsSync(path.join(root, 'notes-app', 'src', 'store.js')), 'store.js was not written');
    assert.ok(fs.existsSync(path.join(root, 'notes-app', 'src', 'render.js')), 'render.js was not written');
    assert.match(fs.readFileSync(path.join(root, 'notes-app', 'src', 'store.js'), 'utf8'), /fromDictation/);
  });

  it('never dictates package.json, which the scaffolding command owns', async () => {
    scaffolded();
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
    scaffolded();
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
    scaffolded();
    // A Tier A model orchestrates tools well enough to be left to it. The finding
    // behind dictation is about the tier that does not.
    const client = dictatingClient();
    await makeSession(client, TIER_A).run(REQUEST, { mode: 'agent' });
    assert.deepStrictEqual(client.dictatedPaths, []);
  });

  it('creates the project directory the request drew, when nothing else will', async () => {
    // The counterpart to the rule below, and the gap it left. Dictation will not write
    // into a project directory that does not exist — but that assumed something else
    // would create it, and a request that names no scaffold command has nothing that
    // does. Measured on both POS briefs, which are built by writing files rather than
    // by running a generator: `pos-app/` never appeared, every source file the tree
    // drew was skipped, and `mvn package` then succeeded over a project with no
    // sources at all.
    const client = dictatingClient();
    await makeSession(client).run(REQUEST, { mode: 'agent' });

    assert.ok(fs.existsSync(path.join(root, 'notes-app')), 'the project directory was never created');
    assert.ok(
      fs.existsSync(path.join(root, 'notes-app', 'src', 'store.js')),
      `store.js was not written; dictated ${JSON.stringify(client.dictatedPaths)}`
    );
  });

  it('waits for the scaffold command rather than pre-filling its directory', async () => {
    // The protection that must survive the above. Filling in `shop/` before
    // `npm create vite` runs makes the scaffold a silent no-op — measured: it found a
    // non-empty directory, exited 0, and created nothing.
    const request = [
      'Build a small shop front.',
      '',
      '## Setup',
      '',
      'Scaffold it with `npm create vite@latest shop -- --template react`, then install',
      'the dependencies before writing any code of your own.',
      '',
      '## Structure',
      '',
      'Use this layout:',
      '',
      '```',
      'shop/',
      '├── src/',
      '│   ├── Cart.jsx       # The basket, and the running total',
      '│   └── Item.jsx       # One line of the basket, with a remove control',
      '```',
      '',
      '## Behaviour',
      '',
      '- Show the running total under the basket, updating as lines are removed, so the',
      '  number never disagrees with the lines above it.',
      '- Keep the remove control reachable by keyboard, because the basket is the one',
      '  screen people use in a hurry.',
    ].join('\n');

    const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: false } });
    const gate = new PermissionGate({
      workspaceRoot: root,
      modes,
      auditLog: new AuditLog(root),
      // The user declines the scaffold, so nothing creates `shop/`.
      confirm: async () => false,
    });
    const client = dictatingClient();
    const session = new AgentSession({
      client,
      model: 'test-model',
      capability: TIER_B,
      gate,
      workspaceRoot: root,
      thinkingCapacity: 'low',
      sessionId: '1',
    });

    await session.run(request, { mode: 'agent' });

    assert.strictEqual(
      fs.existsSync(path.join(root, 'shop')),
      false,
      'the directory a scaffold command owns must not be created for it'
    );
    assert.deepStrictEqual(
      client.dictatedPaths.filter((target) => target.startsWith('shop/')),
      [],
      'nothing under shop/ should be written before the scaffold runs'
    );
  });

  it('does not mistake a fragment of a sentence for a filename', async () => {
    // Found in a live sweep, not in review: a request reading *Counter (e.g. "3 of 5
    // remaining")* had `e.g` picked out of it as a path, and a file called `e.g` was
    // written into the project root. A junk file created without the user asking, out of
    // a fragment of their own sentence, is exactly the surprise this must never produce.
    const request = [
      'Please extend the dashboard.',
      '',
      '## Counters',
      '',
      'Show a live count of the remaining items (e.g. "3 of 5 remaining") in the header,',
      'updating as items are checked off. Keep it readable at narrow widths — the sidebar',
      'collapses below 700px and the header has to survive that without wrapping oddly.',
      '',
      '## Empty state',
      '',
      'Write a friendly message when the list is empty (i.e. before anything is added),',
      'and make sure it disappears the moment the first item arrives rather than lingering',
      'for a frame, which looks like a bug even though it is not.',
    ].join('\n');

    const client = dictatingClient();
    await makeSession(client).run(request, { mode: 'agent' });

    for (const target of client.dictatedPaths) {
      assert.strictEqual(/(?:^|\/)(?:e\.g|i\.e)$/.test(target), false, `dictated a prose fragment: ${target}`);
    }
    assert.strictEqual(fs.existsSync(path.join(root, 'e.g')), false);
  });

  it('makes the composition root use the files written for it', async () => {
    // The most expensive failure in two evaluations, and one a build cannot see: five
    // correct components on disk, a clean `npm run build`, and an App still holding the
    // scaffold's demo because nothing went back to it. Measured at 2 of 12 features
    // working with every gate green.
    //
    // Deliberately a request of its own, with no backticked identifiers and no key
    // names in it, so nothing else in the pipeline can produce the rewrite and a pass
    // here means the assembly check produced it.
    const request = [
      'Build a small dashboard.',
      '',
      '## Structure',
      '',
      'Use this layout and do not flatten it:',
      '',
      '```',
      'board-app/',
      '├── src/',
      '│   ├── Chart.jsx      # Draws the bar chart',
      '│   ├── Legend.jsx     # Names each series beside a colour swatch',
      '│   └── App.jsx        # Composes the chart and the legend into one screen',
      '```',
      '',
      '## Behaviour',
      '',
      '- Show one bar per series, and list the same series in the legend in the same order',
      '  so the two can be read against each other without counting.',
      '- Dim every other bar when a series is selected in the legend, so the eye can follow',
      '  one line through a crowded chart without losing it.',
      '',
      '## Sizing',
      '',
      '- Fill the width the panel gives, keeping a sensible aspect ratio down to a phone,',
      '  where the legend moves underneath rather than beside the chart.',
      '- Do not set a fixed pixel width anywhere. The dashboard is embedded in panels of',
      '  several sizes and a hard width is the first thing to break when somebody drags a',
      '  divider.',
    ].join('\n');

    fs.mkdirSync(path.join(root, 'board-app'), { recursive: true });

    const client = {
      appWrites: 0,
      async chat(body) {
        const prompt = body.messages.map((message) => message.content).join('\n');
        // The prompt ends that sentence with a full stop, and `\S+` swallows it — which
      // quietly made the assertion about what is *never* dictated vacuous, since no
      // path ever matched `/package\.json$/` with a trailing dot on it.
      const asked = /complete contents of the file (\S+?)\.?(?=\s|$)/.exec(prompt);
        if (!asked) return { message: { content: JSON.stringify({ action: 'done', summary: 'done' }) } };
        const target = asked[1];
        if (/App\.jsx$/.test(target)) {
          this.appWrites += 1;
          // First time: a screen that imports nothing, which is the real failure. Second
          // time — only reachable if something told it what was missing — the wiring.
          return this.appWrites > 1
            ? {
                message: {
                  content:
                    '```jsx\nimport Chart from "./Chart.jsx";\nimport Legend from "./Legend.jsx";\n' +
                    'export default function App() { return <><Chart /><Legend /></>; }\n```',
                },
              }
            : { message: { content: '```jsx\nexport default function App() { return <h1>Hello</h1>; }\n```' } };
        }
        const name = (target.split('/').pop() || '').replace(/\.jsx$/, '');
        return { message: { content: '```jsx\nexport default function ' + name + '() { return null; }\n```' } };
      },
    };

    await makeSession(client).run(request, { mode: 'agent' });

    const written = fs.readFileSync(path.join(root, 'board-app', 'src', 'App.jsx'), 'utf8');
    assert.match(written, /Chart/, 'the composition root never used what was written for it');
    assert.match(written, /Legend/);
    assert.strictEqual(client.appWrites, 2, 'the assembly check should have asked for App.jsx a second time');
  });

  it('does not mistake a dotted module path for a file', async () => {
    // The finding from the POS-in-Python sweep, and the most expensive one yet: a
    // dotted identifier is shaped exactly like a filename, Python prose is full of
    // them, and each one consumed a dictation slot. `qwen3.5:0.8b` and `llama3.2:1b`
    // both spent their budget writing `pathlib.Path` and `abc.ABC`, and finished with
    // zero project files on disk.
    const request = [
      'Build a small ledger tool in Python.',
      '',
      '## Structure',
      '',
      'Use this layout and do not flatten it:',
      '',
      '```',
      'ledger-app/',
      '├── ledger/',
      '│   ├── store.py       # Holds entries, backed by a file',
      '│   └── report.py      # Turns entries into a printable summary',
      '└── README.md',
      '```',
      '',
      '## Detailed Requirements',
      '',
      '- Use `pathlib.Path` for every file operation, never bare `open` with a string,',
      '  so the tool behaves the same on Windows as it does on Linux.',
      '- Define the repository as an abstract base class using `abc.ABC`, and keep the',
      '  concrete file-backed one separate from it.',
      '- Serialise with `json.dumps` and sort the keys, so a committed data file has a',
      '  stable diff rather than a reordered one every save.',
    ].join('\n');

    fs.mkdirSync(path.join(root, 'ledger-app', 'ledger'), { recursive: true });

    const client = dictatingClient();
    await makeSession(client).run(request, { mode: 'agent' });

    for (const target of client.dictatedPaths) {
      assert.strictEqual(
        /(?:pathlib\.Path|abc\.ABC|json\.dumps)$/.test(target),
        false,
        `dictated a module path: ${target}`
      );
    }
    assert.strictEqual(fs.existsSync(path.join(root, 'pathlib.Path')), false);
    assert.strictEqual(fs.existsSync(path.join(root, 'ledger-app', 'abc.ABC')), false);
  });

  it('reads a path written at the end of a sentence', async () => {
    // "…in ledger/store.py." — the full stop belongs to the sentence, and leaving it on
    // turns a real file into one with no extension, which is then silently skipped.
    const request = [
      'Extend the ledger tool.',
      '',
      '## Structure',
      '',
      'Keep this layout:',
      '',
      '```',
      'ledger-app/',
      '└── ledger/',
      '    └── store.py       # Holds entries, backed by a file',
      '```',
      '',
      '## Detailed Requirements',
      '',
      '- Put the running total in ledger/report.py, and read it from ledger/store.py.',
      '- Round every figure to two decimal places before it is printed, because the',
      '  totals are read aloud in a meeting and pennies of drift start arguments.',
      '',
      '## Output format',
      '',
      '- Print one line per entry, with the date left-aligned and the amount right-aligned',
      '  in a fixed-width column, so a column of figures can be scanned down rather than',
      '  read across.',
      '- Show the running total on its own line at the foot, separated by a rule, and say',
      '  explicitly when the ledger is empty rather than printing a bare zero that reads',
      '  like a balanced account.',
    ].join('\n');

    fs.mkdirSync(path.join(root, 'ledger-app', 'ledger'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });

    const client = dictatingClient();
    await makeSession(client).run(request, { mode: 'agent' });

    assert.ok(
      client.dictatedPaths.includes('ledger/report.py'),
      `report.py was never asked for; got ${JSON.stringify(client.dictatedPaths)}`
    );
  });

  it('creates a package marker rather than asking a model to write one', async () => {
    // `__init__.py` is usually empty, and an empty reply is one dictation refuses —
    // correctly, since an empty code block from a model asked for a component means it
    // gave up. So every package marker in the Python sweeps came back "the code block
    // was empty" or "cut off", and the package did not import.
    const request = [
      'Build a small importer in Python.',
      '',
      '## Structure',
      '',
      'Use this layout and keep the package importable:',
      '',
      '```',
      'feed-app/',
      '├── feed/',
      '│   ├── __init__.py',
      '│   └── reader.py      # Reads a feed file and yields entries',
      '└── README.md',
      '```',
      '',
      '## Behaviour',
      '',
      '- Read the feed lazily, yielding one entry at a time, so a file larger than memory',
      '  is still processable on a laptop.',
      '- Skip a malformed entry with a warning rather than stopping, because one bad line',
      '  in a month of data should not cost the whole month.',
      '',
      '## Reporting',
      '',
      '- Count the entries read and the entries skipped, and print both at the end, so a',
      '  run that quietly dropped half its input is visible rather than merely finished.',
      '- Write the warnings to stderr and the entries to stdout, so the two can be',
      '  separated by a shell without any flag being needed.',
    ].join('\n');

    const client = dictatingClient();
    await makeSession(client).run(request, { mode: 'agent' });

    const marker = path.join(root, 'feed-app', 'feed', '__init__.py');
    assert.ok(fs.existsSync(marker), 'the package marker was never created');
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), '', 'a marker file should be empty');
    assert.strictEqual(
      client.dictatedPaths.some((target) => target.endsWith('__init__.py')),
      false,
      'a marker file should not be asked of the model at all'
    );
  });

  it('does not try to write a PNG', async () => {
    // The benchmark brief's README section carries the placeholder
    // `![screenshot](./screenshot.png)` — a real path with a real extension, and nothing
    // a model could ever produce. A fenced code block written into it is junk with a
    // misleading name.
    const request = [
      'Document the notes app.',
      '',
      '## README',
      '',
      'Write a README.md at the repository root. It must include a title, a feature list,',
      'a screenshot placeholder `![screenshot](./screenshot.png)`, and setup instructions',
      'covering install, dev and build. Keep it short enough that somebody actually reads',
      'it before running anything.',
      '',
      '## Icons',
      '',
      'Add an `icon.svg` in the public folder, a simple monochrome mark that reads at 16px',
      'as well as at 128px. Inline paths only, no external references, no embedded raster',
      'images inside it.',
    ].join('\n');

    const client = dictatingClient();
    await makeSession(client).run(request, { mode: 'agent' });

    assert.strictEqual(
      client.dictatedPaths.some((target) => /\.png$/i.test(target)),
      false,
      'a PNG must never be dictated'
    );
    assert.strictEqual(fs.existsSync(path.join(root, 'screenshot.png')), false);
  });

  it('does not split a request with no structure, and dictates nothing', async () => {
    const client = dictatingClient();
    const result = await makeSession(client).run('Fix the typo in the heading.', { mode: 'agent' });
    assert.deepStrictEqual(client.dictatedPaths, []);
    assert.strictEqual(result.changeSet.isEmpty(), true);
  });
});
