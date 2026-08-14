'use strict';

const assert = require('assert');

const { ErrorRecovery, signatureOf, headline } = require('../../app/agent/errorRecovery');

/**
 * @param {object} [overrides]
 * @returns {import('../../app/agent/errorRecovery').Failure}
 */
function failure(overrides = {}) {
  return {
    action: 'run_script',
    command: 'node src/main.js',
    observation: "ReferenceError: addTodo is not defined\n    at Object.<anonymous> (/app/src/main.js:4:11)",
    diagnosed: false,
    ...overrides,
  };
}

describe('errorRecovery.signatureOf', () => {
  it('treats the same failure at different lines as the same failure', () => {
    const a = signatureOf('run_script', 'ReferenceError: x is not defined at /app/src/main.js:4:11');
    const b = signatureOf('run_script', 'ReferenceError: x is not defined at /app/src/main.js:40:2');
    assert.strictEqual(a, b);
  });

  it('treats the same failure on two machines as the same failure', () => {
    const posix = signatureOf('run_script', "Cannot find module '/home/jay/app/src/x.js'");
    const win = signatureOf('run_script', "Cannot find module 'C:\\Users\\jay\\app\\src\\x.js'");
    assert.strictEqual(posix, win);
  });

  it('keeps genuinely different failures apart', () => {
    assert.notStrictEqual(
      signatureOf('run_script', 'ReferenceError: addTodo is not defined'),
      signatureOf('run_script', 'ReferenceError: removeTodo is not defined')
    );
  });

  it('separates the same message from two different tools', () => {
    assert.notStrictEqual(signatureOf('run_script', 'EACCES'), signatureOf('write_file', 'EACCES'));
  });
});

describe('errorRecovery.headline', () => {
  it('takes the sentence, not the stack frame under it', () => {
    const text = "TypeError: todos.map is not a function\n    at App (/app/src/App.jsx:12:20)\n    at renderWithHooks";
    assert.strictEqual(headline(text), 'TypeError: todos.map is not a function');
  });

  it('skips a python traceback header to reach the error', () => {
    const text = 'Traceback (most recent call last):\n  File "main.py", line 3\nNameError: name \'foo\' is not defined';
    assert.match(headline(text), /NameError/);
  });
});

describe('ErrorRecovery.observe', () => {
  it('says nothing the first time a diagnosed failure appears', () => {
    // scriptDiagnosis already gave it a sentence; a second one saying the same thing
    // differently is noise in a context window that has none spare.
    const recovery = new ErrorRecovery();
    const decision = recovery.observe(failure({ diagnosed: true }));
    assert.strictEqual(decision.kind, 'none');
  });

  it('tells the model to read the error when nothing recognised it', () => {
    const recovery = new ErrorRecovery();
    const decision = recovery.observe(failure());
    assert.strictEqual(decision.kind, 'guidance');
    assert.match(decision.guidance, /read the error above literally/i);
  });

  it('names the count once the same failure comes back with nobody to ask', () => {
    const recovery = new ErrorRecovery({ canAsk: false });
    recovery.observe(failure());
    const second = recovery.observe(failure());

    assert.strictEqual(second.kind, 'guidance');
    assert.strictEqual(second.count, 2);
    assert.match(second.guidance, /same failure as before/i);
    assert.match(second.guidance, /2 times/);
  });

  it('asks the user the second time, which is the last moment it can', () => {
    // `reactLoop.REPEAT_LIMIT` is 2, so the loop ends the run after two identical
    // actions. Waiting for a third would mean never asking at all.
    const recovery = new ErrorRecovery();
    recovery.observe(failure());
    const second = recovery.observe(failure());

    assert.strictEqual(second.kind, 'ask');
    assert.ok(second.clarification);
    assert.ok(second.clarification.options.length >= 2 && second.clarification.options.length <= 4);
    // Recommending another attempt would recommend the thing that has already not
    // worked, with guidance in between.
    const recommended = second.clarification.options.find((option) => option.recommended);
    assert.strictEqual(recommended.effect, 'skip');
  });

  it('never asks when there is nobody to ask', () => {
    const recovery = new ErrorRecovery({ canAsk: false });
    for (let i = 0; i < 6; i += 1) {
      const decision = recovery.observe(failure());
      assert.notStrictEqual(decision.kind, 'ask', 'a session with no panel must not block on a question');
    }
  });

  it('asks only once about the same wall', () => {
    const recovery = new ErrorRecovery();
    for (let i = 0; i < 2; i += 1) recovery.observe(failure());
    const third = recovery.observe(failure());
    assert.strictEqual(third.kind, 'guidance');
  });

  it('leaves a refused action alone — that is the permission model, not a wall', () => {
    const recovery = new ErrorRecovery();
    for (let i = 0; i < 5; i += 1) {
      const decision = recovery.observe(
        failure({ action: 'delete_file', error: 'PERMISSION_DENIED', observation: 'The user declined.' })
      );
      assert.strictEqual(decision.kind, 'none');
    }
  });

  it('repeats the user’s answer back rather than asking again', () => {
    const recovery = new ErrorRecovery();
    for (let i = 0; i < 2; i += 1) recovery.observe(failure());
    recovery.recordAnswer(failure(), 'import addTodo from ./hooks/useTodos');

    const next = recovery.observe(failure());
    assert.strictEqual(next.kind, 'guidance');
    assert.match(next.guidance, /the user about this and they said/i);
    assert.match(next.guidance, /useTodos/);
  });

  it('does not remember a failure that only happened once', () => {
    // A single failure the next step fixes is noise, and the recall window is small
    // enough that noise costs something.
    const recovery = new ErrorRecovery();
    assert.strictEqual(recovery.observe(failure()).note, '');
  });

  it('remembers one that keeps happening', () => {
    const recovery = new ErrorRecovery();
    recovery.observe(failure());
    const second = recovery.observe(failure());
    assert.match(second.note, /failed 2 times/);
    assert.match(second.note, /addTodo is not defined/);
  });

  it('counts two different failures separately', () => {
    const recovery = new ErrorRecovery();
    recovery.observe(failure());
    const other = recovery.observe(failure({ observation: 'EADDRINUSE: address already in use' }));
    assert.strictEqual(other.count, 1);
  });
});

describe('ErrorRecovery.persistent', () => {
  it('reports what a run kept hitting, worst first', () => {
    const recovery = new ErrorRecovery({ canAsk: false });
    recovery.observe(failure());
    recovery.observe(failure());
    recovery.observe(failure());
    recovery.observe(failure({ observation: 'EADDRINUSE: address already in use' }));
    recovery.observe(failure({ observation: 'EADDRINUSE: address already in use' }));

    const stuck = recovery.persistent();
    assert.strictEqual(stuck.length, 2);
    assert.strictEqual(stuck[0].count, 3);
    assert.match(stuck[0].headline, /addTodo/);
  });

  it('says nothing about a run that hit nothing twice', () => {
    const recovery = new ErrorRecovery({ canAsk: false });
    recovery.observe(failure());
    assert.deepStrictEqual(recovery.persistent(), []);
  });
});
