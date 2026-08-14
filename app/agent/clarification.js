'use strict';

/**
 * A question the agent puts to the user mid-run, with the options it can act on.
 *
 * ## Why an agent that runs offline still stops to ask
 *
 * The alternative to asking is guessing, and the guesses a small model makes when it
 * is stuck are not neutral. Across the v0.5.3 and 0.6.0 rounds the three observed
 * endings for a model that had run out of ideas were: repeat the failing action until
 * the step budget ran out, announce success it had not achieved, or abandon a task it
 * was one decision away from finishing. All three cost the user more than a question
 * would have.
 *
 * So this is the escape hatch, and its rules come from what makes a question cheap to
 * answer rather than from what is easy to generate:
 *
 * - **Two to four options, never more.** A question with seven options is a second
 *   task handed to the user. Two to four fits on a card and can be answered without
 *   reading twice.
 * - **Exactly one is recommended.** "Here are your choices" moves the decision without
 *   helping with it. The agent has the trace, the diagnosis, and the change set; it
 *   knows more about the situation than the user has looked at, and it should say what
 *   it would do. `build` refuses a set that recommends none or several.
 * - **Every option states its effect on the queue**, so answering is not a second
 *   guess about what happens next.
 * - **Free text is always available.** The options are the agent's reading of the
 *   situation, and the whole reason it is asking is that its reading may be wrong.
 *
 * ## What this module is not
 *
 * It does not ask anything. It builds and validates the request; `agentSession` owns
 * when to raise one and what to do with the answer, and `chatTab` owns showing it.
 * The split matters because a malformed request must fail here, at construction, and
 * not in the webview where the run is already blocked waiting on a card that cannot
 * render.
 *
 * @module agent/clarification
 */

const logger = require('../utils/logger');

/** Fewer than this is not a choice; more is a task. */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

/** Labels and questions are shown on a card in a narrow panel. */
const MAX_LABEL_CHARS = 80;
const MAX_QUESTION_CHARS = 300;
const MAX_DETAIL_CHARS = 200;

/**
 * What the run does with the answer.
 *
 * `instruct` is the interesting one: the run continues on the same item, with what the
 * user said added to the model's next prompt as a correction. That is the case the
 * whole mechanism is for — the user knows the one fact the model was missing.
 *
 * @typedef {'instruct' | 'retry' | 'skip' | 'stop'} ClarificationEffect
 */

/**
 * @typedef {object} ClarificationOption
 * @property {string} id
 * @property {string} label        What will happen, in the imperative.
 * @property {string} [detail]     One sentence on the consequence.
 * @property {boolean} [recommended]
 * @property {ClarificationEffect} effect
 * @property {string} [guidance]   Given to the model when this option is chosen.
 */

/**
 * @typedef {object} Clarification
 * @property {string} id
 * @property {'error' | 'ambiguous' | 'choice'} kind  Why it is being asked.
 * @property {string} question
 * @property {string} [context]    What was already tried, so the user is not guessing.
 * @property {ClarificationOption[]} options
 * @property {boolean} allowFreeText
 */

/**
 * @typedef {object} ClarificationAnswer
 * @property {string} id           The clarification being answered.
 * @property {string} [optionId]
 * @property {string} [text]       Free text, when the user typed instead of choosing.
 * @property {boolean} [cancelled] The user closed the panel or stopped the run.
 */

let counter = 0;

/** @returns {string} A per-run unique id. Not security-bearing; it only pairs answers to questions. */
function nextId() {
  counter += 1;
  return `clarify-${Date.now().toString(36)}-${counter}`;
}

/**
 * Trim a model- or code-supplied string to something a card can hold.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clamp(value, max) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Build a validated clarification request.
 *
 * Throws rather than repairing a malformed set, because every caller here is code in
 * this repository rather than model output — a bad set is a bug to fix, and quietly
 * padding it to two options would hide it behind a question the user cannot answer
 * usefully.
 *
 * The one thing that *is* repaired is a missing recommendation: the first option is
 * promoted, with a warning. A run already blocked on a question should not also fail.
 *
 * @param {object} spec
 * @param {'error' | 'ambiguous' | 'choice'} spec.kind
 * @param {string} spec.question
 * @param {string} [spec.context]
 * @param {Array<Omit<ClarificationOption, 'id'> & {id?: string}>} spec.options
 * @param {boolean} [spec.allowFreeText]
 * @returns {Clarification}
 */
function build(spec) {
  const question = clamp(spec.question, MAX_QUESTION_CHARS);
  if (!question) throw new Error('A clarification needs a question.');

  const given = Array.isArray(spec.options) ? spec.options : [];
  if (given.length < MIN_OPTIONS || given.length > MAX_OPTIONS) {
    throw new Error(
      `A clarification needs between ${MIN_OPTIONS} and ${MAX_OPTIONS} options; got ${given.length}.`
    );
  }

  /** @type {ClarificationOption[]} */
  const options = given.map((option, index) => {
    const label = clamp(option.label, MAX_LABEL_CHARS);
    if (!label) throw new Error(`Clarification option ${index + 1} has no label.`);
    return {
      id: option.id || `option-${index + 1}`,
      label,
      detail: clamp(option.detail, MAX_DETAIL_CHARS),
      recommended: option.recommended === true,
      effect: option.effect || 'instruct',
      guidance: typeof option.guidance === 'string' ? option.guidance : '',
    };
  });

  const recommended = options.filter((option) => option.recommended);
  if (recommended.length > 1) {
    throw new Error('A clarification must recommend exactly one option, not several.');
  }
  if (recommended.length === 0) {
    logger.warn('A clarification was built with no recommended option; promoting the first.');
    options[0].recommended = true;
  }

  return {
    id: nextId(),
    kind: spec.kind || 'choice',
    question,
    context: clamp(spec.context, MAX_QUESTION_CHARS),
    options,
    // Always, and deliberately not settable. The options are the agent's reading of a
    // situation it has just demonstrated it does not fully understand.
    allowFreeText: true,
  };
}

/**
 * Resolve an answer against the question it answers.
 *
 * Returns a decision even for input that matches nothing, because the caller is a run
 * that is currently blocked: "the answer made no sense" has to resolve to *something*,
 * and the safe something is to stop rather than to pick an option on the user's behalf.
 *
 * @param {Clarification} clarification
 * @param {ClarificationAnswer | null} answer
 * @returns {{effect: ClarificationEffect, guidance: string, label: string}}
 */
function resolve(clarification, answer) {
  if (!answer || answer.cancelled) {
    return { effect: 'stop', guidance: '', label: 'stopped' };
  }

  // Free text wins over a selected option: a user who typed something meant it, and it
  // carries more than the option they may also have clicked.
  const typed = clamp(answer.text, 500);
  if (typed) {
    return {
      effect: 'instruct',
      guidance: typed,
      label: 'answered',
    };
  }

  const chosen = clarification.options.find((option) => option.id === answer.optionId);
  if (!chosen) {
    logger.warn(`Clarification ${clarification.id} answered with an unknown option; stopping.`);
    return { effect: 'stop', guidance: '', label: 'stopped' };
  }

  return {
    effect: chosen.effect,
    guidance: chosen.guidance || chosen.label,
    label: chosen.label,
  };
}

module.exports = {
  build,
  resolve,
  clamp,
  MIN_OPTIONS,
  MAX_OPTIONS,
  MAX_LABEL_CHARS,
  MAX_QUESTION_CHARS,
};
