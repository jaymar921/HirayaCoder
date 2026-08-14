'use strict';

/**
 * The rules for code that fails because something in it does not exist.
 *
 * This is the commonest way code written by a small model fails at runtime, and until
 * 0.7.0 none of it matched a rule — the model got a stack trace, the generic "the error
 * points at a file" fallback, and no mention of the name that was actually missing. It
 * then rewrote the file from memory and produced the same error.
 *
 * What each of these asserts is not "a rule matched" but "the sentence names the
 * symbol", because that is the difference between a diagnosis a 1B model can act on and
 * one it cannot.
 */

const assert = require('assert');

const { diagnose } = require('../../app/agent/scriptDiagnosis');

/** @param {string} stderr */
function of(stderr) {
  return diagnose({ stderr, stdout: '', code: 1 }, { command: 'node src/main.js' });
}

describe('scriptDiagnosis — undefined symbols', () => {
  it('names the identifier a ReferenceError is about', () => {
    const result = of('ReferenceError: addTodo is not defined\n    at Object.<anonymous> (/app/src/main.js:4:11)');

    assert.strictEqual(result.reason, 'UNDEFINED_SYMBOL');
    assert.match(result.summary, /addTodo/);
    assert.match(result.fix, /`addTodo`/);
    assert.match(result.fix, /import|define/i);
    assert.strictEqual(result.fixFirst, true, 'the file must be fixed before the command is run again');
    assert.strictEqual(result.retryable, false);
  });

  it('names the identifier a python NameError is about', () => {
    const result = of("Traceback (most recent call last):\n  File \"main.py\", line 3\nNameError: name 'render' is not defined");

    assert.strictEqual(result.reason, 'UNDEFINED_SYMBOL');
    assert.match(result.fix, /`render`/);
  });

  it('names the symbol javac could not find', () => {
    const result = of(
      'Main.java:7: error: cannot find symbol\n        greeter.greet();\n        ^\n  symbol:   method greet\n  location: variable greeter'
    );

    assert.strictEqual(result.reason, 'UNDEFINED_SYMBOL');
    assert.match(result.fix, /`greet`/);
  });

  it('does not mistake an ESM module error for an undefined variable', () => {
    // `module is not defined in ES module scope` is a ReferenceError with a completely
    // different fix, and MODULE_SYSTEM has to keep claiming it.
    const result = of('ReferenceError: module is not defined in ES module scope');
    assert.strictEqual(result.reason, 'MODULE_SYSTEM');
  });
});

describe('scriptDiagnosis — reading a property of nothing', () => {
  it('names the property and says the holder is the problem', () => {
    const result = of("TypeError: Cannot read properties of undefined (reading 'map')");

    assert.strictEqual(result.reason, 'UNDEFINED_PROPERTY');
    assert.match(result.fix, /`map`/);
    // The point of the sentence: fix what produced the undefined, not the line that
    // read it. A model told only "map failed" adds a `?.` and moves on.
    assert.match(result.fix, /Fix the source of the undefined/i);
    assert.strictEqual(result.fixFirst, true);
  });

  it('handles the older node phrasing too', () => {
    const result = of("TypeError: Cannot read property 'length' of null");
    assert.strictEqual(result.reason, 'UNDEFINED_PROPERTY');
    assert.match(result.fix, /`length`/);
    assert.match(result.fix, /null/);
  });

  it('explains a python NoneType attribute error as a None, not a typo', () => {
    const result = of("AttributeError: 'NoneType' object has no attribute 'title'");
    assert.strictEqual(result.reason, 'UNDEFINED_PROPERTY');
    assert.match(result.fix, /None/);
    assert.match(result.fix, /rather than the line that used it/i);
  });

  it('suggests a spelling check for an attribute on a real class', () => {
    const result = of("AttributeError: 'Parser' object has no attribute 'parseAll'");
    assert.match(result.fix, /`parseAll`/);
    assert.match(result.fix, /spelled differently/i);
  });

  it('reads a NullPointerException as a null that should have been set', () => {
    const result = of('Exception in thread "main" java.lang.NullPointerException\n\tat Main.main(Main.java:9)');
    assert.strictEqual(result.reason, 'NULL_DEREFERENCE');
    assert.match(result.fix, /initialise the field|pass the argument/i);
  });
});

describe('scriptDiagnosis — calling something that is not a function', () => {
  it('names the call and points at the import shape', () => {
    const result = of('TypeError: todos.map is not a function');

    assert.strictEqual(result.reason, 'NOT_A_FUNCTION');
    assert.match(result.fix, /`todos\.map`/);
    assert.match(result.fix, /default vs named/i);
  });
});

describe('scriptDiagnosis — the rules that were already there', () => {
  it('still prefers a missing file over a missing package', () => {
    const result = of("Error: Cannot find module '/app/src/main.js'");
    assert.strictEqual(result.reason, 'WRONG_PATH');
  });

  it('still recognises a missing dependency', () => {
    const result = of("Error: Cannot find module 'express'");
    assert.strictEqual(result.reason, 'MISSING_DEPENDENCY');
  });

  it('still says nothing about output that means nothing', () => {
    assert.strictEqual(diagnose({ stderr: '', stdout: 'ok', code: 1 }, { command: 'true' }), null);
  });

  it('gives the same answer twice for the same input', () => {
    // The rules are `exec`ed rather than `test`ed now, so a stateful regex would show
    // up as a second call returning null.
    const text = 'ReferenceError: addTodo is not defined';
    assert.deepStrictEqual(of(text), of(text));
  });
});
