'use strict';

/**
 * The webview's pure logic.
 *
 * These modules are ES modules meant for a browser, so they are pulled in with a
 * dynamic `import()` rather than `require`. Only the parts that do not touch the DOM
 * are exercised here — the rendering itself needs a document, which belongs in the
 * integration suite.
 */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const moduleUrl = (relative) =>
  pathToFileURL(path.join(__dirname, '..', '..', 'app', 'webview', relative)).href;

describe('webview markdown segmentation', () => {
  /** @type {(text: string) => Array<{type: string, content: string, lang?: string}>} */
  let segment;

  before(async () => {
    // The specifier is built from `__dirname` and a literal in this file — no input
    // reaches it. The rule cannot see that, and turning it off for the whole test
    // tree would also disarm it where it matters.
    // eslint-disable-next-line no-unsanitized/method
    ({ segment } = await import(moduleUrl('components/markdown.js')));
  });

  it('leaves ordinary prose as one text segment', () => {
    assert.deepStrictEqual(segment('Just a sentence.'), [{ type: 'text', content: 'Just a sentence.' }]);
  });

  it('extracts a fenced block with its language', () => {
    const parts = segment('Before\n\n```js\nconst a = 1;\n```\n\nAfter');

    assert.strictEqual(parts.length, 3);
    assert.strictEqual(parts[1].type, 'code');
    assert.strictEqual(parts[1].lang, 'js');
    assert.strictEqual(parts[1].content, 'const a = 1;');
  });

  it('handles a fence with no language', () => {
    const parts = segment('```\nplain\n```');
    assert.strictEqual(parts[0].type, 'code');
    assert.strictEqual(parts[0].lang, '');
    assert.strictEqual(parts[0].content, 'plain');
  });

  it('keeps braces and backticks inside a code block', () => {
    // Agent output is full of these; a naive splitter mangles them.
    const code = 'function f() {\n  return `a${b}c`;\n}';
    const parts = segment('```js\n' + code + '\n```');
    assert.strictEqual(parts[0].content, code);
  });

  it('extracts several blocks in one message', () => {
    const parts = segment('```js\none\n```\ntext\n```py\ntwo\n```');
    const code = parts.filter((p) => p.type === 'code');
    assert.strictEqual(code.length, 2);
    assert.strictEqual(code[0].content, 'one');
    assert.strictEqual(code[1].lang, 'py');
  });

  it('treats an unterminated fence as text rather than swallowing the message', () => {
    // Common while tokens are still arriving. Hiding the tail would look like a hang.
    const parts = segment('Here you go:\n```js\nconst a = 1;');
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0].type, 'text');
    assert.match(parts[0].content, /const a = 1;/);
  });

  it('is stable across repeated calls', () => {
    // The fence pattern is global and module-level; a stale lastIndex would make the
    // second call on identical input return something different.
    const text = '```js\nx\n```';
    assert.deepStrictEqual(segment(text), segment(text));
  });

  it('handles empty and null input', () => {
    assert.deepStrictEqual(segment(''), []);
    assert.deepStrictEqual(segment(null), []);
  });
});

describe('thinking indicator lines', () => {
  /** @type {any} */
  let mod;

  before(async () => {
    // See the note above — the specifier is local and literal.
    // eslint-disable-next-line no-unsanitized/method
    mod = await import(moduleUrl('components/thinkingIndicator.js'));
  });

  it('offers enough lines that a long wait does not visibly repeat', () => {
    assert.ok(mod.THINKING_LINES.length >= 8);
    assert.ok(mod.LONG_WAIT_LINES.length >= 3);
  });

  it('has no duplicate lines', () => {
    const all = [...mod.THINKING_LINES, ...mod.LONG_WAIT_LINES];
    assert.strictEqual(new Set(all).size, all.length);
  });

  it('never repeats the line it just showed', () => {
    // The rotation is what makes the wait feel alive; showing the same line twice in
    // a row reads as frozen, which is the thing this component exists to avoid.
    for (let i = 0; i < 200; i += 1) {
      const previous = mod.THINKING_LINES[i % mod.THINKING_LINES.length];
      assert.notStrictEqual(mod.pickLine(mod.THINKING_LINES, previous), previous);
    }
  });

  it('copes with a single-line pool', () => {
    assert.strictEqual(mod.pickLine(['only'], 'only'), 'only');
    assert.strictEqual(mod.pickLine([], 'x'), '');
  });
});
