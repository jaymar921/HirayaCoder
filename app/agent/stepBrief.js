'use strict';

/**
 * The brief one TODO item is run against.
 *
 * ## What the old per-item prompt was missing
 *
 * `_runWithTodos` already gave each item its own loop, its own trace, and its own step
 * budget. What it gave the model was the whole original request, the checklist, and the
 * sentence "right now, do only item N". Everything the *previous items actually
 * produced* was absent — the checklist says an item is done, never what it did.
 *
 * On the React + Vite + Tailwind benchmark that gap is the whole failure. The sixth
 * item, "Assemble App.jsx layout…", ran with no way to know that items three and four
 * had created `src/hooks/useTodos.js` and `src/components/TodoInput.jsx`. It had five
 * imports to write and no evidence that any of the five files existed. Across five
 * models, `App.jsx` ended every run holding Vite's scaffolded counter demo.
 *
 * So a brief states, in order: what this item is, what the earlier items left behind,
 * which files are in play, and what happens when it is finished. Each of those is
 * something the extension knows for certain from its own records — the change set, the
 * file history, the checklist — and none of it is the model's account of itself.
 *
 * ## Why the item goes last
 *
 * `contextBuilder` truncates from the head on the Task section. The instruction that
 * decides what the model does next therefore has to survive a cut, and the way to
 * guarantee that is to keep the brief short rather than to reorder it — so the item is
 * stated twice, once at the top as the heading and once at the bottom as the
 * instruction, and the recoverable background sits between them.
 *
 * @module agent/stepBrief
 */

const { neutralize } = require('../core/memoryStore');

/** Files listed as available context before the list is elided. */
const MAX_FILES_LISTED = 12;

/**
 * How much of the original request rides along as background.
 *
 * The brief goes into `contextBuilder` as the Task section, which truncates from the
 * **head** — so anything past the cut is the closing instruction, which is the one line
 * that decides what the model does next. On Tier A's 12,000-token budget nothing is at
 * risk; on Tier B's 1,800 the 5,000-character spec that produced this feature would
 * consume the whole section and the instruction would be the part that vanished.
 *
 * So the background is capped here rather than left to be trimmed there. It is capped
 * from the head for the usual reason — a request says what it wants first and qualifies
 * it afterwards — and it is the right thing to shorten, because it is explicitly the
 * part the step is told not to act on.
 */
const MAX_BACKGROUND_CHARS = 1200;

/** Completed items summarized before the older ones are dropped. */
const MAX_PRIOR_ITEMS = 6;

/**
 * How much of an item's own section rides along as its spec.
 *
 * Larger than `MAX_BACKGROUND_CHARS` because it is doing the opposite job. That cap
 * shortens something the step has been told to ignore; this one carries the thing the
 * step has been told to do, and cutting it drops requirements. The benchmark brief's
 * largest section — the folder tree, which names twelve files — is just over a
 * thousand characters, so this is set where a whole section of a real request fits.
 */
const MAX_DETAIL_CHARS = 1600;

/** The rules repeated under every step. Short, because they are paid for every time. */
const MAX_CONSTRAINT_CHARS = 500;

/**
 * A path, or a path-like token, inside an item's text.
 *
 * The repeated group is separated by a mandatory `/`, which the character class
 * excludes, so no two iterations can claim the same characters and *one* match is
 * linear despite the nested quantifier the linter flags.
 *
 * The cost that is not linear is scanning with `/g` for matches that are not there.
 * Every start position inside an unbroken run of word characters gets its own scan,
 * which makes the sweep O(n²) in the length of that run — the same shape
 * `core/commonSense` documents and bounds, in the module that copied its comment and
 * not its bound. Measured on a single run of `a`, which is what a pasted data URI,
 * minified line or hash looks like to this expression: 23 ms at 3,200 characters,
 * 6.1 s at 51,200, and **85 s at 204,800**. That is a hard freeze of the extension
 * host, reached by a paste rather than by an attack.
 *
 * Bounding the segment is what fixes it: work per start position is capped, so the
 * sweep is linear again — 244 ms at 204,800 characters. 120 is far past any real path
 * segment, and the filter below still requires an extension or a `/`, so nothing this
 * repo has ever matched is affected. Pinned by a test rather than left to the comment.
 */
const PATH_TOKEN = /[\w@.-]{1,120}(?:\/[\w@.-]{1,120})+|[\w@-]{1,120}\.[a-z0-9]{1,6}\b/gi;

