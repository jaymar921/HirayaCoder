'use strict';

/**
 * `read_file` carrying the files it imports.
 *
 * The benchmark failure this answers: five turns of orientation before a model could
 * write one component, on hardware where a turn is tens of seconds.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const readFile = require('../../app/agent/tools/readFile');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');

describe('read_file following imports', function () {
  this.timeout(20000);

  /** @type {string} */
  let root;
  /** @type {object} */
  let context;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-readimports-')));
    fs.mkdirSync(path.join(root, 'src', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'components'), { recursive: true });

    fs.writeFileSync(
      path.join(root, 'src', 'App.jsx'),
      [
        "import React from 'react';",
        "import { useTodos } from './hooks/useTodos';",
        "import TodoInput from './components/TodoInput';",
        '',
        'export default function App() {',
        '  const { todos } = useTodos();',
        '  return <TodoInput todos={todos} />;',
        '}',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(root, 'src', 'hooks', 'useTodos.js'),
      'export function useTodos() {\n  return { todos: [], addTodo() {}, removeTodo() {} };\n}\n'
    );
    fs.writeFileSync(
      path.join(root, 'src', 'components', 'TodoInput.jsx'),
      'export default function TodoInput({ onAdd }) {\n  return <form onSubmit={onAdd} />;\n}\n'
    );

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
      maxObservationTokens: 2000,
    };
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  it('includes the workspace files the read file imports', async () => {
    const result = await readFile({ path: 'src/App.jsx' }, context);

    assert.strictEqual(result.ok, true);
    assert.match(result.observation, /Files src\/App\.jsx imports/);
    // What the model actually needed: the hook's return shape and the component's props.
    assert.match(result.observation, /addTodo\(\) \{\}/);
    assert.match(result.observation, /function TodoInput\(\{ onAdd \}\)/);
    assert.deepStrictEqual(result.detail.imports, ['src/hooks/useTodos.js', 'src/components/TodoInput.jsx']);
  });

  it('leaves out a bare package specifier', async () => {
    const result = await readFile({ path: 'src/App.jsx' }, context);
    assert.ok(!result.detail.imports.some((p) => p.includes('react')), 'a node_modules package was pulled in');
  });

  it('still returns the file the model asked for, in full, first', async () => {
    const result = await readFile({ path: 'src/App.jsx' }, context);
    const importsAt = result.observation.indexOf('Files src/App.jsx imports');
    assert.ok(importsAt > 0);
    assert.match(result.observation.slice(0, importsAt), /export default function App/);
  });

  it('says nothing about imports for a file that has none', async () => {
    const result = await readFile({ path: 'src/hooks/useTodos.js' }, context);
    assert.ok(!result.observation.includes('imports, included'));
    assert.deepStrictEqual(result.detail.imports, []);
  });

  it('can be turned off by the caller', async () => {
    const result = await readFile({ path: 'src/App.jsx' }, { ...context, followImports: false });
    assert.deepStrictEqual(result.detail.imports, []);
    assert.match(result.observation, /export default function App/);
  });

  it('does not follow imports out of the workspace', async () => {
    fs.writeFileSync(path.join(root, 'src', 'escape.js'), "import secret from '../../secret';\nexport const a = 1;\n");
    const result = await readFile({ path: 'src/escape.js' }, context);
    assert.deepStrictEqual(result.detail.imports, []);
  });

  it('leaves the untruncated content in detail for write_file to diff against', async () => {
    // The imports must not leak into the content used as the write baseline.
    const result = await readFile({ path: 'src/App.jsx' }, context);
    assert.ok(!result.detail.content.includes('useTodos() {\n  return { todos:'));
    assert.strictEqual(result.detail.content, fs.readFileSync(path.join(root, 'src', 'App.jsx'), 'utf8'));
  });
});
