'use strict';

/**
 * Asking a small model for a file rather than for a decision.
 *
 * The extraction tests are written from real replies: `llama3.2:1b` and `qwen3.5:0.8b`
 * both answer with a prose sentence, a fence, and sometimes a second fence showing how
 * to use the thing they just wrote. The rule that matters is the negative one — a reply
 * that talks *about* a file must never be written to disk as that file.
 */

const assert = require('assert');

const dictation = require('../../app/agent/dictation');

describe('dictation.extractCode', () => {
  it('takes the code out of a fenced reply', () => {
    const reply = 'Here is the component:\n\n```jsx\nexport default function TodoItem() {\n  return <li>hi</li>;\n}\n```\n';
    const { code } = dictation.extractCode(reply);
    assert.match(code, /export default function TodoItem/);
    assert.strictEqual(code.includes('```'), false);
    assert.strictEqual(code.includes('Here is'), false);
  });

  it('takes the first block when the model adds a usage example after it', () => {
    const reply = [
      '```js',
      'export const useTodos = () => ({ todos: [] });',
      '```',
      '',
      'You can use it like this:',
      '',
      '```jsx',
      'const { todos } = useTodos();',
      '```',
    ].join('\n');
    const { code } = dictation.extractCode(reply);
    assert.match(code, /export const useTodos/);
    assert.strictEqual(code.includes('You can use it'), false);
    assert.strictEqual(code.includes('const { todos } = useTodos();'), false);
  });

  it('refuses a reply the token budget cut off mid-file', () => {
    // Half a component compiles about half the time and then fails somewhere else,
    // which is worse than writing nothing at all.
    const reply = '```jsx\nexport default function TodoItem({ todo }) {\n  return (\n    <li className="flex';
    const { code, reason } = dictation.extractCode(reply);
    assert.strictEqual(code, null);
    assert.match(reason, /cut off/);
  });

  it('refuses prose about the file', () => {
    const reply =
      'I would suggest using a dedicated library for this rather than writing it by hand, ' +
      'because handling the edit state correctly is quite involved and easy to get wrong.';
    const { code, reason } = dictation.extractCode(reply);
    assert.strictEqual(code, null);
    assert.match(reason, /instead of writing it/);
  });

  it('accepts an unfenced reply that is plainly source', () => {
    const reply = "import { useState } from 'react';\n\nexport default function App() {\n  return <div>hello there</div>;\n}\n";
    const { code } = dictation.extractCode(reply);
    assert.match(code, /export default function App/);
  });

  it('refuses an empty code block', () => {
    const { code, reason } = dictation.extractCode('```jsx\n\n```');
    assert.strictEqual(code, null);
    assert.match(reason, /empty/);
  });

  it('refuses an empty reply', () => {
    assert.strictEqual(dictation.extractCode('').code, null);
    assert.strictEqual(dictation.extractCode('   ').code, null);
  });
});

describe('dictation.exportsOf', () => {
  it('reads a declared default export', () => {
    assert.deepStrictEqual(dictation.exportsOf('export default function TodoItem() {}'), {
      default: 'TodoItem',
      named: [],
    });
  });

  it('reads a default export of an already-declared name', () => {
    const source = 'function App() {}\n\nexport default App;\n';
    assert.strictEqual(dictation.exportsOf(source).default, 'App');
  });

  it('reads named exports, declared and listed', () => {
    const source = ['export const MAX = 5;', 'function helper() {}', 'export { helper };'].join('\n');
    const found = dictation.exportsOf(source);
    assert.deepStrictEqual(found.named.sort(), ['MAX', 'helper']);
  });

  it('reads a renamed export by the name it is exported under', () => {
    const found = dictation.exportsOf('const internal = 1;\nexport { internal as useTodos };');
    assert.deepStrictEqual(found.named, ['useTodos']);
  });

  it('reports nothing for a module that exports nothing', () => {
    assert.deepStrictEqual(dictation.exportsOf('const x = 1;'), { default: '', named: [] });
  });
});

