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

describe('dictation.renderContracts', () => {
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
