'use strict';

/**
 * Split a long, structured request into work items — without asking the model.
 *
 * ## Why this exists
 *
 * `plannerAgent.planTodos` asks the model to break a request into a checklist, and it
 * works. It is also unavailable to exactly the models that need it most: it requires
 * Ollama's `thinking` capability and at least 2B parameters, because a model that
 * cannot hold three goals at once cannot be trusted to *invent* them either.
 *
 * That left a hole. Below the threshold the model is handed the whole request, every
 * turn, forever. On a 98-line brief and a 1,800-token Tier B budget that is not a
 * disadvantage, it is the entire budget: the request alone fills the window, the
 * working set and the observation are squeezed out, and `goalReminder` — which caps
 * the restated goal at 240 characters — restates the preamble rather than the work.
 * The measured result on `qwen3.5:0.8b` was two `list_files` calls and a stop.
 *
 * The way out is that a well-written brief has *already been decomposed by the person
 * who wrote it*. Headings, numbered steps and bullet lists are a plan someone typed
 * out. Reading that structure needs no inference at all, so it works at 0.8B exactly
 * as well as at 70B — the extension does the splitting, and the model is only ever
 * asked to do one section at a time.
 *
 * ## What it will not do
 *
 * It does not paraphrase, reorder, merge or invent. Every item is a span of the user's
 * own text, in the user's own order. When the request has no structure to read — a
 * one-line "fix the login bug" — it returns nothing and the caller carries on exactly
 * as before. A wrong split is worse than none, so the bar for splitting at all is a
 * request that is both long and visibly sectioned.
 *
 * @module core/requestPlan
 */

const logger = require('../utils/logger');

/**
 * Below this, a request is one thing however many bullets it has.
 *
 * Set from the failure it exists to prevent: three short bullets ("add a button, wire
 * it up, test it") split into three sessions costs three planning round-trips and two
 * extra prompts to save nothing, because all three fit in one window anyway. The cost
 * of splitting is per item and real, so the request has to be big enough that not
 * splitting is the expensive option.
 */
const MIN_REQUEST_CHARS = 700;

/** Fewer than this and the split is not telling us anything the request did not. */
const MIN_ITEMS = 2;

/**
 * More than this and a small model spends its session on bookkeeping.
 *
 * Deliberately the same number as `todoList.MAX_ITEMS`. `TodoList` truncates past its
 * own cap, so a plan built to a larger one would have its tail silently dropped — and
 * the tail of a brief is where "and write the README" lives. Matching the two means the
 * overflow is *folded* into the last item by the code below, where it is still asked
 * for, rather than discarded by a slice two files away.
 */
const MAX_ITEMS = 6;

/** An item's own text, before the detail behind it. */
const MAX_ITEM_CHARS = 150;

/**
 * Verbs that open an instruction.
 *
 * Used line-initially and only line-initially, which is what makes it reliable. The
 * brief's "Tech Stack" section is five lines of *constraints* — "React (functional
 * components + hooks only)", "No backend — use in-memory React state" — and every one
 * of them contains a verb somewhere. None of them starts with one. A section whose
 * lines never open with a verb is describing the world the work happens in, not the
 * work, and it belongs in every item rather than being one.
 */
const IMPERATIVE = new RegExp(
  '^(?:' +
    [
      'add', 'build', 'change', 'check', 'confirm', 'configure', 'create', 'delete', 'design',
      'document', 'enforce', 'ensure', 'export', 'fix', 'generate', 'give', 'implement', 'include',
      'initialise', 'initialize', 'install', 'keep', 'make', 'move', 'must', 'name', 'open',
      'persist', 'provide', 'refactor', 'remove', 'rename', 'render', 'replace', 'report', 'run',
      'scaffold', 'set', 'show', 'split', 'start', 'store', 'style', 'summarise', 'summarize',
      'support', 'test', 'update', 'use', 'verify', 'wire', 'write',
    ].join('|') +
    ')\\b',
  'i'
);

/**
 * Sections that describe the reply rather than the work.
 *
 * "When done, summarize: final folder structure, commands to run it" is a request for
 * a closing message. Run as its own item it produces a session that writes nothing and
 * is then judged as having failed — see `todoList.judgeItem`, which decides completion
 * from files changed. The summary is what the run ends with anyway.
 */
const REPORTING_HEADING = /^(?:output|summary|summarise|summarize|report(?:ing)?|deliverables?|when done)\b/i;

