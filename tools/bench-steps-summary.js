'use strict';

/* eslint-disable security/detect-non-literal-fs-filename, no-console --
 * A developer script that reads a directory this repo owns and prints a table. */

/**
 * Collate `bench-steps` runs into a success rate.
 *
 * One run of the wiring task tells you very little: Machine A ran the same model against
 * the same fixture four times and got three different outcomes. What the project needs
 * from a machine fast enough to repeat is a *rate*, and a rate is tedious to assemble
 * from terminal scrollback.
 *
 * So each run writes a JSON file and this reads them back. It grades nothing itself — it
 * only counts what `bench-steps.js` already decided from the filesystem.
 *
 * Usage:
 *
 *   node tools/bench-steps-summary.js            # every machine
 *   node tools/bench-steps-summary.js --machine C
 *
 * Paste the output into `doc/MODELS.md` under your machine's heading.
 */

const fs = require('fs');
const path = require('path');

const flagIndex = process.argv.indexOf('--machine');
const ONLY = flagIndex !== -1 ? String(process.argv[flagIndex + 1] || '').toUpperCase() : '';

const root = path.join(__dirname, '..', 'benchmarks', 'results');

/** @returns {object[]} */
function load() {
  /** @type {object[]} */
  const records = [];
  let machines;
  try {
    machines = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return records;
  }

  for (const dir of machines) {
    if (ONLY && dir.name.toUpperCase() !== ONLY) continue;
    const machineDir = path.join(root, dir.name);
    for (const name of fs.readdirSync(machineDir)) {
      if (!name.startsWith('steps__') || !name.endsWith('.json')) continue;
      try {
        records.push(JSON.parse(fs.readFileSync(path.join(machineDir, name), 'utf8')));
      } catch {
        console.error(`Skipped unreadable result: ${dir.name}/${name}`);
      }
    }
  }
  return records;
}

/** The three the task asks `App.jsx` to import. Older records do not carry this. */
const EXPECTED = ['useTodos', 'TodoInput', 'TodoList'];

/**
 * Did this run produce an app that actually works?
 *
 * ## The bar, and the bug this predicate had
 *
 * It shipped as `(g.wired || []).length > 0` while its own comment claimed "two out of
 * three is a broken app that reports itself as finished". Those disagree, and the code
 * won: **one** resolving import out of three passed.
 *
 * Machine C caught it at n=25. Three `nosteps` runs had wired only part of the app — two
 * imported `TodoInput` and `TodoList` and never `useTodos`, so the hook holding all the
 * state was written and unused; one imported only `useTodos`, so neither component was
 * rendered. None had a *broken* path, only missing ones, so `broken` was empty and the
 * check passed. That turned a real 7/10 into a reported 100%.
 *
 * It mattered in the worst direction: it inflated the control arm specifically, which is
 * the arm that makes the feature look bad by comparison. The corrected numbers are 8/10
 * with step sessions against 7/10 without — indistinguishable, where the bug said the
 * feature had made things worse.
 *
 * The bar is now what the comment always said: `App.jsx` changed, the counter demo gone,
 * no import pointing at nothing, **and all three of the task's imports resolving.**
 *
 * @param {object} record
 * @returns {boolean}
 */
function wired(record) {
  const g = record.graded || {};
  if (!g.appChanged || g.stillCounter) return false;
  if ((g.broken || []).length > 0) return false;

  const expected = Array.isArray(g.expected) && g.expected.length > 0 ? g.expected : EXPECTED;
  const resolved = new Set(g.wired || []);
  return expected.every((name) => resolved.has(name));
}

/**
 * Wired something, but not all of it — the state this predicate used to score as a pass.
 *
 * Counted separately rather than folded into the failures, because "imported two of three"
 * and "imported none" are different problems and the second is much worse.
 *
 * @param {object} record
 * @returns {boolean}
 */
function partiallyWired(record) {
  const g = record.graded || {};
  return !wired(record) && (g.wired || []).length > 0 && (g.broken || []).length === 0;
}

/**
 * Print the table.
 *
 * Behind a function, and behind the `require.main` guard below, for the same reason
 * `bench-build.js` is: the grading half is unit-tested, and requiring the module must
 * not run a sweep or call `process.exit` as a side effect.
 */
function main() {
  const records = load();
  if (records.length === 0) {
    console.error(`No bench-steps results found under ${path.relative(process.cwd(), root)}${ONLY ? ` for machine ${ONLY}` : ''}.`);
    process.exit(1);
  }

  /** @type {Map<string, object[]>} */
  const groups = new Map();
  for (const record of records) {
    const key = `${record.machine}|${record.model}|${record.stepSessions ? 'on' : 'off'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }

  console.log('Fully wired = App.jsx changed, counter demo gone, and all three imports resolving.\n');
  console.log('| Machine | Model | Steps | Runs | Fully wired | Rate | Partial | Broken imports | Median |');
  console.log('|---|---|---|---|---|---|---|---|---|');

  for (const [key, group] of [...groups.entries()].sort()) {
    const [machine, model, steps] = key.split('|');
    const ok = group.filter(wired).length;
    const partial = group.filter(partiallyWired).length;
    const times = group.map((r) => r.durationMs).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)] / 1000;
    const brokenRuns = group.filter((r) => ((r.graded || {}).broken || []).length > 0).length;

    console.log(
      `| ${machine} | ${model} | ${steps} | ${group.length} | ${ok} | ` +
        `${Math.round((ok / group.length) * 100)}% | ${partial} | ${brokenRuns} | ` +
        `${median.toFixed(1)}s (${(median / 60).toFixed(1)} min) |`
    );
  }

  // Named individually, because a bimodal result is the interesting kind and averaging it
  // away is the mistake the handoffs warn against.
  const failures = records.filter((r) => !wired(r));
  if (failures.length > 0) {
    console.log(`\nRuns that did not produce a working app (${failures.length}/${records.length}):`);
    for (const record of failures) {
      const g = record.graded || {};
      const resolved = new Set(g.wired || []);
      const expected = Array.isArray(g.expected) && g.expected.length > 0 ? g.expected : EXPECTED;
      const missing = expected.filter((name) => !resolved.has(name));

      const why = !g.appChanged
        ? 'App.jsx never changed'
        : g.stillCounter
          ? 'still the counter demo alongside the todo app'
          : (g.broken || []).length > 0
            ? `imports point at nothing: ${g.broken.join(', ')}`
            : resolved.size === 0
              ? 'nothing it built was imported'
              : `only imported ${[...resolved].join(', ')} — never imported ${missing.join(', ')}`;
      console.log(`  ${record.machine} ${record.model} steps=${record.stepSessions ? 'on' : 'off'} — ${why}`);
    }
  }

}

if (require.main === module) main();

module.exports = { wired, partiallyWired, EXPECTED };
