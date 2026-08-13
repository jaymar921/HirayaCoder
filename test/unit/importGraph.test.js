'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const importGraph = require('../../app/core/importGraph');

describe('importGraph', () => {
  describe('parseSpecifiers', () => {
    it('reads the shapes a React file actually uses', () => {
      const found = importGraph.parseSpecifiers(
        [
          "import React from 'react';",
          "import { useTodos } from './hooks/useTodos';",
          "import TodoInput from '../components/TodoInput.jsx';",
          "import './index.css';",
          "export { helper } from './lib/helper';",
        ].join('\n')
      );

      assert.deepStrictEqual(found.sort(), [
        '../components/TodoInput.jsx',
        './hooks/useTodos',
        './index.css',
        './lib/helper',
        'react',
      ]);
    });

    it('reads a multi-line import, where only the closing line names the module', () => {
      const found = importGraph.parseSpecifiers('import {\n  a,\n  b,\n} from "./util";\n');
      assert.deepStrictEqual(found, ['./util']);
    });

    it('reads require and dynamic import', () => {
      const found = importGraph.parseSpecifiers("const x = require('./x');\nconst y = await import('./y');\n");
      assert.deepStrictEqual(found.sort(), ['./x', './y']);
    });

    it('reads a CSS @import, with and without url()', () => {
      const found = importGraph.parseSpecifiers("@import './base.css';\n@import url('./theme.css');\n");
      assert.deepStrictEqual(found.sort(), ['./base.css', './theme.css']);
    });

    it('finds nothing in a file with no imports', () => {
      assert.deepStrictEqual(importGraph.parseSpecifiers('const a = 1;\n'), []);
      assert.deepStrictEqual(importGraph.parseSpecifiers(''), []);
    });

    it('does not backtrack on a long run of whitespace after a keyword', function () {
      // The patterns run over whole source files, including generated ones. A pattern
      // where two quantifiers can claim the same whitespace takes seconds here.
      this.timeout(1000);
      const started = Date.now();
      importGraph.parseSpecifiers(`import ${' '.repeat(50000)}x`);
      assert.ok(Date.now() - started < 500, 'parsing a pathological line was not linear');
    });
  });

  describe('candidatesFor', () => {
    it('resolves a relative specifier against the importing file', () => {
      const candidates = importGraph.candidatesFor('./hooks/useTodos', 'src/App.jsx');
      assert.ok(candidates.includes('src/hooks/useTodos.js'));
      assert.ok(candidates.includes('src/hooks/useTodos.jsx'));
      assert.ok(candidates.includes('src/hooks/useTodos/index.js'));
    });

    it('keeps an extension the specifier already gave', () => {
      const candidates = importGraph.candidatesFor('./TodoItem.jsx', 'src/components/TodoList.jsx');
      assert.ok(candidates.includes('src/components/TodoItem.jsx'));
      assert.ok(
        !candidates.includes('src/components/TodoItem.jsx.js'),
        'an extension was appended to a specifier that already had one'
      );
    });

    it('climbs with ../', () => {
      const candidates = importGraph.candidatesFor('../hooks/useTodos', 'src/components/TodoList.jsx');
      assert.ok(candidates.includes('src/hooks/useTodos.js'));
    });

    it('refuses to leave the workspace', () => {
      assert.deepStrictEqual(importGraph.candidatesFor('../../secrets', 'src/App.jsx'), []);
    });

    it('ignores a bare package specifier', () => {
      assert.deepStrictEqual(importGraph.candidatesFor('react', 'src/App.jsx'), []);
      assert.deepStrictEqual(importGraph.candidatesFor('lucide-react', 'src/App.jsx'), []);
    });

    it('tries the conventional source aliases', () => {
      const candidates = importGraph.candidatesFor('@/hooks/useTodos', 'app/src/App.jsx');
      assert.ok(candidates.includes('src/hooks/useTodos.js'));
      assert.ok(candidates.includes('app/src/hooks/useTodos.js'));
    });
  });

  describe('resolveImports', () => {
    /** @type {string} */
    let root;

    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-imports-')));
      fs.mkdirSync(path.join(root, 'src', 'hooks'), { recursive: true });
      fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'hooks', 'useTodos.js'), 'export function useTodos() {}\n');
      fs.writeFileSync(path.join(root, 'src', 'components', 'TodoInput.jsx'), 'export default function TodoInput() {}\n');
      fs.writeFileSync(path.join(root, 'src', 'index.css'), 'body { margin: 0; }\n');
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

    it('returns only the specifiers that are real files in the workspace', async () => {
      const resolved = await importGraph.resolveImports({
        content: [
          "import React from 'react';",
          "import { useTodos } from './hooks/useTodos';",
          "import TodoInput from './components/TodoInput';",
          "import Missing from './components/TodoItem';",
          "import './index.css';",
        ].join('\n'),
        path: 'src/App.jsx',
        workspaceRoot: root,
      });

      assert.deepStrictEqual(resolved, ['src/hooks/useTodos.js', 'src/components/TodoInput.jsx', 'src/index.css']);
    });

    it('never reports the file as importing itself', async () => {
      fs.writeFileSync(path.join(root, 'src', 'hooks', 'index.js'), "export * from './index';\n");
      const resolved = await importGraph.resolveImports({
        content: "export * from './index';\n",
        path: 'src/hooks/index.js',
        workspaceRoot: root,
      });
      assert.deepStrictEqual(resolved, []);
    });

    it('honours the cap', async () => {
      const resolved = await importGraph.resolveImports({
        content: "import './hooks/useTodos';\nimport './components/TodoInput';\nimport './index.css';\n",
        path: 'src/App.jsx',
        workspaceRoot: root,
        max: 2,
      });
      assert.strictEqual(resolved.length, 2);
    });

    it('returns nothing without a workspace root', async () => {
      const resolved = await importGraph.resolveImports({
        content: "import './hooks/useTodos';",
        path: 'src/App.jsx',
        workspaceRoot: '',
      });
      assert.deepStrictEqual(resolved, []);
    });
  });
});