/** Leading list markers, heading hashes, numbering and emphasis, stripped for a title. */
function cleanTitle(text) {
  return String(text || '')
    .replace(/^[#>\s]*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/^[-*+]\s*/, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this block of lines ask for something to be done?
 *
 * @param {string[]} lines
 * @returns {boolean}
 */
function hasInstruction(lines) {
  return lines.some((line) => IMPERATIVE.test(cleanTitle(line)));
}

/**
 * Split the text into `{title, lines}` sections at markdown headings.
 *
 * Only the shallowest heading level present is used as the cut. A brief with `##` and
 * `###` in it means the `###` are subsections of the `##`, and splitting on both would
 * produce items nested inside other items.
 *
 * @param {string[]} lines
 * @returns {Array<{title: string, body: string[]}> | null}
 */
function sectionsByHeading(lines) {
  const levels = lines
    .map((line) => /^(#{1,6})\s+\S/.exec(line))
    .filter(Boolean)
    .map((match) => match[1].length);
  if (levels.length < MIN_ITEMS) return null;

  const cut = Math.min(...levels);
  const marker = new RegExp('^#{' + cut + '}\\s+\\S');

  /** @type {Array<{title: string, body: string[]}>} */
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (marker.test(line)) {
      current = { title: cleanTitle(line), body: [] };
      sections.push(current);
      continue;
    }
    // Anything before the first heading is a preamble — the "you are an autonomous
    // coding agent, do not stop until it builds" opening. It is framing for the whole
    // request, so it is not an item and it is not attached to the first one either.
    if (current) current.body.push(line);
  }
  return sections.length >= MIN_ITEMS ? sections : null;
}

/**
 * Split at top-level numbered steps: `1. Scaffold …`, `2. Install …`.
 *
 * Indented numbers are sub-steps of the step above and are left inside it.
 *
 * @param {string[]} lines
 * @returns {Array<{title: string, body: string[]}> | null}
 */
function sectionsByNumber(lines) {
  const marker = /^\d+[.)]\s+\S/;
  const starts = lines.filter((line) => marker.test(line));
  if (starts.length < MIN_ITEMS) return null;

  /** @type {Array<{title: string, body: string[]}>} */
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (marker.test(line)) {
      current = { title: cleanTitle(line), body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return sections.length >= MIN_ITEMS ? sections : null;
}

/**
 * @typedef {object} PlannedItem
 * @property {string} text    The instruction, short enough to be restated every turn.
 * @property {string} detail  The user's own words behind it — this item's section, verbatim.
 */

/**
 * @typedef {object} RequestPlan
 * @property {PlannedItem[]} items
 * @property {string} constraints  Sections that state rules rather than work, kept whole.
 * @property {string} reason       Why it split the way it did, for the log and the record.
 */

/** An empty plan, which every caller must treat as "carry on as before". */
const NO_PLAN = { items: [], constraints: '', reason: '' };

/**
 * Read a request's own structure as a plan.
 *
 * @param {string} request
 * @returns {RequestPlan}
 */
function fromRequest(request) {
  const text = String(request || '');
  if (text.trim().length < MIN_REQUEST_CHARS) return { ...NO_PLAN, reason: 'request is short enough to run in one pass' };

  const lines = text.split(/\r?\n/);
  const sections = sectionsByHeading(lines) || sectionsByNumber(lines);
  if (!sections) return { ...NO_PLAN, reason: 'request has no headings or numbered steps to split on' };

  /** @type {PlannedItem[]} */
  const items = [];
  /** @type {string[]} */
  const constraints = [];
  /** @type {string[]} */
  const dropped = [];

  for (const section of sections) {
    const body = section.body.filter((line) => line.trim().length > 0);
    const titleAsks = IMPERATIVE.test(section.title);

    // A section that names the reply rather than the work. Dropped rather than kept as
    // a constraint: it is an instruction, just not one that changes the workspace, and
    // repeating it under every item would have each one try to write a summary.
    if (REPORTING_HEADING.test(section.title)) {
      dropped.push(section.title);
      continue;
    }

    if (!titleAsks && !hasInstruction(body)) {
      constraints.push([section.title, ...body].join('\n'));
      continue;
    }

    // The item's own sentence: the heading, plus the first line that asks for
    // something, because a heading alone ("Project Setup") does not say what to do.
    const firstAsk = body.map(cleanTitle).find((line) => IMPERATIVE.test(line)) || '';
    const combined = titleAsks || !firstAsk ? section.title : `${section.title}: ${firstAsk}`;
    items.push({
      text: combined.length > MAX_ITEM_CHARS ? `${combined.slice(0, MAX_ITEM_CHARS - 1)}…` : combined,
      detail: [section.title, ...section.body].join('\n').trim(),
    });
  }

  if (items.length < MIN_ITEMS) {
    return { ...NO_PLAN, reason: `found ${items.length} actionable section(s) — not enough to be worth splitting` };
  }

  const kept = items.slice(0, MAX_ITEMS);
  // Past the cap, the tail is folded into the last item rather than dropped. Losing the
  // final section of a brief is how "and write the README" silently stops happening.
  if (items.length > MAX_ITEMS) {
    const overflow = items.slice(MAX_ITEMS);
    const last = kept[kept.length - 1];
    kept[kept.length - 1] = {
      text: last.text,
      detail: [last.detail, ...overflow.map((item) => item.detail)].join('\n\n'),
    };
    logger.info(`Request plan: ${overflow.length} section(s) past the cap folded into the last item.`);
  }

  const reason =
    `split the request into ${kept.length} item(s) from its own headings` +
    (constraints.length ? `, with ${constraints.length} section(s) kept as constraints` : '') +
    (dropped.length ? `, dropping "${dropped.join('", "')}" as reporting` : '');
  logger.info(`Request plan: ${reason}.`);

  return { items: kept, constraints: constraints.join('\n\n').trim(), reason };
}

module.exports = {
  fromRequest,
  cleanTitle,
  hasInstruction,
  sectionsByHeading,
  sectionsByNumber,
  MIN_REQUEST_CHARS,
  MIN_ITEMS,
  MAX_ITEMS,
  MAX_ITEM_CHARS,
};
