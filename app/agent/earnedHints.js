'use strict';

/**
 * Corrective hints a model has earned by tripping the same guard repeatedly.
 *
 * `reactLoop` already carries per-error hints, but they are reactive and identical for
 * every model: the guard fires, the hint is shown, the next session starts over
 * knowing nothing. This module closes that loop. Once a *specific model* trips a
 * *specific guard* N times in this workspace, the matching correction is promoted into
 * that model's prompt preamble, so the next session begins already knowing the thing
 * it has repeatedly got wrong.
 *
 * This is the meta-learning idea implemented where it can actually run. HirayaCoder
 * owns no weights and can never own any — the model does not learn, the extension
 * learns what to tell it.
 *
 * ## Only these sentences can ever reach a prompt
 *
 * The hints are constants in this file. The ledger contributes *counts*, which select
 * among them; it never contributes text. That is why nothing here needs neutralizing
 * the way `memoryStore` entries do — a corrupted or hand-edited `outcomes.jsonl` can
 * make the wrong hint appear, or none, but it cannot put a sentence of its own into a
 * system prompt. `promptRouter` re-checks every hint against `isKnown` before
 * rendering it, so that property holds even if a future caller gets it wrong.
 *
 * ## What may never be earned
 *
 * A hint tunes how the model works. It may not touch what the model is permitted to
 * do, and `NEVER_EARNED` is where that line is drawn in code. `USER_DENIED` is the
 * one that matters: a system that can learn "the user approves every time, so stop
 * asking" is a data-loss incident with a progress bar. Repeated denials are the user
 * exercising judgement, and the correct response to them is the one `reactLoop`
 * already gives in the moment — move on — not a standing note about the user's
 * habits. `MODE_READONLY` and `TOOL_UNAVAILABLE` are excluded for a duller reason:
 * they are facts about the current mode, already stated in the prompt, and a model
 * that hit them in Plan mode should not be lectured about it in Agent mode.
 *
 * @module agent/earnedHints
 */

/**
 * Guard error code → the standing instruction that prevents it.
 *
 * Each is written as something to do from now on, not as a complaint about the past:
 * the model reading it has no memory of the sessions that earned it.
 *
 * @type {Map<string, string>}
 */
const CATALOGUE = new Map([
  [
    'EXPORTS_REMOVED',
    'When you rewrite a file, keep every export statement it already had. Removing an export ' +
      'breaks the files that import it, and this will be refused.',
  ],
  [
    'EXPORT_NOT_DEFINED',
    'Only export names you have actually defined in the same file. An export of something that ' +
      'is not there will be refused.',
  ],
  [
    'IMPLEMENTATION_REMOVED',
    'Keep the working code you are not being asked to change. Never replace a function body with ' +
      'a stub, a placeholder, or a comment describing what it used to do.',
  ],
  [
    'SUSPICIOUS_TRUNCATION',
    'The "code" field must hold the entire file, first line to last. Never abbreviate with ' +
      '"... rest of the file unchanged" or similar — the file is written exactly as you send it.',
  ],
  [
    'FULLY_COMMENTED',
    'Never send a file whose code is entirely commented out. If something should go, delete those ' +
      'lines and send the working file that remains.',
  ],
  [
    'MISSING_CONTENT',
    'A write_file action must carry the complete new file in "code". An action that only names the ' +
      'path changes nothing.',
  ],
  [
    'ECHOED_OBSERVATION',
    'Put only the file\'s own code in "code". Status messages from this session — "Updated x.js ' +
      '(+3 / -1 lines)" and the like — are not part of any file.',
  ],
  [
    'BINARY_NOT_ALLOWED',
    'Only allow-listed programs can be run here, and the list is the user\'s to change, not yours. ' +
      'If what you need is not available, say which command the user should run and why.',
  ],
  [
    'BINARY_NOT_FOUND',
    'Check that a tool exists before building work around it. If it is missing, tell the user what ' +
      'to install and carry on with what you can do without it.',
  ],
  [
    'SHELL_METACHARACTER',
    'Run one plain command at a time. No &&, ||, ;, pipes, or redirects — they are refused, not ' +
      'interpreted.',
  ],
  [
    'stop:repeating',
    'Do not repeat an action you have already taken. Once you have read a file you have its ' +
      'contents; once you have written it, it is saved. Take the next step, or finish with "done".',
  ],
  [
    'stop:unparseable',
    'Reply with one JSON object and nothing else — no prose before it, no explanation after it, no ' +
      'markdown fence around it.',
  ],
]);

/**
 * Codes that must never become a standing hint, whatever the evidence says.
 *
 * @type {Set<string>}
 */
const NEVER_EARNED = new Set(['USER_DENIED', 'MODE_READONLY', 'TOOL_UNAVAILABLE']);

/** Reverse index, so a rendered hint can be checked back to this file. */
const KNOWN_TEXT = new Set(CATALOGUE.values());

/**
 * How many times one model must trip one guard before the hint is promoted.
 *
 * Three, not one. A single trip is an accident and a hint bought that cheaply would
 * fill the preamble of a Tier B model whose entire prompt budget is ~1800 tokens. Two
 * is a coincidence. Three in the same workspace is a habit.
 */
const DEFAULT_THRESHOLD = 3;

/**
 * At most this many hints, most-tripped first.
 *
 * The preamble competes with the task for the same budget, so an unbounded list would
 * make a model that has struggled with everything worse at everything.
 */
const MAX_HINTS = 3;

/**
 * The evidence hints are selected from: guard trips, plus stop reasons under a
 * `stop:` prefix so the two namespaces cannot collide.
 *
 * @param {import('../core/outcomeLedger').ModelProfile} profile
 * @returns {Map<string, number>}
 */
function evidence(profile) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  if (!profile) return counts;

  for (const [code, count] of profile.trips || []) counts.set(code, count);
  for (const [reason, count] of profile.stops || []) counts.set(`stop:${reason}`, count);
  return counts;
}

/**
 * @typedef {object} EarnedHint
 * @property {string} key    The guard code or `stop:` reason that earned it.
 * @property {number} count  How many times it has been tripped.
 * @property {string} text   The sentence added to the preamble.
 */

/**
 * The hints this model has earned in this workspace.
 *
 * @param {import('../core/outcomeLedger').ModelProfile} profile
 * @param {object} [opts]
 * @param {number} [opts.threshold]
 * @param {number} [opts.max]
 * @returns {EarnedHint[]} Most-tripped first.
 */
function select(profile, opts = {}) {
  const threshold = typeof opts.threshold === 'number' && opts.threshold > 0 ? opts.threshold : DEFAULT_THRESHOLD;
  const max = typeof opts.max === 'number' && opts.max > 0 ? opts.max : MAX_HINTS;

  return [...evidence(profile)]
    .filter(([key, count]) => count >= threshold && CATALOGUE.has(key) && !NEVER_EARNED.has(key))
    // Ties break on the key so the preamble is stable between sessions — a prompt
    // that reshuffles itself for no reason is one more variable when a run goes wrong.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key, count]) => ({ key, count, text: /** @type {string} */ (CATALOGUE.get(key)) }));
}

/**
 * Did this exact sentence come from the catalogue?
 *
 * `promptRouter` gates on this, which is what makes "the ledger cannot write to a
 * system prompt" a structural property rather than a convention.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isKnown(text) {
  return KNOWN_TEXT.has(text);
}

module.exports = {
  select,
  isKnown,
  evidence,
  CATALOGUE,
  NEVER_EARNED,
  DEFAULT_THRESHOLD,
  MAX_HINTS,
};