describe('dictation.exportsOf — languages that have no export statement', () => {
  // Measured on the POS sweeps: every Python and Java file reported "no exports found",
  // because the reader only understood JavaScript. That is worse than silence — it is a
  // paragraph of prompt asserting that the module the next file has to import offers
  // nothing at all.
  const PYTHON = [
    'import json',
    '',
    'class FileProductRepository(ProductRepository):',
    '    def __init__(self): pass',
    '    def add(self, product): pass',
    '',
    'def build_default(): pass',
    '',
    'def _internal(): pass',
  ].join('\n');

  it('reads a Python module’s top-level classes and functions', () => {
    const found = dictation.exportsOf(PYTHON, 'pos_app/repository/file_product_repository.py');
    assert.deepStrictEqual(found.named.sort(), ['FileProductRepository', 'build_default']);
  });

  it('leaves out the underscore-private names, and the methods inside a class', () => {
    const found = dictation.exportsOf(PYTHON, 'a/b.py');
    assert.strictEqual(found.named.includes('_internal'), false);
    assert.strictEqual(found.named.includes('add'), false, 'a method is not a module-level name');
  });

  it('believes an explicit __all__ over its own scan', () => {
    const source = '__all__ = ["Product"]\n\nclass Product: pass\n\ndef helper(): pass\n';
    assert.deepStrictEqual(dictation.exportsOf(source, 'm.py').named, ['Product']);
  });

  it('reads a Java file’s public type and its package', () => {
    const source = 'package com.pos.app.service;\n\npublic class ProductService {\n  public void add() {}\n}\n';
    const found = dictation.exportsOf(source, 'src/main/java/com/pos/app/service/ProductService.java');
    assert.deepStrictEqual(found.named, ['ProductService']);
    assert.strictEqual(found.default, 'com.pos.app.service');
  });

  it('still reads a package-private Java type, which its own package can import', () => {
    const found = dictation.exportsOf('package a.b;\n\nclass Helper {}\n', 'Helper.java');
    assert.deepStrictEqual(found.named, ['Helper']);
  });

  it('leaves JavaScript to the JavaScript reader', () => {
    assert.strictEqual(dictation.exportsOf('export default function App() {}', 'src/App.jsx').default, 'App');
  });
});

describe('dictation.renderContracts', () => {
  it('words the contract the way each language imports', () => {
    const rendered = dictation.renderContracts([
      { path: 'pos_app/service/product_service.py', source: 'class ProductService:\n    pass\n' },
      { path: 'src/main/java/com/pos/app/Main.java', source: 'package com.pos.app;\npublic class Main {}\n' },
      { path: 'src/TodoList.jsx', source: 'export default function TodoList() {}' },
    ]);
    assert.match(rendered, /product_service\.py — defines `ProductService`/);
    assert.match(rendered, /Main\.java — package `com\.pos\.app`; declares `Main`/);
    assert.match(rendered, /TodoList\.jsx — default export `TodoList`/);
    assert.strictEqual(/no exports found/.test(rendered), false);
  });
});

describe('dictation.renderContracts (JavaScript)', () => {
  it('states what each existing file offers, so the import is not a guess', () => {
    // The 0.7.0 session lost an hour to four missing default exports and two prop-name
    // mismatches, every one of them found only when the user pasted a console error.
    const rendered = dictation.renderContracts([
      { path: 'src/hooks/useTodos.js', source: 'export function useTodos() {}' },
      { path: 'src/components/TodoList.jsx', source: 'export default function TodoList() {}' },
    ]);
    assert.match(rendered, /useTodos\.js — named exports `useTodos`/);
    assert.match(rendered, /TodoList\.jsx — default export `TodoList`/);
    assert.match(rendered, /do not guess/);
  });

  it('says nothing when nothing exists yet', () => {
    assert.strictEqual(dictation.renderContracts([]), '');
  });
});

