'use strict';

/**
 * Argument parsing shared by the benchmark scripts.
 *
 * `bench-build.js` keeps its own copies of these two functions and is deliberately left
 * alone — it has passing unit tests against them, and rewiring a working harness to
 * de-duplicate twenty lines would risk the results it produces.
 *
 * @module tools/lib/args
 */

/**
 * @param {string[]} argv
 * @returns {{positional: string[], flags: Record<string, string | boolean>}}
 */
function parseArgs(argv) {
  const positional = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

/** Filename-safe, and stable enough to sort by. */
function slug(text) {
  return String(text)
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { parseArgs, slug };
