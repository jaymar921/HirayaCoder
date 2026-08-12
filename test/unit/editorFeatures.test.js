'use strict';

/**
 * The pure logic behind the editor-side features: what gets sent to the model, and
 * what is allowed back into the buffer.
 */

const assert = require('assert');

require('./stubVscode').install();

const { cleanCompletion, shouldComplete } = require('../../app/features/inlineCompletion');
const { detectRunner, buildPrompt } = require('../../app/features/testGenerator');
const { isValidModelName } = require('../../app/features/modelManager');
const { ACTIONS } = require('../../app/features/codeActions');

/** A stand-in for a TextDocument, which is all `shouldComplete` reads. */
const docWith = (line) => ({ lineAt: () => ({ text: line }) });

describe('inlineCompletion.cleanCompletion', () => {
  it('keeps a plain completion', () => {
    assert.strictEqual(cleanCompletion('doSomething();', 'const x = '), 'doSomething();');
  });

  it('unwraps a code fence the model added', () => {
    assert.strictEqual(cleanCompletion('```js\nfoo();\n```', ''), 'foo();');
  });

  it('drops the prompt line the model echoed back', () => {
    // Small models routinely restate the line and append the completion; inserting
    // that verbatim duplicates whatever the user already typed.
    assert.strictEqual(cleanCompletion('const total = sum(a, b);', 'const total = '), 'sum(a, b);');
  });

  it('keeps only the first line', () => {
    // A wrong five-line block is far more disruptive to dismiss than a wrong line.
    assert.strictEqual(cleanCompletion('first();\nsecond();\nthird();', ''), 'first();');
  });

  it('returns empty for whitespace, so no invisible ghost can be accepted', () => {
    assert.strictEqual(cleanCompletion('   \n  ', ''), '');
    assert.strictEqual(cleanCompletion('', ''), '');
    assert.strictEqual(cleanCompletion(null, ''), '');
  });
});

describe('inlineCompletion.shouldComplete', () => {
  it('completes at the end of a line', () => {
    assert.strictEqual(shouldComplete(docWith('const x = '), { line: 0, character: 10 }), true);
  });

  it('stays out of the way mid-identifier', () => {
    // The editor's own IntelliSense owns this case; competing produces two
    // suggestions fighting over the same characters.
    assert.strictEqual(shouldComplete(docWith('const value = foo'), { line: 0, character: 16 }), false);
  });

  it('refuses inside a comment', () => {
    // Asked to continue a comment, a model writes prose into source.
    assert.strictEqual(shouldComplete(docWith('// explain this'), { line: 0, character: 15 }), false);
    assert.strictEqual(shouldComplete(docWith('# a python comment'), { line: 0, character: 18 }), false);
    assert.strictEqual(shouldComplete(docWith(' * jsdoc line'), { line: 0, character: 13 }), false);
  });
});

describe('testGenerator', () => {
  it('detects the runner from dependencies', () => {
    assert.strictEqual(detectRunner({ devDependencies: { mocha: '^10' } }), 'mocha');
    assert.strictEqual(detectRunner({ dependencies: { vitest: '^1' } }), 'vitest');
    assert.strictEqual(detectRunner({ devDependencies: { 'ts-jest': '^29' } }), 'jest');
  });

  it('falls back to the test script when the dependency is global', () => {
    assert.strictEqual(detectRunner({ scripts: { test: 'mocha test/**' } }), 'mocha');
  });

  it('defaults to node:test rather than guessing a framework', () => {
    // Inventing a Jest suite for a project that has no Jest produces work the user
    // has to undo.
    assert.strictEqual(detectRunner({}), 'node:test');
  });

  it('names the runner and forbids introducing another', () => {
    const prompt = buildPrompt({
      relativePath: 'src/greet.js',
      language: 'javascript',
      runner: 'mocha',
      example: null,
    });
    assert.match(prompt, /uses mocha/);
    assert.match(prompt, /do not introduce another test framework/i);
  });

  it('points at an existing test to imitate when there is one', () => {
    const prompt = buildPrompt({
      relativePath: 'src/greet.js',
      language: 'javascript',
      runner: 'mocha',
      example: 'test/unit/greet.test.js',
    });
    assert.match(prompt, /Read test\/unit\/greet\.test\.js first/);
  });
});

describe('codeActions', () => {
  it('runs Explain in Ask mode so it cannot edit anything', () => {
    // Ask mode has no tools at all, which is a stronger guarantee than asking the
    // model nicely not to change the file.
    assert.strictEqual(ACTIONS.get('explain').mode, 'ask');
  });

  it('runs the editing actions in Agent mode', () => {
    for (const id of ['refactor', 'document', 'fix']) {
      assert.strictEqual(ACTIONS.get(id).mode, 'agent', id);
    }
  });

  it('tells Explain not to rewrite', () => {
    const prompt = ACTIONS.get('explain').build({
      relativePath: 'a.js',
      language: 'javascript',
      selection: 'const a = 1;',
      diagnostics: [],
    });
    assert.match(prompt, /Do not rewrite it/i);
  });

  it('passes editor diagnostics into Fix when there are any', () => {
    const prompt = ACTIONS.get('fix').build({
      relativePath: 'a.js',
      language: 'javascript',
      selection: 'foo(',
      diagnostics: ["')' expected."],
    });
    assert.match(prompt, /The editor reports:/);
    assert.match(prompt, /'\)' expected\./);
  });
});

describe('modelManager.isValidModelName', () => {
  it('accepts ordinary names and tags', () => {
    for (const name of ['qwen3.5:2b', 'llama3.2', 'gemma4:e2b', 'my-model_v2:latest']) {
      assert.strictEqual(isValidModelName(name), true, name);
    }
  });

  it('rejects anything that could be more than a name', () => {
    for (const bad of ['', '   ', 'a:b:c', 'model; rm -rf /', '../../etc/passwd', 'model name']) {
      assert.strictEqual(isValidModelName(bad), false, bad);
    }
  });

  it('rejects an absurdly long name', () => {
    assert.strictEqual(isValidModelName('a'.repeat(500)), false);
  });
});
