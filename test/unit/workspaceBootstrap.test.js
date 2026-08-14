'use strict';

/**
 * Getting a workspace ready before the first turn runs.
 *
 * The `.gitignore` half is the one with rules worth pinning down: it is the user's file,
 * it may already say something about `.hirayacoder`, and it may not exist at all. The
 * failure to avoid is not a missing entry — it is a rewritten file.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const workspaceBootstrap = require('../../app/core/workspaceBootstrap');

describe('workspaceBootstrap.alreadyIgnored', () => {
  it('recognises every form the entry is written in', () => {
    for (const line of ['.hirayacoder', '.hirayacoder/', '/.hirayacoder', '**/.hirayacoder', '  .hirayacoder/  ']) {
      assert.ok(workspaceBootstrap.alreadyIgnored(`node_modules\n${line}\ndist\n`), `missed "${line}"`);
    }
  });

  it('treats a negation as a decision already made', () => {
    // `!.hirayacoder` is someone deliberately tracking it. Appending the positive entry
    // underneath would silently overrule them.
    assert.ok(workspaceBootstrap.alreadyIgnored('!.hirayacoder\n'));
  });

  it('is not fooled by a comment or by a longer name', () => {
    assert.ok(!workspaceBootstrap.alreadyIgnored('# .hirayacoder\n'));
    assert.ok(!workspaceBootstrap.alreadyIgnored('.hirayacoder-backup\n'));
    assert.ok(!workspaceBootstrap.alreadyIgnored(''));
  });
});

describe('workspaceBootstrap.ensureGitignore', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-bootstrap-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** @returns {string} */
  const read = () => fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

  it('creates a .gitignore with the one entry when there is none', () => {
    assert.strictEqual(workspaceBootstrap.ensureGitignore(root), 'created');
    assert.ok(read().includes('.hirayacoder/'));
    // Deliberately not guessing at node_modules or dist for a project whose language
    // nobody has looked at yet.
    assert.ok(!read().includes('node_modules'));
  });

  it('appends to an existing file without touching what is already in it', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\ndist\n', 'utf8');
    assert.strictEqual(workspaceBootstrap.ensureGitignore(root), 'appended');

    const contents = read();
    assert.ok(contents.startsWith('node_modules\ndist\n'));
    assert.ok(contents.includes('.hirayacoder/'));
  });

  it('does not join the entry onto a last line with no newline of its own', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules', 'utf8');
    workspaceBootstrap.ensureGitignore(root);

    const lines = read().split('\n').map((line) => line.trim()).filter(Boolean);
    assert.ok(lines.includes('node_modules'), 'the existing entry was corrupted');
    assert.ok(lines.includes('.hirayacoder/'));
  });

  it('keeps a CRLF file on CRLF', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\r\n', 'utf8');
    workspaceBootstrap.ensureGitignore(root);
    assert.ok(!/[^\r]\n/.test(read()), 'a bare LF was introduced into a CRLF file');
  });

  it('adds nothing when the entry is already there', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\n.hirayacoder\n', 'utf8');
    assert.strictEqual(workspaceBootstrap.ensureGitignore(root), 'present');
    assert.strictEqual(read(), 'node_modules\n.hirayacoder\n');
  });

  it('is idempotent across repeated sessions', () => {
    workspaceBootstrap.ensureGitignore(root);
    workspaceBootstrap.ensureGitignore(root);
    workspaceBootstrap.ensureGitignore(root);

    const occurrences = read().split('\n').filter((line) => line.trim() === '.hirayacoder/').length;
    assert.strictEqual(occurrences, 1);
  });
});

describe('workspaceBootstrap.bootstrap', () => {
  it('does nothing at all without a workspace', () => {
    assert.strictEqual(workspaceBootstrap.bootstrap(null), null);
  });

  it('leaves both the profile and the ignore entry behind', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-bootstrap-'));
    try {
      const ready = workspaceBootstrap.bootstrap(root);

      assert.ok(ready.profile.osName.length > 0);
      assert.strictEqual(ready.gitignore, 'created');
      assert.ok(fs.existsSync(path.join(root, '.hirayacoder', 'environment.json')));
      assert.ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').includes('.hirayacoder/'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
