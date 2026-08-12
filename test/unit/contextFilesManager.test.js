'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ContextFilesManager, MAX_ATTACHED_FILES } = require('../../app/core/contextFilesManager');

describe('ContextFilesManager', () => {
  /** @type {string} */
  let root;
  /** @type {ContextFilesManager} */
  let manager;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-ctx-')));
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# Spec\nUse a regex for email validation.');
    fs.writeFileSync(path.join(root, 'style.md'), '# Style\nTwo-space indents.');
    manager = new ContextFilesManager(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('attaches a file and exposes its content', async () => {
    const result = await manager.add('docs/spec.md');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.file.relativePath, 'docs/spec.md');
    assert.ok(result.file.excerpt.includes('Use a regex'));
    assert.ok(result.file.tokens > 0);
  });

  it('accepts an absolute path inside the workspace', async () => {
    const result = await manager.add(path.join(root, 'style.md'));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.file.relativePath, 'style.md');
  });

  it('refuses a path outside the workspace', async () => {
    const result = await manager.add('../../../etc/passwd');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'OUTSIDE_WORKSPACE');
  });

  it('refuses a directory', async () => {
    const result = await manager.add('docs');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'IS_DIRECTORY');
  });

  it('refuses a binary file', async () => {
    fs.writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const result = await manager.add('logo.png');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'BINARY');
  });

  it('reports a missing file clearly', async () => {
    const result = await manager.add('nope.md');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'NOT_FOUND');
  });

  it('caps how many files can be attached', async () => {
    for (let i = 0; i < MAX_ATTACHED_FILES; i += 1) {
      fs.writeFileSync(path.join(root, `f${i}.md`), `file ${i}`);
      assert.strictEqual((await manager.add(`f${i}.md`)).ok, true);
    }
    fs.writeFileSync(path.join(root, 'extra.md'), 'extra');
    const result = await manager.add('extra.md');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'TOO_MANY_FILES');
  });

  it('redacts secrets before the content can reach a prompt', async () => {
    fs.writeFileSync(path.join(root, 'config.md'), `token: ghp_${'a'.repeat(36)}`);
    const result = await manager.add('config.md');
    assert.strictEqual(result.ok, true);
    assert.ok(!result.file.excerpt.includes('a'.repeat(36)));
    assert.strictEqual(result.file.secretsRedacted, 1);
  });

  it('truncates a large file with a visible note', async () => {
    fs.writeFileSync(path.join(root, 'big.md'), 'word '.repeat(20000));
    const result = await manager.add('big.md');
    assert.strictEqual(result.file.truncated, true);
    assert.ok(result.file.excerpt.includes('trimmed'));
    assert.ok(manager.renderForPrompt().includes('(excerpt)'));
  });

  it('removes an attachment', async () => {
    await manager.add('style.md');
    assert.strictEqual(await manager.remove('style.md'), true);
    assert.deepStrictEqual(manager.list(), []);
    assert.strictEqual(await manager.remove('style.md'), false);
  });

  it('renders attachments as a labelled prompt block', async () => {
    await manager.add('docs/spec.md');
    await manager.add('style.md');
    const rendered = manager.renderForPrompt();
    assert.ok(rendered.includes('--- docs/spec.md ---'));
    assert.ok(rendered.includes('--- style.md ---'));
    assert.ok(rendered.includes('Two-space indents'));
  });

  it('renders nothing when no files are attached', () => {
    assert.strictEqual(manager.renderForPrompt(), '');
    assert.strictEqual(manager.totalTokens(), 0);
  });

  describe('staleness', () => {
    it('re-reads a file that changed after it was attached', async () => {
      await manager.add('style.md');
      assert.ok(manager.renderForPrompt().includes('Two-space indents'));

      // Without a refresh the agent would keep reasoning about the old version
      // with nothing to signal it is stale.
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(path.join(root, 'style.md'), '# Style\nFour-space indents.');

      const refreshed = await manager.refresh();
      assert.deepStrictEqual(refreshed, ['style.md']);
      assert.ok(manager.renderForPrompt().includes('Four-space indents'));
    });

    it('detaches a file that was deleted', async () => {
      await manager.add('style.md');
      fs.rmSync(path.join(root, 'style.md'));
      await manager.refresh();
      assert.deepStrictEqual(manager.list(), []);
    });

    it('leaves an unchanged file alone', async () => {
      await manager.add('style.md');
      assert.deepStrictEqual(await manager.refresh(), []);
    });
  });

  describe('persistence', () => {
    it('stores only references, not copies of the user workspace', async () => {
      await manager.add('docs/spec.md');
      const indexPath = path.join(root, '.hirayacoder', 'context-files', 'index.json');
      assert.ok(fs.existsSync(indexPath));

      const files = fs.readdirSync(path.join(root, '.hirayacoder', 'context-files'));
      assert.deepStrictEqual(files, ['index.json'], 'no wholesale file copies');
    });

    it('restores attachments in a new session', async () => {
      await manager.add('docs/spec.md');

      const reopened = new ContextFilesManager(root);
      await reopened.load();
      assert.strictEqual(reopened.list().length, 1);
      assert.ok(reopened.renderForPrompt().includes('Use a regex'));
    });

    it('discards a malformed index rather than trusting it into a prompt', async () => {
      const indexPath = path.join(root, '.hirayacoder', 'context-files', 'index.json');
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(indexPath, '{ not valid json');

      const reopened = new ContextFilesManager(root);
      await reopened.load();
      assert.deepStrictEqual(reopened.list(), []);
    });

    it('skips index entries with the wrong shape', async () => {
      const indexPath = path.join(root, '.hirayacoder', 'context-files', 'index.json');
      fs.mkdirSync(path.dirname(indexPath), { recursive: true });
      fs.writeFileSync(indexPath, JSON.stringify({ version: 1, files: [{ nope: true }, null, 'x'] }));

      const reopened = new ContextFilesManager(root);
      await reopened.load();
      assert.deepStrictEqual(reopened.list(), []);
    });

    it('starts empty when no index exists', async () => {
      const fresh = new ContextFilesManager(root);
      await fresh.load();
      assert.deepStrictEqual(fresh.list(), []);
    });
  });
});