/**
 * The files an item names outright.
 *
 * A planner names its target most of the time — "Assemble App.jsx layout", "Implement
 * useTodos hook" — and when it does, that name is the single most useful thing in the
 * brief, because it is what the model has to open and what it has to write.
 *
 * @param {string} text
 * @returns {string[]}
 */
function namedFiles(text) {
  const found = String(text || '').match(PATH_TOKEN);
  if (!found) return [];
  // A bare `2.` or a version like `3.5` is not a file. Requiring a letter in the
  // extension is enough, and cheaper than trying to know every real one.
  return [...new Set(found.filter((token) => /\.[a-z][a-z0-9]{0,5}$/i.test(token) || token.includes('/')))];
}

/**
 * What the finished items left behind, as paths.
 *
 * Read from the change set rather than from any summary: this is the list of files that
 * demonstrably exist because this session created or edited them, which is exactly the
 * claim the next item needs to be able to rely on.
 *
 * @param {Array<{kind: string, path: string}>} changes
 * @returns {{created: string[], edited: string[], deleted: string[]}}
 */
function partitionChanges(changes) {
  /** @type {{created: string[], edited: string[], deleted: string[]}} */
  const grouped = { created: [], edited: [], deleted: [] };
  for (const change of changes || []) {
    if (!change || !change.path) continue;
    if (change.kind === 'create') grouped.created.push(change.path);
    else if (change.kind === 'delete') grouped.deleted.push(change.path);
    else grouped.edited.push(change.path);
  }
  return grouped;
}

/**
 * A line per finished item: what it was, how it ended, and what it changed.
 *
 * `outcome` is the extension's own judgement from `judgeItem`, never the model's
 * summary — the whole point of carrying status forward is that it is trustworthy.
 *
 * @param {import('./todoList').TodoItem[]} items
 * @param {number} position  1-based index of the item being run now.
 * @returns {string}
 */
function renderPriorItems(items, position) {
  const finished = (items || []).slice(0, Math.max(0, position - 1));
  if (finished.length === 0) return '';

  const shown = finished.slice(-MAX_PRIOR_ITEMS);
  const elided = finished.length - shown.length;

  const lines = shown.map((item, offset) => {
    const index = elided + offset + 1;
    const verdict = {
      done: 'DONE',
      'done-with-warning': 'DONE (unconfirmed)',
      failed: 'FAILED',
      skipped: 'NOT ATTEMPTED',
    }[item.status] || String(item.status).toUpperCase();
    const files = (item.changedPaths || []).length > 0 ? ` — wrote ${item.changedPaths.join(', ')}` : '';
    const why = item.outcome && item.status !== 'done' ? ` (${item.outcome})` : '';
    return `${index}. [${verdict}] ${item.text}${files}${why}`;
  });

  const header = elided > 0 ? `Earlier steps (${elided} older one(s) not shown):` : 'Earlier steps in this task:';
  return `${header}\n${lines.join('\n')}`;
}

/**
 * The files this step should be working in.
 *
 * Three sources, in descending order of confidence: the paths the item names itself,
 * the paths earlier steps created or edited, and the paths the user attached or has
 * open. Everything else the model can still find with `list_files` — this list is a
 * starting point, not a permission boundary.
 *
 * @param {object} options
 * @param {string} options.item
 * @param {Array<{kind: string, path: string}>} [options.changes]
 * @param {string[]} [options.workspaceFiles]
 * @returns {string}
 */
function renderFiles(options) {
  const named = namedFiles(options.item);
  const grouped = partitionChanges(options.changes);
  const produced = [...grouped.created, ...grouped.edited];

  // A file this session already wrote and this item also names is the interesting
  // case — it means "edit what you built", not "create it again" — so it is called out
  // rather than listed twice.
  const existing = new Set(produced);
  const toCreateOrEdit = named.filter((path) => !existing.has(path));

  /** @type {string[]} */
  const lines = [];

  if (toCreateOrEdit.length > 0) {
    lines.push(`Files this step names: ${toCreateOrEdit.slice(0, MAX_FILES_LISTED).join(', ')}`);
  }
  if (produced.length > 0) {
    lines.push(
      `Files this session has already written (they exist — read them before importing from them, ` +
        `and edit rather than recreate): ${produced.slice(-MAX_FILES_LISTED).join(', ')}`
    );
  }
  if (grouped.deleted.length > 0) {
    lines.push(`Files this session deleted (they are gone): ${grouped.deleted.slice(0, MAX_FILES_LISTED).join(', ')}`);
  }

  const overlap = named.filter((path) => existing.has(path));
  if (overlap.length > 0) {
    lines.push(`${overlap.join(', ')} already exists from an earlier step — modify it, do not start over.`);
  }

  return lines.join('\n');
}

