'use strict';

/**
 * Whether a step actually did what it was asked, and what to do when it did not.
 *
 * ## Why `judgeItem` is not enough on its own
 *
 * `judgeItem` asks a narrow question — did the loop reach `done`, did anything change,
 * did anything fail — and answers it from evidence, which is right. What it cannot ask
 * is whether the thing that changed is the thing the step was *about*. On the React
 * benchmark that distinction is the difference between a run that works and one that
 * does not: `gemma2:latest` edited `vite.config.js` and `README.md` while working
 * through a list whose items were about `useTodos.js`, `TodoInput.jsx`, and `App.jsx`,
 * and every one of those items was scored as having changed something.
 *
 * So this checks the step's output against the step's own text before the step is
 * allowed to close: the files it named, the files the session wrote, and how the loop
 * ended. Three records the extension keeps itself. The model's summary is not consulted
 * and never will be — a model that would tick off an item it never did would also
 * describe the wrong file as the right one.
 *
 * ## Reconsidering before failing, rather than after
 *
 * A step that fails takes the rest of the list with it, so the expensive thing is not
 * the failure but the point at which it is declared. When the evidence says a step is
 * about to be written off, the model gets one more run with the diagnosis stated
 * plainly — what was asked, what it actually did, and what is missing. That is one
 * retry, not a loop: a model that cannot produce the work will not be argued into it,
 * and a second retry only spends CPU minutes on the same answer.
 *
 * When the retry fails too, the run stops and says why in terms the user can act on.
 * Continuing is the worse option and the benchmark shows it: on session 5 the scaffold
 * step failed, the remaining five items ran anyway against a project that had never
 * been created, and the report was a wall of missing-path errors with no statement of
 * which one mattered.
 *
 * @module agent/stepGuard
 */

const { namedFiles } = require('./stepBrief');

/**
 * @typedef {object} StepEvidence
 * @property {string} item                 The step's own text.
 * @property {string} stopReason           How the loop ended.
 * @property {Array<{kind: string, path: string}>} changed
 *   Files this step created, edited, or deleted — this step's, not the session's.
 * @property {import('./agentSession').AgentStep[]} steps
 */

/**
 * @typedef {object} Verdict
 * @property {boolean} ok
 * @property {'changed' | 'no-change' | 'off-target' | 'stopped'} [reason]
 * @property {string} detail  One sentence, for the model and for the user.
 */

/**
 * Does a path plausibly answer a name the step used?
 *
 * Compared on the basename, because a step says `App.jsx` where the write says
 * `todo-glass-app/src/App.jsx`, and those are the same file. A step that names a
 * directory fragment (`src/components`) matches anything beneath it.
 *
 * @param {string} written
 * @param {string} named
 * @returns {boolean}
 */
function pathAnswers(written, named) {
  const target = String(written || '').toLowerCase().replace(/\\/g, '/');
  const wanted = String(named || '').toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!target || !wanted) return false;
  if (target === wanted || target.endsWith(`/${wanted}`)) return true;
  // A folder the step named, e.g. "src/components/".
  if (!/\.[a-z0-9]{1,6}$/i.test(wanted)) return target.includes(`${wanted}/`);
  // Bare filename against a full path.
  return target.split('/').pop() === wanted.split('/').pop();
}

/**
 * Judge one step against what it was asked to produce.
 *
 * @param {StepEvidence} evidence
 * @returns {Verdict}
 */
function verify(evidence) {
  const changed = (evidence.changed || []).filter((change) => change && change.path);
  const failedSteps = (evidence.steps || []).filter((step) => step.result && step.result.ok === false);

  if (changed.length === 0) {
    // The distinction the user sees: a step that tried and was refused reads differently
    // from one that never attempted anything, and only the first is worth naming a cause
    // for.
    const blocked = failedSteps.length > 0 ? failedSteps[failedSteps.length - 1].result.observation : '';
    return {
      ok: false,
      reason: 'no-change',
      detail: blocked
        ? `nothing was written — the last attempt failed: ${String(blocked).split('\n')[0]}`
        : 'nothing was created or changed, so this step produced no work at all',
    };
  }

  const named = namedFiles(evidence.item);
  if (named.length > 0) {
    const onTarget = changed.some((change) => named.some((want) => pathAnswers(change.path, want)));
    if (!onTarget) {
      return {
        ok: false,
        reason: 'off-target',
        detail:
          `this step is about ${named.join(', ')}, but what changed was ` +
          `${changed.map((change) => change.path).join(', ')} — the file the step names was never written`,
      };
    }
  }

  // Changed the right thing but never closed the loop. Reported rather than failed:
  // the work landed, and `judgeItem` has a state for exactly this.
  if (evidence.stopReason !== 'done') {
    return {
      ok: true,
      reason: 'stopped',
      detail: `the file was written, but the model stopped without confirming (${evidence.stopReason})`,
    };
  }

  return { ok: true, reason: 'changed', detail: '' };
}

