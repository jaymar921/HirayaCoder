'use strict';

/**
 * What to do about a failure the model is not getting past on its own.
 *
 * ## The gap this fills
 *
 * `scriptDiagnosis` classifies a *command* failure into a named reason and one
 * actionable sentence, and it is the right answer whenever a rule matches. This module
 * covers the two cases it cannot:
 *
 *  1. **The failure nobody wrote a rule for.** `diagnose` returns null, and the model
 *     is handed a stack trace with no sentence saying what to do about it.
 *  2. **The failure that has already been diagnosed, twice, and is still happening.**
 *     The diagnosis was correct and the model did not act on it — or acted on it and
 *     it did not help. Repeating the same sentence a third time is not a strategy.
 *
 * Both end the same way if nothing intervenes. From the v0.5.3 and 0.6.0 rounds, a
 * small model that is stuck does one of three things: resends the identical action
 * until the step budget is gone, reports success it did not achieve, or abandons a
 * task it was one step from finishing. `gemma3:1b` sent the same failing `node
 * src/main.js` four times; `ornith:9b` resent a refused `javac` three times.
 *
 * ## The escalation ladder
 *
 * Repetition is the signal, because a failure that happens once is information and the
 * same failure twice is a model that is not learning from it:
 *
 * | Seen | What happens |
 * |---|---|
 * | 1st, diagnosed | Nothing extra — the diagnosis already said it |
 * | 1st, undiagnosed | Read the error literally; here is what to look at |
 * | 2nd | Ask the user |
 *
 * The user is asked **last**, not first. An agent that asks whenever it is unsure is an
 * agent that has moved its work to the user, and this project's whole premise is a
 * model small enough that "unsure" is its resting state.
 *
 * ## Why the second time and not the third
 *
 * Because there is no third. `reactLoop.REPEAT_LIMIT` is 2: the loop ends a run once
 * the model has sent the same action twice, which is the right call and long predates
 * this module. A ladder that waited for a third occurrence would therefore never reach
 * its top rung in the commonest case — the model resending an identical failing
 * command — and the run would end with the user never asked and the step budget spent.
 *
 * So the rungs are set against the loop's own limit rather than against a round number.
 * The second failure is the last moment at which asking can still change the outcome,
 * which makes it the right one and not merely an available one. A failure reached by
 * two *different* actions does not trip the loop's guard, and this counts those the
 * same way — same problem, same question.
 *
 * ## Why the error goes into memory
 *
 * A failure the run never resolved is exactly what the *next* run needs to know, and it
 * is the thing session memory was least likely to contain: `contextTranslator` records
 * what steps did, and a step that failed did nothing worth narrating. So the error is
 * recorded here, in composed text rather than model-written, alongside whatever the
 * user said about it — because "the user was asked about this and said X" is the
 * highest-value note in the file and the one no amount of re-reading the workspace
 * recovers.
 *
 * @module agent/errorRecovery
 */

const logger = require('../utils/logger');
const clarification = require('./clarification');

/**
 * How many times one failure repeats before the user is asked about it.
 *
 * Two, and it is pinned to `reactLoop.REPEAT_LIMIT` rather than chosen — see the
 * module header. Raising it without raising that one means never asking at all.
 */
const REPEATS_BEFORE_ASKING = 2;

/** Signatures are compared, not read; this is long enough to separate real failures. */
const SIGNATURE_CHARS = 200;

/** A failure message is quoted back to the user and into memory, so it is bounded. */
const MAX_QUOTED_CHARS = 300;

/**
 * Tool failures that are the permission model working, not the model being stuck.
 *
 * A refused write is a *decision*, and the correct response to it is to stop trying —
 * which the model is already told at the point of refusal. Escalating a declined
 * delete to "shall I ask the user?" would ask them the same question twice, and the
 * second time with less context than the confirmation dialog had.
 */
const NOT_STUCK = new Set([
  'PERMISSION_DENIED',
  'DECLINED',
  'CANCELLED',
  'TOOL_UNAVAILABLE',
]);

/**
 * Reduce a failure message to something that compares equal across repeats.
 *
 * Line numbers, addresses, and paths change between two runs of the same broken code;
 * the sentence does not. Digits go last and wholesale, which merges "line 12" with
 * "line 40" — correct here, because this asks "is this the same problem again", not
 * "is this the same character sequence".
 *
 * @param {string} action
 * @param {string} message
 * @returns {string}
 */
