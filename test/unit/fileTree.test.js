'use strict';

/**
 * Reading a drawn folder tree as real paths.
 *
 * The cases that matter are the joins — `src/` plus `components/` plus `TodoItem.jsx`
 * has to come out as one path — and the refusals, because a list of bare filenames has
 * no directories to join onto and reading it as a tree would produce paths that are
 * confidently wrong.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fileTree = require('../../app/core/fileTree');
const requestPlan = require('../../app/core/requestPlan');

const BRIEF = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'prompts', 'todo-glass-app.md'), 'utf8');

describe('fileTree.parse — the benchmark brief', () => {
  const structure = requestPlan.fromRequest(BRIEF).items.find((item) => /Folder Structure/.test(item.text));
  const files = fileTree.files(structure.detail);
  const byPath = new Map(files.map((file) => [file.path, file.purpose]));

  it('joins every nested file onto its directories', () => {
    assert.ok(byPath.has('todo-glass-app/src/components/TodoItem.jsx'));
    assert.ok(byPath.has('todo-glass-app/src/hooks/useTodos.js'));
    assert.ok(byPath.has('todo-glass-app/src/App.jsx'));
  });

  it('pops back out of a directory when the tree does', () => {
    // `index.html` sits at the project root, two levels out from the components it
    // follows in the drawing. Getting this wrong yields src/components/index.html.
    assert.ok(byPath.has('todo-glass-app/index.html'));
    assert.ok(byPath.has('todo-glass-app/package.json'));
  });

  it('keeps the author’s comment as the file’s purpose', () => {
    assert.strictEqual(byPath.get('todo-glass-app/src/components/TodoInput.jsx'), 'Add-todo form');
    assert.strictEqual(byPath.get('todo-glass-app/src/App.jsx'), 'Composes layout + components');
  });

  it('leaves the scaffold’s own files without a purpose, as the author wrote them', () => {
    // The distinction the author drew: annotated files are ones they expect to be
    // authored, unannotated ones are what `npm create vite` produces.
    assert.strictEqual(byPath.get('todo-glass-app/package.json'), '');
    assert.strictEqual(byPath.get('todo-glass-app/src/main.jsx'), '');
    assert.strictEqual(byPath.get('todo-glass-app/vite.config.js'), '');
  });

  it('lists directories as directories rather than as files', () => {
    const entries = fileTree.parse(structure.detail);
    const dirs = entries.filter((entry) => entry.isDir).map((entry) => entry.path);
    assert.ok(dirs.includes('todo-glass-app/src/components'));
    assert.strictEqual(
      files.some((file) => file.path.endsWith('/components')),
      false
    );
  });
});

describe('fileTree.parse — other drawings of the same thing', () => {
  it('reads the ASCII form', () => {
    const tree = ['app/', '|-- src/', '|   |-- main.py', '|   `-- util.py', '`-- README.md'].join('\n');
    const paths = fileTree.files(tree).map((file) => file.path);
    assert.deepStrictEqual(paths, ['app/src/main.py', 'app/src/util.py', 'app/README.md']);
  });

  it('reads plain indentation with no guides at all', () => {
    const tree = ['project/', '    server/', '        api.js', '        db.js', '    index.js'].join('\n');
    const paths = fileTree.files(tree).map((file) => file.path);
    assert.deepStrictEqual(paths, ['project/server/api.js', 'project/server/db.js', 'project/index.js']);
  });

  it('stops at the prose after the tree', () => {
    const text = ['src/', '├── a.js', '└── b.js', '', 'Keep the logic out of the components where possible.'].join('\n');
    const paths = fileTree.files(text).map((file) => file.path);
    assert.deepStrictEqual(paths, ['src/a.js', 'src/b.js']);
  });
});

describe('fileTree.withoutTree', () => {
  const structure = requestPlan.fromRequest(BRIEF).items.find((item) => /Folder Structure/.test(item.text));
  const prose = fileTree.withoutTree(structure.detail);

  it('takes every filename out', () => {
    // Fifteen filenames in front of a small model compete with the one filename in the
    // instruction. Measured: asked for `tailwind.config.js` with the tree in view,
    // `qwen3.5:0.8b` returned a `package.json`.
    assert.strictEqual(/TodoItem\.jsx|useTodos\.js|package\.json/.test(prose), false, prose);
  });

  it('keeps the instructions written around it', () => {
    assert.match(prose, /do not flatten it/);
    assert.match(prose, /components stay presentational/);
  });

  it('leaves text with no tree in it alone', () => {
    const plain = 'Add a delete button to the row and wire it to the hook.';
    assert.strictEqual(fileTree.withoutTree(plain), plain);
  });
});

describe('fileTree.hasTree', () => {
  it('refuses a flat list of filenames', () => {
    // No directories to join onto: read as a tree, every path would be wrong.
    assert.strictEqual(fileTree.hasTree('main.js\nutil.js\nREADME.md'), false);
  });

  it('refuses prose', () => {
    assert.strictEqual(fileTree.hasTree('Put the hook in src/hooks and the components in src/components.'), false);
  });

  it('accepts a drawing with two levels', () => {
    assert.strictEqual(fileTree.hasTree('src/\n├── a.js\n└── b.js'), true);
  });
});
