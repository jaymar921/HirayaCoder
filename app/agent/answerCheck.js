'use strict';

/**
 * Does this answer actually answer the question?
 *
 * ## The failure this exists for
 *
 * Across one evaluation session, a user asked — in order — "can you remember my name?",
 * "how about yours?", "can you verify that you are hirayacoder v0.5.0?", and "wow
 * impressive". Three of those four came back as some variation of:
 *
 *     Here are 2-4 bullet points summarizing the changes:
 *     * The `api/package.json` file has been updated with a new version number…
 *
 * No file had been touched in any of those turns. The model was not confused about the
 * project; it was following rule 9 of its own system prompt, which told it to close
 * every turn with a summary of what changed. That instruction is fixed at the prompt
 * (see `setup/prompts/agentic-system-prompt.md`), and this module is the backstop for
 * when a small model follows the old pattern anyway — which, on 1B–4B classes, it will.
 *
 * ## Why a heuristic runs first and a model call runs second
 *
 * The obvious implementation is to ask the model, every turn, whether its draft answers
 * the question. On the hardware this ships to, that doubles the wait on every reply,
 * including the ones that were fine — which is most of them. It also asks a small model
 * to judge its own output, which is the same model that just got it wrong.
 *
 * So the ordering is: a free structural check on every turn, and a model round-trip only
 * on the turns the check flags. The check is deliberately narrow. It fires on shapes
 * that are wrong regardless of content — a changelog answering "what is your name", an
 * answer identical to the previous one — and stays silent otherwise. A false positive
 * costs one extra call; a false negative costs nothing that was not already broken.
 *
 * What it explicitly does not do is judge whether an answer is *correct*. "Is this
 * about LocoMenu?" is not a question this can settle, and a heuristic that tried would
 * be wrong in the confident, invisible way the whole system already suffers from.
 *
 * @module agent/answerCheck
 */

const intentRouter = require('../core/intentRouter');

/**
 * Openers and phrases that mark an answer as a report of work performed.
 *
 * Drawn from the shapes actually observed, not invented: the "2-4 bullet points" wording
 * is quoted verbatim from the prompt rule that produced it, and models reproduce it
 * closely enough that matching the phrase catches most of the cases outright.
 *
 * Deliberately excluded are "no files were touched" and "these steps did not complete".
 * Both read like a work report and neither is one — they are appended by
 * `agentSession.appendUnfinishedNote` after the model has finished, and they exist to
 * tell the user the truth about a step that failed. This check runs on the model's own
 * summary, before those are added, so they should never arrive here; they are named
 * here so that a future caller passing the assembled text does not silently start
 * redrafting honest failure reports into something smoother.
 */
const CHANGELOG_SHAPE =
  /(?:summar(?:y|ize|izing|ising) (?:of )?(?:the |what )?chang|here are \d(?:-\d)? bullet|bullet points summar|what (?:was |has )?changed|files? (?:were |was )?(?:touched|modified|updated))/i;

/** A filename-shaped token. */
const NAMES_A_FILE = /\b[\w-]{1,64}\.[a-z0-9]{1,6}\b/i;

/** A claim that something was altered. */
const PAST_TENSE_CHANGE =
  /\b(?:has been|have been|was|were|is now|are now)\s+(?:updated|added|created|modified|changed|removed|deleted|rewritten)\b/i;

/**
 * Does this answer report an edit to a named file?
 *
 * Requires both a path-ish token and a past-tense change verb *on the same line*, because
 * either alone is ordinary in a legitimate answer — "the README describes the API" names
 * a file and reports nothing, and "the schema was updated in v2" is history, not this
 * turn's work.
 *
 * Two patterns applied per line rather than one spanning pattern. The single regex that
 * expresses this directly puts an unbounded run between two alternations, which
 * backtracks badly, and this runs on model output of arbitrary length.
 *
 * @param {string} answer
 * @returns {boolean}
 */
function reportsAnEdit(answer) {
  return answer.split('\n').some((line) => NAMES_A_FILE.test(line) && PAST_TENSE_CHANGE.test(line));
}

/**
 * Questions about the assistant itself, rather than about the project.
 *
 * These are the ones a changelog answers most absurdly, and the ones most likely to be
 * phrased without any of the verbs `intentRouter` keys on — "how about yours?" carries
 * no verb at all and is unmistakably a question when it follows "can you remember my
 * name?".
 */
const ABOUT_SELF =
  /\b(?:who are you|what are you|your name|are you|what version|which version|your version|how about you|how about yours|can you remember|do you remember)\b/i;