describe('dictation.matchesPath', () => {
  // The failure this was written from, measured on `qwen3.5:0.8b`: asked for
  // `tailwind.config.js` it returned a `package.json`, and asked for
  // `postcss.config.js` it returned the App component. Nothing was wrong with the files
  // it wrote — they were answers to a different question, and both landed on disk.
  it('refuses a package.json written over a config module', () => {
    const manifest = '{\n  "name": "todo-glass-app",\n  "dependencies": { "react": "^18.2.0" }\n}';
    const verdict = dictation.matchesPath('tailwind.config.js', manifest);
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.reason, /not JavaScript or TypeScript/);
  });

  it('refuses a React component written over a stylesheet', () => {
    const component = "import React from 'react';\n\nexport default function App() { return <div />; }";
    assert.strictEqual(dictation.matchesPath('src/index.css', component).ok, false);
  });

  it('refuses prose written over a JSON file', () => {
    assert.strictEqual(dictation.matchesPath('data.json', 'const a = 1;').ok, false);
  });

  it('accepts a module that opens with an object literal', () => {
    // `export default { plugins: {...} }` is a real postcss config and is not JSON.
    assert.strictEqual(dictation.matchesPath('postcss.config.js', 'export default {\n  plugins: {},\n};').ok, true);
  });

  it('accepts each kind of file at its own extension', () => {
    assert.strictEqual(dictation.matchesPath('package.json', '{"name":"x"}').ok, true);
    assert.strictEqual(dictation.matchesPath('src/App.jsx', 'export default function App() {}').ok, true);
    assert.strictEqual(dictation.matchesPath('src/index.css', '@tailwind base;\nbody { margin: 0; }').ok, true);
    assert.strictEqual(dictation.matchesPath('index.html', '<!doctype html><div id="root"></div>').ok, true);
  });

  it('has no opinion about an extension it does not know', () => {
    assert.strictEqual(dictation.matchesPath('README.md', 'Anything at all goes here.').ok, true);
    assert.strictEqual(dictation.matchesPath('notes.txt', 'free text').ok, true);
  });
});

describe('dictation.buildPrompt', () => {
  const prompt = dictation.buildPrompt({
    path: 'src/components/TodoItem.jsx',
    purpose: 'Single todo row (edit/delete/toggle)',
    spec: 'Delete Todo: remove a single todo with a fade-out transition.',
    constraints: 'No external UI libraries.',
    related: [{ path: 'src/hooks/useTodos.js', source: 'export function useTodos() {}' }],
  });

  it('names the file, its purpose, and the rules', () => {
    assert.match(prompt, /complete contents of the file src\/components\/TodoItem\.jsx/);
    assert.match(prompt, /Single todo row/);
    assert.match(prompt, /No external UI libraries/);
    assert.match(prompt, /useTodos\.js/);
  });

  it('restates the path last, after the background', () => {
    // Background competes with the instruction and the instruction is one filename. The
    // first version put the item's whole section — a fifteen-file folder tree — in the
    // middle and the model wrote whichever file it liked.
    const lastBlock = prompt.split('\n\n').pop();
    assert.match(lastBlock, /The file to write is src\/components\/TodoItem\.jsx, and only that file/);
  });

  it('marks the background as background', () => {
    assert.match(prompt, /for context only — do not write any other file from it/);
  });

  it('asks for a file and forbids the placeholders that pass for one', () => {
    assert.match(prompt, /one ``` code block/);
    assert.match(prompt, /no "\.\.\." placeholders/);
  });
});

describe('dictation.dictate', () => {
  /** @param {string} content */
  function clientReturning(content) {
    return {
      bodies: /** @type {any[]} */ ([]),
      async chat(body) {
        this.bodies.push(body);
        return { message: { content } };
      },
    };
  }

  it('never constrains the reply to JSON', async () => {
    // The whole module exists because the JSON grammar is what the smallest models
    // fail: schema-constrained, `llama3.2:1b` answers `{"action":"done"}`.
    const client = clientReturning('```js\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\n```');
    await dictation.dictate({ client, model: 'llama3.2:1b', path: 'src/a.js' });
    assert.strictEqual(client.bodies[0].format, undefined);
    assert.strictEqual(client.bodies[0].think, false);
  });

  it('reports the reason rather than throwing when the model call fails', async () => {
    const client = {
      async chat() {
        throw new Error('connection refused');
      },
    };
    const result = await dictation.dictate({ client, model: 'llama3.2:1b', path: 'src/a.js' });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /connection refused/);
  });

  it('reports failure rather than writing prose to disk', async () => {
    const client = clientReturning('Sure, I can help with that! What framework are you using?');
    const result = await dictation.dictate({ client, model: 'llama3.2:1b', path: 'src/a.js' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, '');
  });
});