/**
 * What to tell the model when a step is about to be written off.
 *
 * Written as a statement of fact plus one instruction. Everything in it comes from the
 * extension's own records, so a model that has lost the thread over a long run is
 * being re-grounded rather than argued with.
 *
 * @param {object} options
 * @param {string} options.item
 * @param {Verdict} options.verdict
 * @param {Array<{kind: string, path: string}>} [options.sessionChanges]  Everything written so far.
 * @returns {string}
 */
function rethink(options) {
  const verdict = options.verdict || { detail: 'nothing was written' };
  const named = namedFiles(options.item);
  const written = (options.sessionChanges || []).map((change) => change.path);

  /** @type {string[]} */
  const lines = [
    `That attempt did not complete the step. What was asked: ${options.item}`,
    `What actually happened: ${verdict.detail}.`,
  ];

  if (written.length > 0) {
    lines.push(`Files this session has written so far: ${written.join(', ')}.`);
  }

  if (named.length > 0) {
    lines.push(
      `Before anything else, call write_file for ${named.join(' and ')} with the COMPLETE contents ` +
        'in "code". If the file already exists, read it first and send it back with your changes ' +
        'applied — never a fragment, never a diff.'
    );
  } else {
    lines.push(
      'Before anything else, call write_file with the file this step needs and the COMPLETE ' +
        'contents in "code". Decide the path yourself from the request if it was not given.'
    );
  }

  lines.push(
    'Do not read more files first, do not explain the plan, and do not ask what to work on — ' +
      'the step is the line above. Write the file, then reply "done".'
  );

  return lines.join('\n');
}

/**
 * The stop notice for a step that failed twice.
 *
 * The user's decision, not the agent's: it says what was being attempted, what went
 * wrong, what the rest of the run would have done, and the one or two things most likely
 * to get past it. It never offers to carry on regardless, because a list whose
 * foundation step failed produces the missing-path cascade this module's header
 * describes.
 *
 * @param {object} options
 * @param {string} options.item
 * @param {number} options.position
 * @param {Verdict} options.verdict
 * @param {string[]} [options.remaining]  Item texts that will not now be attempted.
 * @param {import('./agentSession').AgentStep[]} [options.steps]
 * @returns {string}
 */
function workaround(options) {
  const verdict = options.verdict || { reason: 'no-change', detail: 'nothing was written' };
  const remaining = options.remaining || [];

  /** @type {string[]} */
  const parts = [
    `**Stopped at step ${options.position}: ${options.item}**`,
    `I tried this twice and it did not land — ${verdict.detail}.`,
  ];

  if (remaining.length > 0) {
    parts.push(
      `The remaining ${remaining.length} step(s) were not attempted, because they build on this one ` +
        `and would have failed against a project that does not have it:\n` +
        remaining.map((text) => `- ${text}`).join('\n')
    );
  }

  parts.push(`**What to try**\n${suggestionsFor(options).map((line) => `- ${line}`).join('\n')}`);

  return parts.join('\n\n');
}

/**
 * The most likely ways past a specific failure.
 *
 * Ordered by what actually worked in the benchmark runs rather than by generality: the
 * single most reliable fix for a small model that will not write is to be given the
 * exact path in a message of its own, which is why it leads every list.
 *
 * @param {object} options
 * @returns {string[]}
 * @private
 */
function suggestionsFor(options) {
  const verdict = options.verdict || {};
  const named = namedFiles(options.item);
  const failures = (options.steps || []).filter((step) => step.result && step.result.ok === false);
  const codes = new Set(failures.map((step) => step.result.error).filter(Boolean));

  /** @type {string[]} */
  const lines = [];

  if (codes.has('USER_DENIED')) {
    lines.push('A confirmation was declined, so the write never ran. Re-run the step and approve it, or turn on Auto Edit.');
  }
  if (codes.has('SHELL_METACHARACTER')) {
    lines.push(
      'The command was refused for containing a shell operator (`&&`, `||`, `2>&1`, a pipe). ' +
        'Run it yourself in a terminal, then ask again from the step after it.'
    );
  }
  if (codes.has('ENOENT')) {
    lines.push(
      'The paths it tried do not exist. Send the exact path you want, relative to the project root ' +
        '— the model was guessing at the layout.'
    );
  }

  if (verdict.reason === 'off-target') {
    lines.push(
      `Ask for this one file on its own: "${named[0] || 'the file'} — write the complete file". ` +
        'Splitting it out of the list is usually enough.'
    );
  } else {
    lines.push(
      named.length > 0
        ? `Ask for it directly in a new message: "write ${named.join(' and ')}, complete file, no placeholders".`
        : 'Ask for the one file this step needs, by exact path, in a message of its own.'
    );
  }

  lines.push('A larger model is the surer fix — this step needs the model to hold a whole file in one reply.');

  return lines;
}

module.exports = { verify, rethink, workaround, pathAnswers, suggestionsFor };
