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

/**
 * Did this run produce an app that actually works?
 *
 * The bar is the one the benchmark exists for, and it is deliberately all three parts:
 * `App.jsx` changed, the counter demo is gone, and every import it names resolves to a
 * real file. Two out of three is a broken app that reports itself as finished.
 *
 * @param {object} record
 * @returns {boolean}
 */
function wired(record) {
  const g = record.graded || {};
  return Boolean(g.appChanged) && !g.stillCounter && (g.wired || []).length > 0 && (g.broken || []).length === 0;
}

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

console.log('| Machine | Model | Steps | Runs | Wired | Rate | Median | Broken imports |');
console.log('|---|---|---|---|---|---|---|---|');

for (const [key, group] of [...groups.entries()].sort()) {
  const [machine, model, steps] = key.split('|');
  const ok = group.filter(wired).length;
  const times = group.map((r) => r.durationMs).sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)] / 1000;
  const brokenRuns = group.filter((r) => ((r.graded || {}).broken || []).length > 0).length;

  console.log(
    `| ${machine} | ${model} | ${steps} | ${group.length} | ${ok} | ` +
      `${Math.round((ok / group.length) * 100)}% | ${median.toFixed(1)}s (${(median / 60).toFixed(1)} min) | ${brokenRuns} |`
  );
}

// Named individually, because a bimodal result is the interesting kind and averaging it
// away is the mistake the handoffs warn against.
const failures = records.filter((r) => !wired(r));
if (failures.length > 0) {
  console.log(`\nRuns that did not produce a working app (${failures.length}/${records.length}):`);
  for (const record of failures) {
    const g = record.graded || {};
    const why = !g.appChanged
      ? 'App.jsx never changed'
      : g.stillCounter
        ? 'still the counter demo'
        : (g.broken || []).length > 0
          ? `imports point at nothing: ${g.broken.join(', ')}`
          : 'nothing it built was imported';
    console.log(`  ${record.machine} ${record.model} steps=${record.stepSessions ? 'on' : 'off'} — ${why}`);
  }
}
