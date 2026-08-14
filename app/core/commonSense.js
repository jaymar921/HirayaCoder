'use strict';

/**
 * Reading a request the way a person would, before handing it to a 1B model.
 *
 * ## The failure this is about
 *
 * A request does not have to be well-formed to be obvious. "Update mian.js" in a
 * project containing `main.js` is not ambiguous to a human being for even a moment.
 * To a small model it is a path that does not resolve, and what happens next is the
 * part that costs: it creates `mian.js`, empty or near enough, reports the update
 * done, and the user now has two files where they had one. Observed shape, repeatedly
 * — the model does not question the premise of a request, it executes it literally,
 * and a literal reading of a typo is a new file.
 *
 * The same applies to a reference with nothing behind it. "Fix it" as the first
 * message of a session names nothing; a model handed that will pick a file, and the
 * file it picks is essentially arbitrary.
 *
 * ## The rule this follows
 *
 * **Work around it when the workaround is obvious; ask when it is a real choice.**
 * That line is drawn by the evidence, not by confidence:
 *
 * - Exactly one near-match → repair it, say so in the summary. A user who wrote
 *   `mian.js` next to a `main.js` meant `main.js`, and stopping to ask would be
 *   pedantry with a dialog on it.
 * - Two to four near-matches → ask, offering them. This is the case where guessing is
 *   a coin toss with the user's files as the stake.
 * - No near-match → say nothing. The file may simply not exist yet, which is what
 *   "create" requests look like, and a check that fires on those would be worse than
 *   no check.
 *
 * ## Why this is patterns and not a model call
 *
 * Same reason as `intentRouter` and `factStore`: asking a 1B model whether a request
 * makes sense costs an inference and returns the confidence of a model that could not
 * answer the request either. Everything here is decided from the workspace listing and
 * the text, so it is deterministic, free, and testable — and it can be wrong in only
 * one direction, since a check that finds nothing leaves the request exactly as it was.
 *
 * @module core/commonSense
 */

const clarification = require('../agent/clarification');
const logger = require('../utils/logger');

/**
 * How alike two filenames must be before one is treated as a typo of the other.
 *
 * Paired with `MAX_TYPO_DISTANCE` below, which is the constraint that actually does the
 * work on short names: a ratio alone would rate `app.js` against `api.js` at 0.83 for
 * the same single edit that separates `mian.js` from `main.js`, and those are not the
 * same kind of guess.
 */
const TYPO_THRESHOLD = 0.75;

/**
 * The most edits a typo is allowed to be.
 *
 * Two, because a doubled and a dropped character in one filename is an ordinary slip
 * and three is a different word. `memoryStore.similarity` is not used here despite
 * doing a similar-sounding job: it is Jaccard over *whole words*, so it scores
 * `mian.js` against `main.js` at zero — correct for the note de-duplication it was
 * written for, useless for a misspelling.
 */
const MAX_TYPO_DISTANCE = 2;

/** Beyond this many candidates the question is worse than the guess. */
const MAX_CANDIDATES = 3;

/**
 * Verbs that presuppose the thing already exists.
 *
 * The distinction is the whole safety of this module. "Update mian.js" is a mistake;
 * "create mian.js" is a filename, and it is not this module's business to correct a
 * name the user chose. Only the first list is checked.
 */
const EXPECTS_EXISTING = /\b(update|edit|fix|change|modify|refactor|rename|read|open|delete|remove|check|review|revert|document|test)\b/i;

/**
 * Verbs that create, so a name the user is inventing is left alone.
 *
 * Tested against the words immediately before the filename rather than the whole
 * message, which is a distinction with teeth: "update mian.js **to add** a header" is a
 * typo in a request that happens to contain the word "add", and a whole-message test
 * reads it as a creation and silently declines to help. The window is short for the
 * same reason — "create the parser, then update mian.js" must not have its second
 * clause excused by its first.
 */
const CREATES = /\b(create|add|make|write|new|generate|scaffold|build|init|implement|call(?:ed)?|name[ds]?)\b/i;