/**
 * Build the brief for one step.
 *
 * @param {object} options
 * @param {string} options.task                     The user's original request.
 * @param {string} options.item                     The item being run now.
 * @param {number} options.position                 1-based.
 * @param {number} options.total
 * @param {import('./todoList').TodoItem[]} [options.items]     The whole checklist.
 * @param {Array<{kind: string, path: string}>} [options.changes]  The change set so far.
 * @param {number} [options.attempt]                1 on the first try, 2 on a retry.
 * @param {string} [options.previousFailure]        Why the first attempt did not land.
 * @param {string} [options.detail]
 *   This item's own section of the request, verbatim — present when the checklist was
 *   read from the request's structure rather than proposed by the model. See below.
 * @param {string} [options.constraints]
 *   Rules that hold for every step, kept out of the items that state them.
 * @returns {string}
 */
function build(options) {
  const position = Number(options.position) || 1;
  const total = Number(options.total) || 1;
  const item = neutralize(options.item, { maxChars: 400 });
  const attempt = Number(options.attempt) || 1;

  /** @type {string[]} */
  const blocks = [];

  blocks.push(`Step ${position} of ${total}: ${item}`);

  const detail = String(options.detail || '').trim();
  if (detail) {
    // The item's own section, promoted rather than demoted.
    //
    // When `core/requestPlan` built the checklist, each item carries the span of the
    // request it came from — and that span is not background, it *is* the spec for this
    // step. Handing it over whole is the point of the split: the model gets the three
    // hundred words about the folder structure instead of the five thousand about the
    // whole app, and it gets them as an instruction rather than as something it has
    // been told not to act on.
    //
    // The full request is deliberately not included as well. Both would put the thing
    // this step must ignore back in front of a model whose entire budget is the reason
    // the request was split.
    blocks.push(
      `What this step asks for, in the user's own words:\n---\n` +
        neutralize(detail, { maxChars: MAX_DETAIL_CHARS }) +
        `\n---`
    );
  } else {
    // The original request is background, explicitly demoted. Without saying so, a model
    // handed a 5,000-character spec and one item does the spec.
    const full = String(options.task || '').trim();
    if (full) {
      const task = full.length > MAX_BACKGROUND_CHARS ? `${full.slice(0, MAX_BACKGROUND_CHARS)}…` : full;
      blocks.push(
        `This step is one part of a larger request. The request is below for background only — ` +
          `do NOT try to satisfy all of it now, only step ${position}.\n---\n${task}\n---`
      );
    }
  }

  const constraints = String(options.constraints || '').trim();
  if (constraints) {
    // Short, and repeated under every step on purpose: these are the lines the user
    // wrote that are true of all the work rather than of one piece of it, and the step
    // that does not see them is the step that reaches for a component library.
    blocks.push(
      `These apply to every step, including this one:\n${neutralize(constraints, { maxChars: MAX_CONSTRAINT_CHARS })}`
    );
  }

  const prior = renderPriorItems(options.items, position);
  if (prior) blocks.push(prior);

  // The detail is searched for filenames alongside the item text. It is where they
  // actually are: "Folder Structure" names nothing, and the tree underneath it names
  // all twelve files the step has to create.
  const files = renderFiles({ item: `${options.item}\n${detail}`, changes: options.changes });
  if (files) blocks.push(files);

  if (attempt > 1) {
    // A retry that repeats the first attempt is a wasted budget. Naming what went wrong
    // is the only thing that makes the second try different from the first.
    blocks.push(
      `This is attempt ${attempt}. The previous attempt did not complete this step: ` +
        `${neutralize(options.previousFailure || 'nothing was written', { maxChars: 300 })}\n` +
        'Do not repeat it. Start by writing the file this step needs, then read back what you wrote.'
    );
  }

  blocks.push(
    `Do step ${position} and nothing else: ${item}\n` +
      'The other steps are handled separately — do not start them and do not redo them. ' +
      'This step is only finished once a file has been created or changed with write_file, ' +
      'sending the COMPLETE contents in "code". When it is, reply "done".'
  );

  return blocks.join('\n\n');
}

module.exports = {
  build,
  namedFiles,
  partitionChanges,
  renderPriorItems,
  renderFiles,
  MAX_FILES_LISTED,
  MAX_PRIOR_ITEMS,
  MAX_BACKGROUND_CHARS,
  MAX_DETAIL_CHARS,
  MAX_CONSTRAINT_CHARS,
};