/**
 * Text stripped to comparable form.
 *
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How much two strings overlap, as a share of the shorter one's words.
 *
 * A bag-of-words ratio rather than an edit distance: the repetition seen in practice is
 * a model re-emitting the same paragraph with a word or two moved, which scores near 1
 * here and would score poorly on a positional measure.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0 to 1.
 */
function overlap(a, b) {
  const left = normalize(a).split(' ').filter(Boolean);
  const right = normalize(b).split(' ').filter(Boolean);
  if (left.length === 0 || right.length === 0) return 0;

  const counts = new Map();
  for (const word of left) counts.set(word, (counts.get(word) || 0) + 1);

  let shared = 0;
  for (const word of right) {
    const remaining = counts.get(word) || 0;
    if (remaining > 0) {
      shared += 1;
      counts.set(word, remaining - 1);
    }
  }

  return shared / Math.min(left.length, right.length);
}

/** Above this, two answers are the same answer. */
const REPEAT_THRESHOLD = 0.85;

/** Below this many words, repetition is not evidence of anything — "Yes." repeats. */
const MIN_WORDS_TO_JUDGE_REPEAT = 12;

/**
 * @typedef {object} Mismatch
 * @property {boolean} mismatched
 * @property {string} [reason]      Why, in one phrase, for the log and the redraft.
 * @property {string} [instruction] What to tell the model when asking for a redraft.
 */

/** Nothing wrong. */
const OK = { mismatched: false };

/**
 * Check a drafted answer against the question it is meant to answer.
 *
 * @param {object} request
 * @param {string} request.task                The user's message.
 * @param {string} request.answer              The drafted reply.
 * @param {boolean} [request.changedFiles]     Did this turn actually modify the workspace?
 * @param {Array<{role: string, text: string}>} [request.conversation]
 *   Earlier turns, oldest first, excluding this one.
 * @returns {Mismatch}
 */
function check(request) {
  const task = String(request.task || '');
  const answer = String(request.answer || '').trim();
  if (!answer) return OK;

  // A turn that really did change files has earned its changelog, whatever was asked.
  const changed = Boolean(request.changedFiles);

  // The model reporting its own failure is not a mismatch — it is the honest outcome,
  // and redrafting it would be asking a model to talk its way out of a refusal.
  if (/^(?:the model could not be reached|no answer was produced)/i.test(answer)) return OK;

  const asksForChange = intentRouter.requiresChange(task);
  const asksAboutSelf = ABOUT_SELF.test(task);

  // The headline case: a report of work, for a message that asked for none and where
  // none happened.
  if (!changed && !asksForChange && (CHANGELOG_SHAPE.test(answer) || reportsAnEdit(answer))) {
    return {
      mismatched: true,
      reason: asksAboutSelf
        ? 'answered a question about yourself with a summary of file changes'
        : 'answered a question with a summary of file changes, though nothing changed',
      instruction:
        'Your draft reported changes to files. The user did not ask you to change anything, ' +
        'and you changed nothing. Answer the question they actually asked, in prose, and do ' +
        'not mention file changes at all.',
    };
  }

  // The second case: the same answer twice. Observed with a 0.8b model, which replied to
  // "give me a joke" by restating the previous turn's arithmetic answer, then did it
  // again for "haha!". Only counted when the questions differ — a user who asks the same
  // thing twice may legitimately get the same answer.
  const conversation = Array.isArray(request.conversation) ? request.conversation : [];
  if (normalize(answer).split(' ').length >= MIN_WORDS_TO_JUDGE_REPEAT) {
    for (let i = conversation.length - 1; i >= 0; i -= 1) {
      const turn = conversation[i];
      if (!turn || turn.role !== 'assistant') continue;
      if (overlap(answer, turn.text) < REPEAT_THRESHOLD) break;

      // Find the question that earlier answer was given to, to be sure it was a
      // different one.
      const priorQuestion = conversation.slice(0, i).reverse().find((prior) => prior && prior.role === 'user');
      if (priorQuestion && overlap(task, priorQuestion.text) >= REPEAT_THRESHOLD) break;

      return {
        mismatched: true,
        reason: 'repeated the previous answer for a different question',
        instruction:
          'Your draft repeats, almost word for word, an answer you already gave earlier in ' +
          'this conversation — to a different question. Read the latest message again and ' +
          'answer that one. Do not restate your previous reply.',
      };
    }
  }

  return OK;
}

module.exports = {
  check,
  overlap,
  normalize,
  CHANGELOG_SHAPE,
  reportsAnEdit,
  ABOUT_SELF,
  REPEAT_THRESHOLD,
};
