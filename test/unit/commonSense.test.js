'use strict';

const assert = require('assert');

const commonSense = require('../../app/core/commonSense');

const FILES = [
  'src/main.js',
  'src/api.js',
  'src/hooks/useTodos.js',
  'src/components/TodoInput.jsx',
  'README.md',
  'vite.config.js',
  'package.json',
];

describe('commonSense.referencedPaths', () => {
  it('finds the filenames in a request', () => {
    assert.deepStrictEqual(commonSense.referencedPaths('update src/main.js and README.md'), [
      'src/main.js',
      'README.md',
    ]);
  });

  it('is not fooled by prose that names no file', () => {
    assert.deepStrictEqual(commonSense.referencedPaths('update the parser so it handles decimals'), []);
  });

  it('ignores a version number', () => {
    assert.deepStrictEqual(commonSense.referencedPaths('upgrade to react 18.2'), []);
  });

  it('reads a backtick-quoted path', () => {
    assert.deepStrictEqual(commonSense.referencedPaths('fix `src/main.js` please'), ['src/main.js']);
  });

  it('normalises a windows separator', () => {
    assert.deepStrictEqual(commonSense.referencedPaths('edit src\\main.js'), ['src/main.js']);
  });
});

describe('commonSense.nearMatches', () => {
  it('finds the file a transposition was meant to name', () => {
    assert.deepStrictEqual(commonSense.nearMatches('mian.js', FILES), ['src/main.js']);
  });

  it('matches on the basename, not the folders around it', () => {
    assert.deepStrictEqual(commonSense.nearMatches('app/usetodo.js', FILES), ['src/hooks/useTodos.js']);
  });

  it('does not call a right name in a wrong folder a typo', () => {
    // Nothing was misspelled. `existsIn` claims this one, and the model resolves it
    // from the workspace listing it is already given.
    assert.strictEqual(commonSense.existsIn('app/useTodos.js', FILES), true);
    assert.strictEqual(commonSense.interpret({ task: 'update app/useTodos.js', files: FILES }).kind, 'ok');
  });

  it('refuses to call a different extension a typo', () => {
    // `main.js` and `main.css` score high on characters and are never the same mistake.
    assert.deepStrictEqual(commonSense.nearMatches('main.css', FILES), []);
  });

  it('refuses to judge a name too short to judge', () => {
    // `a.js` and `b.js` are one edit apart and have nothing to do with each other.
    assert.deepStrictEqual(commonSense.nearMatches('a.js', ['b.js', 'c.js']), []);
  });

  it('finds nothing for a genuinely new name', () => {
    assert.deepStrictEqual(commonSense.nearMatches('parser.js', FILES), []);
  });
});

describe('commonSense.interpret — a misspelled file', () => {
  it('reads a typo as the file that exists', () => {
    const reading = commonSense.interpret({ task: 'update mian.js to add a header', files: FILES });

    assert.strictEqual(reading.kind, 'repaired');
    assert.strictEqual(reading.task, 'update src/main.js to add a header');
    // Both names, so the user can see their request was altered and disagree with it.
    assert.match(reading.note, /mian\.js/);
    assert.match(reading.note, /src\/main\.js/);
  });

  it('leaves a name the user is inventing alone', () => {
    assert.strictEqual(commonSense.interpret({ task: 'create mian.js', files: FILES }).kind, 'ok');
    assert.strictEqual(commonSense.interpret({ task: 'add a new file called mian.js', files: FILES }).kind, 'ok');
  });

  it('is not put off by the word "add" later in the sentence', () => {
    // The verb that governs the filename is the one in front of it. A whole-message
    // test reads this as a creation and silently declines to help.
    const reading = commonSense.interpret({ task: 'update mian.js to add a header', files: FILES });
    assert.strictEqual(reading.kind, 'repaired');
  });

  it('corrects only the half of the request that is wrong', () => {
    const reading = commonSense.interpret({ task: 'read mian.js and create parser.js', files: FILES });
    assert.strictEqual(reading.kind, 'repaired');
    assert.match(reading.task, /src\/main\.js/);
    // The invented name survives untouched.
    assert.match(reading.task, /parser\.js/);
  });

  it('says nothing about a file that simply does not exist yet', () => {
    assert.strictEqual(commonSense.interpret({ task: 'update parser.js', files: FILES }).kind, 'ok');
  });

  it('says nothing when the file is right', () => {
    assert.strictEqual(commonSense.interpret({ task: 'read src/main.js', files: FILES }).kind, 'ok');
  });

  it('matches a bare filename against its full path', () => {
    // A user naming a file rarely types its folders.
    assert.strictEqual(commonSense.interpret({ task: 'read useTodos.js', files: FILES }).kind, 'ok');
  });

  it('asks when two files are equally plausible', () => {
    const files = ['src/todo.js', 'src/todos.js'];
    const reading = commonSense.interpret({ task: 'update todoo.js', files });

    assert.strictEqual(reading.kind, 'ask');
    assert.strictEqual(reading.clarification.options.length, 2);
    assert.ok(reading.clarification.options.some((option) => option.label === 'src/todo.js'));
  });

  it('leaves an ambiguous name alone when nothing can ask', () => {
    const files = ['src/todo.js', 'src/todos.js'];
    const reading = commonSense.interpret({ task: 'update todoo.js', files, canAsk: false });
    assert.strictEqual(reading.kind, 'ok');
  });

  it('says nothing without a workspace listing to check against', () => {
    assert.strictEqual(commonSense.interpret({ task: 'update mian.js', files: [] }).kind, 'ok');
  });
});

describe('commonSense.interpret — a reference to nothing', () => {
  it('takes "fix it" as the file the user is looking at', () => {
    const reading = commonSense.interpret({ task: 'fix it', files: FILES, editorPath: 'src/api.js' });

    assert.strictEqual(reading.kind, 'repaired');
    assert.match(reading.task, /src\/api\.js/);
  });

  it('leaves it alone when an earlier turn gives "it" something to mean', () => {
    const reading = commonSense.interpret({
      task: 'fix it',
      files: FILES,
      conversation: [{ role: 'user', text: 'the parser drops decimals' }],
    });
    assert.strictEqual(reading.kind, 'ok');
  });

  it('asks when there is nothing at all for "it" to refer to', () => {
    const reading = commonSense.interpret({ task: 'fix it', files: FILES });

    assert.strictEqual(reading.kind, 'ask');
    assert.match(reading.clarification.question, /fix/);
    assert.ok(reading.clarification.options.length >= 2);
  });

  it('does not fire on a message that merely starts with the same verb', () => {
    assert.strictEqual(commonSense.interpret({ task: 'fix the parser in src/main.js', files: FILES }).kind, 'ok');
    assert.strictEqual(commonSense.interpret({ task: 'update items in the list', files: FILES }).kind, 'ok');
  });
});
