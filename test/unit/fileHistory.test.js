'use strict';

/**
 * What changed, and what it changed from.
 *
 * The two properties that matter: a diff is stored rather than two copies of the file,
 * and the one field that carries the user's code is redacted and bounded on the way in.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FileHistory, renderDiff, MAX_DIFF_LINES } = require('../../app/core/fileHistory');

describe('fileHistory.renderDiff', () => {
  it('shows only the changed region, not the whole file', () => {
    const before = 'a\nb\nc\nd\ne\n';
    const after = 'a\nb\nCHANGED\nd\ne\n';
    const { diff, added, removed } = renderDiff(before, after);

    assert.strictEqual(added, 1);
    assert.strictEqual(removed, 1);
    assert.match(diff, /- c/);
    assert.match(diff, /\+ CHANGED/);
    assert.ok(!diff.includes('a\n'), 'the unchanged head was included');
  });

  it('says where in the file the change starts', () => {
    assert.match(renderDiff('a\nb\nc\n', 'a\nb\nZ\n').diff, /@@ line 3 @@/);
  });

  it('treats a new file as all additions', () => {
    const { added, removed } = renderDiff(null, 'one\ntwo\n');
    assert.strictEqual(removed, 0);
    assert.ok(added >= 2);
  });

  it('caps a large rewrite rather than storing the file twice', () => {
    const before = Array.from({ length: 500 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 500 }, (_, i) => `new ${i}`).join('\n');
    const { diff, truncated } = renderDiff(before, after);

    assert.strictEqual(truncated, true);
    assert.ok(diff.split('\n').length <= MAX_DIFF_LINES + 2);
    assert.match(diff, /changed lines in total/);
  });

  it('clips one enormous line, as a minified bundle would be', () => {
    const { diff } = renderDiff('short\n', `${'x'.repeat(5000)}\n`);
    for (const line of diff.split('\n')) {
      assert.ok(line.length < 400, 'a single line filled the entry');
    }
  });

  it('reports no change for an identical rewrite', () => {
    const { added, removed } = renderDiff('same\n', 'same\n');
    assert.strictEqual(added, 0);
    assert.strictEqual(removed, 0);
  });
});

describe('FileHistory', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-hist-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('records what a change did, and survives to the next session', async () => {
    const first = new FileHistory(root);
    await first.record({
      path: 'src/app.js',
      kind: 'edit',
      before: 'const a = 1;\n',
      after: 'const a = 2;\n',
      sessionId: '1',
      model: 'ornith:9b',
    });
    await first.flush();

    const [entry] = await new FileHistory(root).recent();
    assert.strictEqual(entry.path, 'src/app.js');
    assert.strictEqual(entry.kind, 'edit');
    assert.strictEqual(entry.model, 'ornith:9b');
    assert.match(entry.diff, /- const a = 1;/);
    assert.match(entry.diff, /\+ const a = 2;/);
  });

  it('redacts a credential out of a diff', async () => {
    // The one file in `.hirayacoder/` that holds workspace content by design, which is
    // why this is a guarantee rather than an intention.
    const history = new FileHistory(root);
    await history.record({
      path: '.env.example',
      kind: 'edit',
      before: 'KEY=old\n',
      after: 'KEY=AKIAIOSFODNN7EXAMPLE\n',
      sessionId: '1',
    });
    await history.flush();

    const [entry] = await history.recent();
    assert.ok(!entry.diff.includes('AKIAIOSFODNN7EXAMPLE'), 'a credential was written to disk');
  });

  it('returns the newest change first', async () => {
    const history = new FileHistory(root);
    await history.record({ path: 'a.js', kind: 'create', before: null, after: 'a\n', sessionId: '1' });
    await history.record({ path: 'b.js', kind: 'create', before: null, after: 'b\n', sessionId: '1' });
    await history.flush();

    const entries = await history.recent();
    assert.strictEqual(entries[0].path, 'b.js');
  });

  it('keeps one session out of another session\'s recall', async () => {
    const history = new FileHistory(root);
    await history.record({ path: 'a.js', kind: 'create', before: null, after: 'a\n', sessionId: '1' });
    await history.record({ path: 'b.js', kind: 'create', before: null, after: 'b\n', sessionId: '2' });
    await history.flush();

    const block = await history.renderForPrompt('2');
    assert.match(block, /b\.js/);
    assert.ok(!block.includes('a.js'), "session 2 was shown session 1's work");
  });

  it('tells the model what it already did, without handing back the diffs', async () => {
    // Paths and counts only: the model needs to know it already edited a file so it
    // stops re-doing its own work, and can read the file if it wants the contents.
    const history = new FileHistory(root);
    await history.record({
      path: 'src/TodoApp.java',
      kind: 'edit',
      before: 'class A {}\n',
      after: 'class A { void wire() {} }\n',
      sessionId: '1',
    });
    await history.flush();

    const block = await history.renderForPrompt('1');
    assert.match(block, /already changed/i);
    assert.match(block, /src\/TodoApp\.java/);
    assert.ok(!block.includes('void wire'), 'the diff was spent on the prompt budget');
  });

  it('renders nothing for a session that has changed nothing', async () => {
    assert.strictEqual(await new FileHistory(root).renderForPrompt('9'), '');
  });

  it('records a delete with no diff to show', async () => {
    const history = new FileHistory(root);
    await history.record({ path: 'old.js', kind: 'delete', before: 'a\nb\n', after: null, sessionId: '1' });
    await history.flush();

    const [entry] = await history.recent();
    assert.strictEqual(entry.kind, 'delete');
    assert.strictEqual(entry.removed, 2);
  });

  it('never lets a recording failure matter', async () => {
    // History is a record, not a dependency. The change it describes has already
    // landed on disk by the time this runs.
    const history = new FileHistory(root);
    history.record = async () => {
      throw new Error('disk full');
    };

    await assert.doesNotReject(() =>
      history.recordAll([{ path: 'a.js', kind: 'edit', before: 'a', after: 'b' }], { sessionId: '1' })
    );
  });

  it('forgets everything on clear', async () => {
    const history = new FileHistory(root);
    await history.record({ path: 'a.js', kind: 'create', before: null, after: 'a\n', sessionId: '1' });
    await history.clear();

    assert.deepStrictEqual(await new FileHistory(root).recent(), []);
  });
});