function signatureOf(action, message) {
  const text = String(message == null ? '' : message)
    // Windows absolute paths, then POSIX ones. Both appear in stack traces and both
    // differ between machines running the identical failure.
    .replace(/[A-Za-z]:[\\/][^\s'"()]+/g, '<path>')
    .replace(/(^|[\s'"(])\/[^\s'"()]{2,}/g, '$1<path>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<addr>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, SIGNATURE_CHARS);

  return `${action}::${text}`;
}

/**
 * The first line of a failure that says something, for quoting back.
 *
 * Stack frames are skipped: `at Object.<anonymous> (/app/x.js:4:11)` is where it
 * happened, and the line above it is what happened. A user being asked about a failure
 * needs the second one.
 *
 * @param {string} message
 * @returns {string}
 */
function headline(message) {
  const lines = String(message == null ? '' : message).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^at\s/.test(trimmed)) continue;
    if (/^\s*(File|Traceback)\b/.test(trimmed)) continue;
    return clarification.clamp(trimmed, MAX_QUOTED_CHARS);
  }
  return clarification.clamp(String(message || '').trim(), MAX_QUOTED_CHARS);
}

/**
 * @typedef {object} Failure
 * @property {string} action       The tool that failed.
 * @property {string} [path]
 * @property {string} [command]
 * @property {string} [error]      Machine-readable code, when the tool gave one.
 * @property {string} observation  What the model was shown.
 * @property {boolean} diagnosed   Whether `scriptDiagnosis` already explained it.
 * @property {string} [item]       The TODO item being worked on, for the question text.
 */

/**
 * @typedef {object} RecoveryDecision
 * @property {'none' | 'guidance' | 'ask'} kind
 * @property {string} [guidance]   Appended to the observation the model reads next.
 * @property {string} [note]       Composed memory text. Present whenever there is one.
 * @property {import('./clarification').Clarification} [clarification]
 * @property {number} count        How many times this failure has now been seen.
 */

class ErrorRecovery {
  /**
   * @param {object} [options]
   * @param {number} [options.repeatsBeforeAsking]
   * @param {boolean} [options.canAsk]
   *   False when nothing is listening for a question — an Ask-mode turn, a benchmark,
   *   a session whose panel has gone away. The ladder then tops out at guidance, which
   *   is strictly better than blocking a run on a card nobody will ever see.
   */
  constructor(options = {}) {
    this.repeatsBeforeAsking = options.repeatsBeforeAsking || REPEATS_BEFORE_ASKING;
    this.canAsk = options.canAsk !== false;

    /**
     * Signature → what we know about that failure so far.
     *
     * Per-session rather than persisted: "you have tried this three times" is a claim
     * about this run, and carrying it across runs would have a new session open already
     * out of patience with a failure the user may have fixed in between.
     *
     * @type {Map<string, {count: number, headline: string, action: string, asked: boolean}>}
     */
    this._seen = new Map();

    /**
     * What the user said when they were asked, keyed by signature, so the same failure
     * later in the run is answered from what they already told us instead of asking
     * twice.
     *
     * @type {Map<string, string>}
     */
    this._answers = new Map();
  }

  /**
   * Record a failure and decide what to do about it.
   *
   * @param {Failure} failure
   * @returns {RecoveryDecision}
   */
  observe(failure) {
    const action = String(failure.action || 'action');
    const observation = String(failure.observation || '');

    // A refusal is the permission model working. Nothing here applies.
    if (failure.error && NOT_STUCK.has(failure.error)) {
      return { kind: 'none', count: 0 };
    }

    const signature = signatureOf(action, observation);
    const known = this._seen.get(signature) || {
      count: 0,
      headline: headline(observation),
      action,
      asked: false,
    };
    known.count += 1;
    this._seen.set(signature, known);

    const target = failure.path || failure.command || '';
    const note = this._note(known, target, failure.diagnosed);

    // Already asked about this one. The user's answer is the guidance from here on —
    // asking again would be asking them to repeat themselves.
    const answered = this._answers.get(signature);
    if (answered) {
      return {
        kind: 'guidance',
        guidance:
          `You asked the user about this and they said: "${answered}" — do that, ` +
          'rather than trying the same thing again.',
        note,
        count: known.count,
      };
    }

    if (known.count >= this.repeatsBeforeAsking && this.canAsk && !known.asked) {
      known.asked = true;
      logger.info(
        `The same failure has happened ${known.count} times (${known.headline}); asking the user.`
      );
      return {
        kind: 'ask',
        clarification: this._question(known, failure, target),
        note,
        count: known.count,
      };
    }

    if (known.count === 1) {
      // A diagnosed failure has already been given its sentence by `scriptDiagnosis`,
      // and a second one saying the same thing in different words is noise in a context
      // window that has none to spare.
      if (failure.diagnosed) return { kind: 'none', note, count: known.count };
      return { kind: 'guidance', guidance: this._firstGuidance(failure), note, count: known.count };
    }

    return {
      kind: 'guidance',
      guidance: this._repeatGuidance(known, target),
      note,
      count: known.count,
    };
  }

  /**
   * Remember what the user said, so the rest of the run acts on it.
   *
   * @param {Failure} failure   The failure they were asked about.
   * @param {string} answer     What they chose or typed.
   * @returns {string} The memory note for the answer.
   */
  recordAnswer(failure, answer) {
    const signature = signatureOf(String(failure.action || 'action'), String(failure.observation || ''));
    const text = clarification.clamp(answer, MAX_QUOTED_CHARS);
    if (text) this._answers.set(signature, text);

    const known = this._seen.get(signature);
    const about = known ? known.headline : headline(String(failure.observation || ''));
    return `The user was asked about a repeated failure ("${about}") and said: ${text}`;
  }

  /**
   * Everything that failed more than once this run, worst first.
   *
   * Used by the session summary: a run that ended "3 of 4 items completed" is more
   * honest when it can also say which wall it kept hitting.
   *
   * @returns {Array<{headline: string, action: string, count: number}>}
   */
  persistent() {
    return [...this._seen.values()]
      .filter((known) => known.count > 1)
      .sort((a, b) => b.count - a.count)
      .map(({ headline: text, action, count }) => ({ headline: text, action, count }));
  }

  /**
   * What to say the first time an unexplained failure appears.
   *
   * @param {Failure} failure
   * @returns {string}
   * @private
   */
  _firstGuidance(failure) {
    const where = failure.path ? ` It was working on ${failure.path}.` : '';
    return (
      'This failure does not match anything known, so read the error above literally rather than guessing: ' +
      'it names what went wrong and usually where.' +
      where +
      ' Change one thing that the error actually mentions, then try again. Do not resend the same ' +
      'action unchanged — it will fail the same way.'
    );
  }

  /**
   * What to say once it is clear the model is going round in a circle.
   *
   * Names the count, because "you have already tried this twice" is a fact the model
   * cannot get from its own context on a Tier B loop — the trace is rebuilt each turn
   * and the earlier attempt is no longer in it.
   *
   * @param {{count: number, headline: string}} known
   * @param {string} target
   * @returns {string}
   * @private
   */
  _repeatGuidance(known, target) {
    const what = target ? ` on ${target}` : '';
    return (
      `This is the same failure as before — it has now happened ${known.count} times${what}: ` +
      `"${known.headline}". Whatever you changed between attempts did not address it. Do not try that ` +
      'approach a third time. Either work on a different part of the task, or fix the thing the error ' +
      'names directly — and if you genuinely cannot, say so plainly rather than repeating the attempt.'
    );
  }

  /**
   * The question put to the user once the ladder runs out.
   *
   * Three options, one recommended, and the recommendation is *skip* rather than retry:
   * the same thing has now failed twice with targeted guidance in between, and
   * recommending another attempt would recommend the thing that has already not worked.
   * Skipping keeps the rest of the list moving, which is usually what the user wants
   * and always what they can undo.
   *
   * @param {{count: number, headline: string}} known
   * @param {Failure} failure
   * @param {string} target
   * @returns {import('./clarification').Clarification}
   * @private
   */
  _question(known, failure, target) {
    const what = target ? ` \`${target}\`` : '';
    const item = failure.item ? ` while working on "${clarification.clamp(failure.item, 120)}"` : '';

    return clarification.build({
      kind: 'error',
      question: `I am stuck on${what || ' this step'}. How should I carry on?`,
      context:
        `The same failure has happened ${known.count} times${item}: "${known.headline}". ` +
        'I have changed my approach between attempts and it keeps failing the same way.',
      options: [
        {
          id: 'skip',
          label: 'Skip this and carry on',
          detail: 'Leaves this step unfinished and moves to the rest of the list.',
          effect: 'skip',
          recommended: true,
          guidance:
            'The user chose to skip this step. Leave it alone, do not try it again, and move on to the ' +
            'next item.',
        },
        {
          id: 'retry',
          label: 'Try once more',
          detail: 'Runs the same step again from a clean start.',
          effect: 'retry',
          guidance:
            'The user asked for one more attempt. Start from what the error says rather than from what ' +
            'you tried last time.',
        },
        {
          id: 'stop',
          label: 'Stop the run',
          detail: 'Ends here, keeping every change made so far.',
          effect: 'stop',
        },
      ],
    });
  }

  /**
   * The memory note for a failure.
   *
   * Composed here rather than written by the translator: a failed step has nothing to
   * narrate, so the translator's grounding check rejects whatever it invents and the
   * note ends up bare. This one is built from what is known for certain.
   *
   * @param {{count: number, headline: string, action: string}} known
   * @param {string} target
   * @param {boolean} diagnosed
   * @returns {string}
   * @private
   */
  _note(known, target, diagnosed) {
    // Only worth remembering once it is a pattern. A single failure that the next step
    // fixes is noise, and the recall window is small enough that noise costs something.
    if (known.count < 2) return '';

    const what = target ? ` on ${target}` : '';
    const explained = diagnosed ? '' : ' It was not a recognised kind of failure.';
    return `${known.action}${what} failed ${known.count} times with: ${known.headline}.${explained}`;
  }
}

module.exports = {
  ErrorRecovery,
  signatureOf,
  headline,
  REPEATS_BEFORE_ASKING,
  NOT_STUCK,
};
