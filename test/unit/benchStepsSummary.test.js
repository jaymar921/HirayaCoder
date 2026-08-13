'use strict';

/**
 * The step benchmark's grading half.
 *
 * `benchBuild.test.js` opens with the reason this file exists too: *a benchmark that
 * scores runs wrongly is worse than no benchmark, because it produces numbers that look
 * authoritative and are not.* That is not hypothetical here — it happened.
 *
 * The predicate shipped as `wired.length > 0` while its own comment claimed "two out of
 * three is a broken app". The code won, one resolving import out of three counted as a
 * success, and a real 7/10 was reported as 100%. It inflated the *control* arm, which is
 * the one that makes the feature under test look bad by comparison — so the reading it
 * produced was "step sessions made things worse", from 25 real runs that said no such
 * thing. Machine C caught it by hand-counting.
 *
 * Every case below is one of the shapes those 25 runs actually produced.
 */

const assert = require('assert');

const { wired, partiallyWired, EXPECTED } = require('../../tools/bench-steps-summary');

/** @param {object} graded */
const run = (graded) => ({
  machine: 'C',
  model: 'qwen3.5:4b',
  stepSessions: true,
  durationMs: 40000,
  graded: { appChanged: true, stillCounter: false, named: [], wired: [], broken: [], expected: EXPECTED, ...graded },
});

describe('bench-steps grading', () => {
  describe('a fully wired app', () => {
    it('needs all three imports, not merely one', () => {
      assert.strictEqual(wired(run({ wired: ['useTodos', 'TodoInput', 'TodoList'] })), true);
    });

    it('is not satisfied by the hook alone — neither component renders', () => {
      // Observed once on Machine C with steps off, and scored as a pass by the old
      // predicate.
      assert.strictEqual(wired(run({ wired: ['useTodos'] })), false);
    });

    it('is not satisfied by the components alone — the state is written and unused', () => {
      // Observed twice on Machine C with steps off.
      assert.strictEqual(wired(run({ wired: ['TodoInput', 'TodoList'] })), false);
    });

    it('rejects a file that still holds the counter demo alongside the todo app', () => {
      assert.strictEqual(
        wired(run({ wired: ['useTodos', 'TodoInput', 'TodoList'], stillCounter: true })),
        false
      );
    });

    it('rejects imports that point at nothing', () => {
      assert.strictEqual(
        wired(run({ named: EXPECTED, wired: [], broken: ['useTodos', 'TodoInput', 'TodoList'] })),
        false
      );
    });

    it('rejects an App.jsx that was never touched', () => {
      assert.strictEqual(wired(run({ appChanged: false })), false);
    });
  });

  describe('partial wiring', () => {
    it('is counted separately from wiring nothing at all', () => {
      // "Imported two of three" and "imported none" are different problems, and folding
      // them together hides which one a model has.
      assert.strictEqual(partiallyWired(run({ wired: ['TodoInput', 'TodoList'] })), true);
      assert.strictEqual(partiallyWired(run({ wired: [] })), false);
    });

    it('does not also count a fully wired run', () => {
      assert.strictEqual(partiallyWired(run({ wired: ['useTodos', 'TodoInput', 'TodoList'] })), false);
    });

    it('does not count a run whose paths are broken rather than missing', () => {
      assert.strictEqual(
        partiallyWired(run({ named: EXPECTED, wired: ['useTodos'], broken: ['TodoInput', 'TodoList'] })),
        false
      );
    });
  });

  describe('records written before the bar was stored in the data', () => {
    it('falls back to the three the task asks for', () => {
      const legacy = run({ wired: ['useTodos', 'TodoInput', 'TodoList'] });
      delete legacy.graded.expected;
      assert.strictEqual(wired(legacy), true);

      const partial = run({ wired: ['TodoInput'] });
      delete partial.graded.expected;
      assert.strictEqual(wired(partial), false);
    });
  });

  it('reproduces Machine C\'s hand count', () => {
    // The numbers in doc/MODELS.md, counted by hand from the same 25 files: 8 of 10 with
    // step sessions, 7 of 10 without. If this drifts, one of the two is wrong.
    const on = [
      ...Array(8).fill({ wired: ['useTodos', 'TodoInput', 'TodoList'] }),
      { wired: ['useTodos', 'TodoInput', 'TodoList'], stillCounter: true },
      { named: EXPECTED, wired: [], broken: EXPECTED },
    ].map(run);
    const off = [
      ...Array(7).fill({ wired: ['useTodos', 'TodoInput', 'TodoList'] }),
      { wired: ['useTodos'] },
      { wired: ['TodoInput', 'TodoList'] },
      { wired: ['TodoInput', 'TodoList'] },
    ].map(run);

    assert.strictEqual(on.filter(wired).length, 8);
    assert.strictEqual(off.filter(wired).length, 7);
  });
});