/** How many words before a filename are read as its verb. */
const VERB_WINDOW = 6;

/**
 * A stem shorter than this cannot be judged. `a.js` and `b.js` are one edit apart and
 * have nothing to do with each other.
 */
const MIN_STEM_CHARS = 3;

/**
 * A token that looks like a path or a filename.
 *
 * Requires an extension, so ordinary prose survives: "update the parser" names no file
 * and must not be read as one. Backticks and quotes are stripped by the caller.
 */
const PATH_TOKEN = /(?:[\w.@-]+[/\\])*[\w.@-]+\.[a-z0-9]{1,6}\b/gi;

/**
 * Extensions worth treating as a file reference. A version number like `1.2` and a
 * sentence ending in `.js` are told apart here rather than by cleverness.
 */
const SOURCE_EXTENSION =
  /\.(jsx?|tsx?|mjs|cjs|json|css|s[ac]ss|html?|md|ya?ml|py|java|go|rs|rb|php|vue|svelte|txt|toml|ini|xml|sql|sh|bat|ps1)$/i;

/**
 * A message that refers to something without naming it.
 *
 * Anchored, and the pronoun has to be the object of the verb — "fix it" matches,
 * "fix items in the list" does not.
 */
const DANGLING_REFERENCE = /^\s*(?:please\s+)?(?:can you\s+|could you\s+)?(fix|update|change|finish|redo|revert|delete|remove|continue|do)\s+(it|this|that|those|these|them|the thing|the file|that file|this file)\s*[.!?]?\s*$/i;

/**
 * @typedef {object} Interpretation
 * @property {'ok' | 'repaired' | 'ask'} kind
 * @property {string} [task]    The rewritten request, when repaired.
 * @property {string} [note]    What was changed and why, for the summary and memory.
 * @property {import('../agent/clarification').Clarification} [clarification]
 */

/**
 * Every filename-looking token in a message.
 *
 * @param {string} task
 * @returns {string[]} Unique, in the order they appear.
 */
