'use strict';

/**
 * A file written with imports that point at nothing.
 *
 * The failure this covers is the one that survived every other guard. After step
 * sessions got `qwen3.5:4b` as far as rewriting `App.jsx` for the first time, it wrote,
 * from inside `src/App.jsx`:
 *
 *     import { useTodos } from '../hooks/useTodos.js';
 *     import { TodoInput } from '../components/TodoInput.jsx';
 *
 * Both climb one level too many. The file is large, its brackets balance, it exports, no
 * body is a placeholder, and the change set grew — so the run was reported as four of
 * four items complete, and the app does not build.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const importGraph = require('../../app/core/importGraph');
const writeFile = require('../../app/agent/tools/writeFile');
const stepGuard = require('../../app/agent/stepGuard');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');

/** The exact App.jsx the benchmark produced. */
const BROKEN_APP =
  "import { useState } from 'react';\n" +
  "import './App.css';\n" +
  "import { useTodos } from '../hooks/useTodos.js';\n" +
  "import { TodoInput } from '../components/TodoInput.jsx';\n" +
  '\n' +
  'export default function App() {\n' +
  '  const { todos } = useTodos();\n' +
  '  return <TodoInput todos={todos} />;\n' +
  '}\n';

describe('imports that point at nothing', function () {
  this.timeout(20000);

  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-broken-')));
    fs.mkdirSync(path.join(root, 'src', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'hooks', 'useTodos.js'), 'export function useTodos() {}\n');
    fs.writeFileSync(path.join(root, 'src', 'components', 'TodoInput.jsx'), 'export function TodoInput() {}\n');
    fs.writeFileSync(path.join(root, 'src', 'App.css'), '.card {}\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  describe('importGraph.brokenImports', () => {
    it('catches the exact paths the benchmark produced, and names the right ones', async () => {
      const broken = await importGraph.brokenImports({
        content: BROKEN_APP,
        path: 'src/App.jsx',
        workspaceRoot: root,
      });

      assert.deepStrictEqual(
        broken.map((b) => b.specifier).sort(),
        ['../components/TodoInput.jsx', '../hooks/useTodos.js']
      );
      const byName = Object.fromEntries(broken.map((b) => [b.specifier, b.suggestion]));
      assert.strictEqual(byName['../hooks/useTodos.js'], './hooks/useTodos.js');
      assert.strictEqual(byName['../components/TodoInput.jsx'], './components/TodoInput.jsx');
    });

    it('says nothing about a file whose imports all resolve', async () => {
      const good = BROKEN_APP.replace(/\.\.\//g, './');
      assert.deepStrictEqual(
        await importGraph.brokenImports({ content: good, path: 'src/App.jsx', workspaceRoot: root }),
        []
      );
    });

    it('ignores bare package specifiers, which are not the model\'s routing', async () => {
      const broken = await importGraph.brokenImports({
        content: "import React from 'react';\nimport x from 'lucide-react';\n",
        path: 'src/App.jsx',
        workspaceRoot: root,
      });
      assert.deepStrictEqual(broken, []);
    });

    it('offers no suggestion when the file genuinely does not exist anywhere', async () => {
      const broken = await importGraph.brokenImports({
        content: "import { Nope } from './Nope.jsx';\n",
        path: 'src/App.jsx',
        workspaceRoot: root,
      });
      assert.strictEqual(broken.length, 1);
      assert.strictEqual(broken[0].suggestion, null);
    });

    describe('case, which is the failure that only appears on someone else\'s machine', () => {
      // Windows and macOS both resolve './hooks/usetodos.js' to 'useTodos.js' and report
      // success, so a case-wrong import builds locally and fails on Linux CI. `stat`
      // alone cannot see it; the parent directory has to be read and the name compared.
      it('catches a wrong-case filename and suggests the real spelling', async () => {
        const broken = await importGraph.brokenImports({
          content: "import { useTodos } from './hooks/usetodos.js';\n",
          path: 'src/App.jsx',
          workspaceRoot: root,
        });

        assert.strictEqual(broken.length, 1, 'a case-wrong import was accepted');
        assert.strictEqual(broken[0].suggestion, './hooks/useTodos.js');
      });

      it('catches a wrong-case directory too', async () => {
        // Every segment matters: './Hooks/useTodos.js' is just as broken on Linux.
        const broken = await importGraph.brokenImports({
          content: "import { useTodos } from './Hooks/useTodos.js';\n",
          path: 'src/App.jsx',
          workspaceRoot: root,
        });

        assert.strictEqual(broken.length, 1, 'a case-wrong directory was accepted');
        assert.strictEqual(broken[0].suggestion, './hooks/useTodos.js');
      });

      it('still accepts the correctly-cased path', async () => {
        const broken = await importGraph.brokenImports({
          content: "import { useTodos } from './hooks/useTodos.js';\n",
          path: 'src/App.jsx',
          workspaceRoot: root,
        });
        assert.deepStrictEqual(broken, []);
      });

      it('does not report a file as existing under the wrong case', async () => {
        assert.strictEqual(await importGraph.existsExactly(root, 'src/hooks/useTodos.js'), true);
        assert.strictEqual(await importGraph.existsExactly(root, 'src/hooks/usetodos.js'), false);
        assert.strictEqual(await importGraph.existsExactly(root, 'src/Hooks/useTodos.js'), false);
        assert.strictEqual(await importGraph.existsExactly(root, 'src/hooks/missing.js'), false);
        // A directory is not a file.
        assert.strictEqual(await importGraph.existsExactly(root, 'src/hooks'), false);
      });
    });

    it('declines to guess when several files share the name', async () => {
      fs.writeFileSync(path.join(root, 'src', 'components', 'useTodos.js'), 'export function useTodos() {}\n');
      const broken = await importGraph.brokenImports({
        content: "import { useTodos } from '../../useTodos.js';\n",
        path: 'src/App.jsx',
        workspaceRoot: root,
      });
      assert.strictEqual(broken.length, 1);
      assert.strictEqual(broken[0].suggestion, null, 'a guess was offered between two candidates');
    });
  });

  describe('write_file', () => {
    /** @type {object} */
    let context;

    beforeEach(() => {
      context = {
        workspaceRoot: root,
        gate: new PermissionGate({
          workspaceRoot: root,
          modes: new PermissionModes({ initial: { autoEdit: true } }),
          auditLog: new AuditLog(root),
          confirm: async () => true,
        }),
        sessionId: '1',
        mode: 'agent',
      };
    });

    it('still writes the file, and says plainly that it cannot run', async () => {
      const result = await writeFile({ path: 'src/App.jsx', code: BROKEN_APP }, context);

      assert.strictEqual(result.ok, true, 'the write was refused, losing the content over a path');
      assert.ok(fs.existsSync(path.join(root, 'src', 'App.jsx')));
      assert.match(result.observation, /WARNING: src\/App\.jsx imports 2 file\(s\) that are not there/);
      assert.match(result.observation, /the correct path is "\.\/hooks\/useTodos\.js"/);
      assert.match(result.observation, /relative to the file doing the importing/);
    });

    it('records them so a later check does not have to touch the disk again', async () => {
      const result = await writeFile({ path: 'src/App.jsx', code: BROKEN_APP }, context);
      assert.strictEqual(result.detail.brokenImports.length, 2);
    });

    it('leaves the observation for a correct file exactly as it was', async () => {
      const result = await writeFile({ path: 'src/App.jsx', code: BROKEN_APP.replace(/\.\.\//g, './') }, context);
      assert.strictEqual(result.observation, 'Created src/App.jsx (10 lines).');
      assert.deepStrictEqual(result.detail.brokenImports, []);
    });
  });

  describe('stepGuard', () => {
    const step = (over) => ({ action: { action: 'write_file' }, result: { ok: true, ...over } });

    it('fails a step whose written file cannot run', () => {
      const verdict = stepGuard.verify({
        item: 'Update src/App.jsx to use the hook',
        stopReason: 'done',
        changed: [{ kind: 'edit', path: 'src/App.jsx' }],
        steps: [
          step({
            detail: {
              path: 'src/App.jsx',
              brokenImports: [{ specifier: '../hooks/useTodos.js', suggestion: './hooks/useTodos.js' }],
            },
          }),
        ],
      });

      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, 'broken-imports');
      assert.match(verdict.detail, /"\.\.\/hooks\/useTodos\.js" in src\/App\.jsx/);
    });

    it('accepts a step that wrote a broken file and then corrected it', () => {
      // Only the newest write per path counts, or a self-correcting step is failed for
      // the draft it already fixed.
      const verdict = stepGuard.verify({
        item: 'Update src/App.jsx to use the hook',
        stopReason: 'done',
        changed: [{ kind: 'edit', path: 'src/App.jsx' }],
        steps: [
          step({ detail: { path: 'src/App.jsx', brokenImports: [{ specifier: '../hooks/useTodos.js', suggestion: null }] } }),
          step({ detail: { path: 'src/App.jsx', brokenImports: [] } }),
        ],
      });

      assert.strictEqual(verdict.ok, true);
    });

    it('tells the retry to fix the paths rather than start over', () => {
      const prompt = stepGuard.rethink({
        item: 'Update src/App.jsx to use the hook',
        verdict: { ok: false, reason: 'broken-imports', detail: '2 import(s) point at nothing' },
      });

      assert.match(prompt, /The content is fine; the import paths are not/);
      assert.match(prompt, /Do not start over/);
      assert.ok(!prompt.includes('Decide the path yourself'), 'it was told to rewrite from scratch');
    });

    it('suggests fixing the paths by hand when the retry fails too', () => {
      const notice = stepGuard.workaround({
        item: 'Update src/App.jsx',
        position: 4,
        verdict: { ok: false, reason: 'broken-imports', detail: '2 import(s) point at nothing' },
        remaining: [],
        steps: [],
      });
      assert.match(notice, /fixing them by hand is usually faster/);
    });
  });
});
