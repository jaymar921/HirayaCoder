'use strict';

/**
 * Challenging a `done` that nothing supports.
 *
 * The balance under test is between the two failures. Not objecting produces "2 of 2
 * item(s) completed" for a session that wrote nothing, which is what five consecutive
 * attempts at one HTML file looked like to the user. Objecting too readily spends a turn
 * arguing with a model that was right, and on CPU inference a turn is tens of seconds.
 */

const assert = require('assert');

const { objectTo, placeholderBodies } = require('../../app/agent/completionCheck');

describe('completionCheck.objectTo', () => {
  describe('a session that changed nothing', () => {
    it('challenges a request that asked for something to be built', () => {
      // The transcript this comes from, verbatim: "convert the todo app from python to
      // a webpage in html … output: todoapp.html" → "2 of 2 item(s) completed … done
      // (no files changed)". No file was ever written.
      const objection = objectTo({
        task: 'convert the python todo app into an html webpage, name it todoapp.html',
        changed: false,
        written: [],
      });

      assert.ok(objection);
      assert.match(objection, /nothing in the project has actually changed/i);
      assert.match(objection, /write_file/);
    });

    it('accepts a request that only asked to look at something', () => {
      // Reading, checking, and explaining finish correctly having written nothing.
      for (const task of [
        'what does src/todo_manager.py do',
        'explain the auth flow',
        'check whether the tests pass',
        'show me where the priority field is used',
      ]) {
        assert.strictEqual(objectTo({ task, changed: false, written: [] }), null, `objected to "${task}"`);
      }
    });

    it('accepts a done once work has actually landed', () => {
      assert.strictEqual(
        objectTo({ task: 'create todoapp.html', changed: true, written: [{ path: 'todoapp.html', after: '<h1>x</h1>' }] }),
        null
      );
    });
  });

  describe('a session that wrote a placeholder', () => {
    it('challenges the file the evaluation actually produced', () => {
      // 49 lines, both handlers a comment and a console.log. A change set grew, so
      // nothing downstream had any reason to doubt it — and the delete feature the user
      // asked for three times did not exist.
      const html = `
<script>
    function deleteTask(taskId) {
        // Implement the delete functionality here
        console.log("Deleting task:", taskId);
    }
    function modifyTask(taskId) {
        // Implement the modify functionality here
        console.log("Modifying task:", taskId);
    }
</script>`;

      const objection = objectTo({
        task: 'add a delete feature and a modify feature to todoapp.html',
        changed: true,
        written: [{ path: 'todoapp.html', after: html }],
      });

      assert.ok(objection, 'a file of stubs was accepted as finished work');
      assert.match(objection, /todoapp\.html/);
      assert.match(objection, /never written/);
    });

    it('leaves real code alone, TODO comments and all', () => {
      // `// TODO` is an ordinary thing to leave in working code. A check that objected
      // to it would object to half the source files ever written.
      const real = `
function deleteTask(id) {
  // TODO: animate this later
  todos = todos.filter((t) => t.id !== id);
  render();
}`;

      assert.strictEqual(
        objectTo({ task: 'add a delete feature', changed: true, written: [{ path: 'app.js', after: real }] }),
        null
      );
    });

    it('leaves a genuinely empty function alone', () => {
      // No deferral comment, so nothing here claims the work is outstanding. A no-op
      // callback is a legitimate thing to write.
      assert.strictEqual(
        objectTo({ task: 'add a handler', changed: true, written: [{ path: 'app.js', after: 'function noop() {}' }] }),
        null
      );
    });

    it('ignores a deleted file, which has no contents to judge', () => {
      assert.strictEqual(
        objectTo({ task: 'remove the java sources', changed: true, written: [{ path: 'Old.java', after: null }] }),
        null
      );
    });
  });
});

describe('completionCheck.placeholderBodies', () => {
  it('finds the deferral comment inside a body that does nothing else', () => {
    const found = placeholderBodies('function a() {\n  // Implement the delete functionality here\n}');
    assert.strictEqual(found.length, 1);
    assert.match(found[0], /Implement the delete/);
  });

  it('finds several', () => {
    const source = `
function a() {
  // TODO: implement this
}
function b() {
  // your code here
  console.log('b');
}`;
    assert.strictEqual(placeholderBodies(source).length, 2);
  });

  it('reports nothing for an indentation-delimited language', () => {
    // Brace languages only, deliberately — see the note in `placeholderBodies`. Asserted
    // so the limitation is visible rather than discovered later as a silent gap.
    assert.deepStrictEqual(placeholderBodies('def remove(self, index):\n    # TODO: implement removal\n    pass\n'), []);
  });

  it('does not flag a body that has real work beside the comment', () => {
    const source = 'function a() {\n  // TODO: implement caching\n  return compute(x) + compute(y);\n}';
    assert.deepStrictEqual(placeholderBodies(source), []);
  });

  it('does not flag a file-level comment', () => {
    assert.deepStrictEqual(placeholderBodies('// TODO: implement the rest of this module\nconst x = 1;\n'), []);
  });

  it('handles content that is not code at all', () => {
    assert.deepStrictEqual(placeholderBodies('# Notes\n\nImplement the thing here, eventually.\n'), []);
    assert.deepStrictEqual(placeholderBodies(''), []);
  });

  it('does not hang on an unbalanced file', () => {
    assert.doesNotThrow(() => placeholderBodies('function a() {\n  // implement this\n'));
  });

  it('stays fast on a long run of whitespace', () => {
    // A guard, not a benchmark. An earlier version of PLACEHOLDER_COMMENT had two `\\s*`
    // either side of an optional group, both able to claim the same spaces, and took
    // 308 ms on half this input — a model that emits a long run of whitespace is not a
    // rare event, and this scans every file the agent writes. The fixed pattern does it
    // in well under a millisecond, so the threshold is nowhere near flaky.
    const pathological = `function a() {// TODO${' '.repeat(40000)}x\n}`;

    const started = Date.now();
    placeholderBodies(pathological);

    assert.ok(Date.now() - started < 200, 'the placeholder scan backtracked');
  });
});