function referencedPaths(task) {
  const text = String(task || '').replace(/[`'"]/g, ' ');
  const found = text.match(PATH_TOKEN) || [];

  /** @type {string[]} */
  const unique = [];
  for (const raw of found) {
    const token = raw.replace(/\\/g, '/');
    if (!SOURCE_EXTENSION.test(token)) continue;
    if (!unique.includes(token)) unique.push(token);
  }
  return unique;
}

/**
 * Does this path exist in the workspace listing?
 *
 * Compared case-insensitively and on the tail, so "update useTodos.js" matches
 * `src/hooks/useTodos.js` — a user naming a file rarely types its full path, and
 * treating that as a miss would fire this module on nearly every well-formed request.
 *
 * @param {string} candidate
 * @param {string[]} files  Workspace-relative paths.
 * @returns {boolean}
 */
function existsIn(candidate, files) {
  const wanted = candidate.toLowerCase();
  // A reference whose folders are wrong but whose *name* is right counts as existing.
  // That is a different mistake from a typo and it needs no help: the model is given
  // the workspace listing, so `src/hooks/useTodos.js` is one read away from
  // `app/useTodos.js`. Treating it as a miss would hand it to the typo matcher, which
  // would find the same file and "correct" a name that was never misspelled.
  const wantedBase = wanted.split('/').pop();
  return files.some((file) => {
    const path = file.toLowerCase().replace(/\\/g, '/');
    return path === wanted || path.endsWith(`/${wanted}`) || path.split('/').pop() === wantedBase;
  });
}

/**
 * Edit distance counting a transposition as one edit, not two.
 *
 * The transposition case is the reason this is not plain Levenshtein: `mian` for `main`
 * is the single commonest way a filename gets mistyped, and Levenshtein charges it two
 * edits — the same as `main` to `mail` plus another change. On a seven-character name
 * that is the difference between a confident match and a miss.
 *
 * Bounded by construction: both inputs are basenames, and the caller has already
 * rejected anything without a file extension.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  // Full matrix rather than two rolling rows: a transposition needs the row before
  // last, and these are filenames — the matrix is tens of cells, not thousands.
  /** @type {number[][]} */
  const d = [];
  for (let i = 0; i <= a.length; i += 1) d.push(new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) d[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) d[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      let best = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
        best = Math.min(best, d[i - 2][j - 2] + 1);
      }
      d[i][j] = best;
    }
  }

  return d[a.length][b.length];
}

/**
 * How alike two filenames are, 0 to 1.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function nameSimilarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - editDistance(a, b) / longest;
}

/**
 * Workspace files whose name is close enough to be a typo of this one.
 *
 * Compared on the basename only. A path that is wrong in its folders but right in its
 * filename is the common case — `src/mian.js` for `app/main.js` — and comparing whole
 * paths would score that on the folders, which are not what was misspelled.
 *
 * @param {string} candidate
 * @param {string[]} files
 * @returns {string[]} Best first, at most `MAX_CANDIDATES`.
 */
function nearMatches(candidate, files) {
  const wanted = String(candidate).split('/').pop().toLowerCase();
  if (wanted.replace(SOURCE_EXTENSION, '').length < MIN_STEM_CHARS) return [];

  /** @type {Array<{file: string, score: number}>} */
  const scored = [];
  for (const file of files) {
    const base = file.replace(/\\/g, '/').split('/').pop().toLowerCase();
    if (base === wanted) continue;

    // An extension mismatch is a different file, not a typo: `main.js` and `main.css`
    // score high on characters and are never the same mistake.
    const wantedExt = (wanted.match(SOURCE_EXTENSION) || [''])[0];
    const baseExt = (base.match(SOURCE_EXTENSION) || [''])[0];
    if (wantedExt && baseExt && wantedExt.toLowerCase() !== baseExt.toLowerCase()) continue;

    if (editDistance(base, wanted) > MAX_TYPO_DISTANCE) continue;
    const score = nameSimilarity(base, wanted);
    if (score >= TYPO_THRESHOLD) scored.push({ file, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_CANDIDATES).map((entry) => entry.file);
}

/**
 * Is this filename one the request is asking to bring into existence?
 *
 * Reads the few words in front of the name, which is where the verb governing it sits
 * in every phrasing that came up: "create X", "add a file called X", "write X".
 *
 * @param {string} task
 * @param {string} referenced
 * @returns {boolean}
 */
function isBeingCreated(task, referenced) {
  const text = String(task || '').replace(/[`'"]/g, ' ');
  const at = text.toLowerCase().indexOf(referenced.toLowerCase());
  if (at <= 0) return false;

  const before = text.slice(0, at).trim().split(/\s+/).slice(-VERB_WINDOW).join(' ');
  return CREATES.test(before);
}

/**
 * Read a request against the workspace it is about.
 *
 * @param {object} input
 * @param {string} input.task
 * @param {string[]} [input.files]         Workspace-relative paths.
 * @param {Array<{role: string, text: string}>} [input.conversation]
 * @param {string} [input.editorPath]      The file open in the editor, if any.
 * @param {boolean} [input.canAsk]         False when nothing can show a question.
 * @returns {Interpretation}
 */
function interpret(input) {
  const task = String(input.task || '');
  const files = Array.isArray(input.files) ? input.files : [];
  const canAsk = input.canAsk !== false;

  const dangling = danglingReference(task, input);
  if (dangling) return dangling;

  // Nothing to check a path against. A session with no workspace listing is not
  // evidence that a file is missing.
  if (files.length === 0) return { kind: 'ok' };

  // Nothing in the message presupposes an existing file, so a name that does not
  // resolve is not yet evidence of anything.
  if (!EXPECTS_EXISTING.test(task)) return { kind: 'ok' };

  for (const referenced of referencedPaths(task)) {
    if (existsIn(referenced, files)) continue;
    // A name the user is inventing is theirs. Judged per path, not per message: a
    // request can read one file and create another.
    if (isBeingCreated(task, referenced)) continue;

    const candidates = nearMatches(referenced, files);
    if (candidates.length === 0) continue;

    if (candidates.length === 1) {
      const chosen = candidates[0];
      logger.info(`"${referenced}" is not in this workspace; reading it as "${chosen}".`);
      return {
        kind: 'repaired',
        // Both names, not a silent substitution. The user has to be able to see that
        // their request was altered and disagree with it — and the model needs the
        // real path, since it is the one that will resolve.
        task: task.replace(referenced, chosen),
        note: `The request named "${referenced}", which does not exist here. Read as "${chosen}".`,
      };
    }

    if (!canAsk) {
      logger.info(`"${referenced}" matches ${candidates.length} files and nothing can ask; leaving it alone.`);
      return { kind: 'ok' };
    }

    return {
      kind: 'ask',
      clarification: clarification.build({
        kind: 'ambiguous',
        question: `There is no "${referenced}" in this project. Which file did you mean?`,
        context: `${candidates.length} files have a similar name.`,
        options: candidates.map((file, index) => ({
          id: `file-${index + 1}`,
          label: file,
          effect: 'instruct',
          // The first is recommended because `nearMatches` sorts by closeness, so it
          // is the most similar name rather than an arbitrary one.
          recommended: index === 0,
          guidance: `The user means ${file}. Work on that file, and do not create "${referenced}".`,
        })),
      }),
    };
  }

  return { kind: 'ok' };
}

/**
 * "Fix it" with nothing to attach "it" to.
 *
 * The editor is checked first because it is nearly always the answer: a user typing
 * "fix it" is looking at the thing they mean. Only a request with no conversation, no
 * open file, and nothing recently changed is genuinely unanswerable.
 *
 * @param {string} task
 * @param {object} input
 * @returns {Interpretation | null}
 */
function danglingReference(task, input) {
  const match = DANGLING_REFERENCE.exec(task);
  if (!match) return null;

  const conversation = Array.isArray(input.conversation) ? input.conversation : [];
  // An earlier turn is an antecedent, and the context builder already carries it. This
  // module has nothing to add to a message that is only short.
  if (conversation.length > 0) return null;

  const verb = match[1].toLowerCase();

  if (input.editorPath) {
    logger.info(`"${task.trim()}" names nothing; taking it as the open file, ${input.editorPath}.`);
    return {
      kind: 'repaired',
      task: `${task.trim()} — the file open in the editor, ${input.editorPath}`,
      note: `The request did not say what to ${verb}. Took it to mean the open file, ${input.editorPath}.`,
    };
  }

  if (input.canAsk === false) return { kind: 'ok' };

  const files = Array.isArray(input.files) ? input.files : [];
  // Offered rather than assumed. With no open file and no conversation there is no
  // evidence at all, and picking one of these would be a guess wearing a decision's
  // clothes.
  const offer = files.slice(0, 2);
  if (offer.length < 1) return { kind: 'ok' };

  return {
    kind: 'ask',
    clarification: clarification.build({
      kind: 'ambiguous',
      question: `What would you like me to ${verb}?`,
      context: 'This is the first message in the session, so there is nothing for "it" to refer to yet.',
      options: [
        ...offer.map((file, index) => ({
          id: `file-${index + 1}`,
          label: file,
          effect: /** @type {const} */ ('instruct'),
          recommended: index === 0,
          guidance: `The user means ${file}.`,
        })),
        {
          id: 'describe',
          label: 'Something else — I will say',
          detail: 'Type what you want changed.',
          effect: /** @type {const} */ ('instruct'),
        },
      ],
    }),
  };
}

module.exports = {
  interpret,
  referencedPaths,
  nearMatches,
  existsIn,
  danglingReference,
  editDistance,
  nameSimilarity,
  TYPO_THRESHOLD,
  MAX_TYPO_DISTANCE,
  MAX_CANDIDATES,
  EXPECTS_EXISTING,
  CREATES,
};
