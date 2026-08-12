'use strict';

/**
 * The optional up-front planning pass.
 *
 * One cheap call before the loop starts, asking the model to break the task into a
 * few concrete steps. On Tier A that plan becomes a checkpoint to re-plan against;
 * on Tier B it is mostly a way to stop a small model from diving at the first file
 * it thinks of.
 *
 * Deliberately best-effort. A plan is a hint, not a contract — the loop is free to
 * diverge, and a failed or nonsensical planning call returns nothing rather than
 * blocking the actual work. That is why this returns `[]` rather than throwing.
 *
 * @module agent/plannerAgent
 */

const logger = require('../utils/logger');

const MAX_PLAN_STEPS = 6;
const PLAN_TIMEOUT_MS = 30000;

/**
 * Longer than the plain planning pass, because this one thinks. Measured on
 * `qwen3.5:4b` on a CPU-only laptop, a reasoning pass over a three-part request runs
 * comfortably past 30s, and timing it out would silently disable the feature on
 * exactly the models it was built for.
 */
const TODO_TIMEOUT_MS = 180000;

const PLAN_PROMPT = `You are planning a coding task before starting work.

Task: {task}

{context}

List the steps needed, at most {max}. One step per line, each starting with a number
and a dot, like "1. ". Name the file each step will touch when you know it. Keep each
step under 15 words. If the task is a single step, list just that one.

Reply with the numbered list only — no preamble, no explanation.`;

/**
 * Splitting a request into independently executable pieces of work.
 *
 * Different from `PLAN_PROMPT` in one way that matters: it insists on *one item per
 * deliverable*, not one per action. A plan may reasonably say "read the file, then
 * edit it"; a TODO list must not, because each item becomes its own read-think-modify
 * loop and "read the file" has no completion condition of its own.
 *
 * The instruction to return a single item for a single change is load-bearing. A
 * model asked to produce a list will produce a list, and a one-file edit split into
 * four items runs four loops to do one thing.
 */
const TODO_PROMPT = `Break this request into a TODO list.

Request: {task}

{context}

Rules:
- One item per separate piece of work the user asked for. Look for "and", "also",
  "then", or a list — those usually separate items.
- If the request is really ONE change, reply with ONE item. Do not invent extra work.
- Each item must be something you can finish and check. "Read the file" is not an
  item; "Update the greet function to handle an empty name" is.
- Name the file when you know it. Under 15 words each. At most {max} items.

Reply with a numbered list only — no preamble, no explanation.`;

/** Verbs that, at the start of an item, might mean "just look at this". */
const INSPECTION_VERB = /^(?:re-?read|read|open|view|inspect|examine|look\s+at|navigate\s+to|locate)\s+/i;

/** "Save the changes", "save it" — a write is already saved, so this asks for a no-op. */
const SAVE_NO_OP = /^save\s+(?:the\s+)?(?:changes?|edits?|file|it)\b/i;

/**
 * Items that only check work another item does.
 *
 * "Run tests" is here rather than with the no-op verbs because it does do something —
 * it just does not deliver any part of a request that never mentioned testing.
 */
const VERIFICATION_ITEM =
  /^(?:verify|confirms?|ensures?|checks?(?!-)|tests?(?!-)|validates?|make\s+sure|double-?check|review|run\s+(?:the\s+)?(?:unit\s+)?tests?\b|run\s+the\s+test\s+suite)\b/i;

/** Does the request itself ask for anything to be checked? */
const REQUESTED_VERIFICATION =
  /\b(?:test|tests|testing|verify|verified|confirm|ensure|check|validate|make\s+sure|lint|typecheck)\b/i;

/** A path or a filename anywhere in the text. */
const NAMES_A_FILE = /[\w-]+\.[a-z0-9]{1,6}\b|[\w.-]+[/\\][\w./\\-]+/i;

/** Every filename in a string, reduced to its stem: `src/greet.js` → `greet`. */
const FILE_STEMS = /([\w-]+)\.[a-z0-9]{1,6}\b/gi;

/**
 * Does the request itself refer to this file?
 *
 * Compared on the stem, because a request says "delete the obsolete file" where the
 * plan says `src/obsolete.js`, and those are the same subject.
 *
 * @param {string} item
 * @param {string} task
 * @returns {boolean}
 */
function targetsAFileTheRequestMentions(item, task) {
  const haystack = String(task || '').toLowerCase();
  for (const match of item.matchAll(FILE_STEMS)) {
    if (haystack.includes(match[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * Is everything after an inspection verb just a target, with no work in it?
 *
 * This is the whole safety margin of the verb rule. "Read src/greet.js" is a target and
 * nothing else; "Open a websocket connection in src/client.js" starts with the same
 * verb and is a feature. Only the first is dropped.
 *
 * @param {string} rest
 * @returns {boolean}
 */
function isBareTarget(rest) {
  const cleaned = rest
    .trim()
    .replace(/[.\s]+$/, '')
    .replace(/^(?:the|its|this|current)\s+/i, '')
    .replace(/^(?:file|contents?\s+of)\s+/i, '');

  if (cleaned === '') return true;
  if (/^[\w@.-]+[/\\][\w@./\\-]*$/.test(cleaned)) return true; // a path
  if (/^[\w@-]+\.[a-z0-9]{1,6}$/i.test(cleaned)) return true; // a filename
  return /^(?:files?|code|contents?|source|project|codebase)$/i.test(cleaned);
}

/**
 * Drop items that are not deliverables.
 *
 * `TODO_PROMPT` already asks for one item per deliverable and gives "Read the file" as
 * the counter-example. Models ignore it. Measured on the one-file benchmark task:
 * `qwen3.5:2b` returned "Read src/greet.js" / "Update greet function…" / "Verify
 * updated behavior in browser or test runner", and `gemma4:e2b` returned "Open
 * src/greet.js" / "Update the greet function…" / "Ensure the function returns…" /
 * "Save changes to src/greet.js" — three or four loops to make one edit, most of which
 * could only re-read the file and get stopped as repeating. A single-pass run of the
 * same task passes on both models, so the TODO path made the simple task worse.
 *
 * So the list is filtered here rather than asked for more nicely, which is the same
 * decision `todoList.js` makes about who owns the list: the model proposes, the
 * extension decides.
 *
 * ## Which way this errs
 *
 * Deliberately towards keeping. A junk item costs a wasted loop and a row in the
 * summary that reads badly. A wrongly dropped item means work the user asked for
 * silently never happens, and they find out later. So both rules are narrow:
 *
 *  - An inspection verb only counts when nothing follows it but a target.
 *  - A verification item is kept when it names a file the request itself refers to.
 *    "Ensure README.md mentions the new flag" survives a request that mentions the
 *    README; "Check if obsolete.js is still needed" does not survive a request about
 *    `src/greet.js` alone, because that file was the planner's own idea. Comparison is
 *    on the filename stem, since a request says "the obsolete file" where the plan says
 *    `src/obsolete.js`.
 *
 * Verification items are also kept outright when the request itself mentions testing
 * or checking, since then it is the user's own instruction — "update it and make sure
 * the tests pass" keeps its second item.
 *
 * @param {string[]} items
 * @param {string} task  The user's request, verbatim.
 * @returns {string[]}
 */
function dropNonDeliverables(items, task) {
  const wantsVerification = REQUESTED_VERIFICATION.test(String(task || ''));

  return items.filter((item) => {
    const verb = INSPECTION_VERB.exec(item);
    if (verb && isBareTarget(item.slice(verb[0].length))) return false;
    if (SAVE_NO_OP.test(item)) return false;
    if (
      !wantsVerification &&
      VERIFICATION_ITEM.test(item) &&
      !(NAMES_A_FILE.test(item) && targetsAFileTheRequestMentions(item, task))
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Pull numbered steps out of a model reply.
 *
 * Tolerant of the shapes models actually produce (`1.`, `1)`, `-`, `Step 1:`) but
 * never invents structure: prose with no list yields nothing.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parsePlanSummary(raw) {
  const text = String(raw == null ? '' : raw);
  /** @type {string[]} */
  const steps = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Three trivial patterns rather than one clever one. This runs on model output,
    // and a combined pattern with an optional prefix and a trailing capture gives
    // two quantifiers the same whitespace to fight over — the shape that backtracks
    // exponentially. Each of these is obviously linear.
    const body = trimmed.replace(/^step\s+/i, '');
    const marker = /^(?:\d+[.):]|[-*•])/.exec(body);
    if (!marker) continue;

    const step = body.slice(marker[0].length).trim();
    if (step.length < 3) continue;
    steps.push(step);
    if (steps.length >= MAX_PLAN_STEPS) break;
  }

  return steps;
}

/**
 * Produce a plan for a task.
 *
 * @param {object} options
 * @param {import('../core/ollamaClient').OllamaClient} options.client
 * @param {string} options.model
 * @param {string} options.task
 * @param {string} [options.context]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string[]>} Empty when planning did not produce anything usable.
 */
async function plan(options) {
  const prompt = PLAN_PROMPT.replace('{task}', options.task)
    .replace('{context}', options.context ? `Context:\n${options.context}` : '')
    .replace('{max}', String(MAX_PLAN_STEPS));

  try {
    const response = await options.client.chat(
      {
        model: options.model,
        messages: [{ role: 'user', content: prompt }],
        // The plan itself is the output; a separate reasoning trace would only
        // consume the budget on a hybrid model.
        think: false,
        options: { temperature: 0.2, num_predict: 300 },
      },
      { timeoutMs: PLAN_TIMEOUT_MS, signal: options.signal }
    );

    const steps = parsePlanSummary((response && response.message && response.message.content) || '');
    logger.debug(`Planner produced ${steps.length} step(s).`);
    return steps;
  } catch (err) {
    // Planning is an optimization; the loop works without it.
    logger.warn(`Planning pass failed: ${/** @type {Error} */ (err).message}`);
    return [];
  }
}

/**
 * Ask the model to split a request into a TODO list.
 *
 * Only called for models that report Ollama's `thinking` capability and clear the
 * size floor — see `core/modelCapability.js`.
 *
 * ## The capability gates the model, not the request
 *
 * `thinking` decides *which models are trusted with a list*. It is not an instruction
 * to turn Ollama's thinking mode on, and conflating the two broke this outright: with
 * `think: true`, `qwen3.5:2b` spent 4,971 characters and 147 seconds reasoning, hit
 * `done_reason: "length"`, and returned **empty content** — so the list was always
 * empty and every session silently fell back to a single pass. The same prompt with
 * `think: false` returns a correct three-item list in 9.6 seconds.
 *
 * The product here is the list. A reasoning trace that consumes the budget before the
 * list is written is not deliberation, it is the answer being crowded out — the same
 * failure `reactLoop` and `contextTranslator` already guard against.
 *
 * @param {object} options
 * @param {import('../core/ollamaClient').OllamaClient} options.client
 * @param {string} options.model
 * @param {string} options.task
 * @param {string} [options.context]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string[]>} Empty when planning produced nothing usable.
 */
async function planTodos(options) {
  const prompt = TODO_PROMPT.replace('{task}', options.task)
    .replace('{context}', options.context ? `Context:\n${options.context}` : '')
    .replace('{max}', String(MAX_PLAN_STEPS));

  try {
    const response = await options.client.chat(
      {
        model: options.model,
        messages: [{ role: 'user', content: prompt }],
        // See above: on a hybrid model this must be false or the list never arrives.
        think: false,
        options: { temperature: 0.2, num_predict: 400 },
      },
      { timeoutMs: TODO_TIMEOUT_MS, signal: options.signal }
    );

    const message = (response && response.message) || {};

    // An empty answer with a full reasoning trace is the signature of a model that
    // thought instead of replying. Named explicitly, because the symptom otherwise is
    // "TODO lists just never happen" with nothing in the log to explain it.
    if (!String(message.content || '').trim() && message.thinking) {
      logger.warn(
        `${options.model} spent its whole budget reasoning (${String(message.thinking).length} chars) ` +
          'and returned no TODO list. Falling back to a single pass.'
      );
      return [];
    }

    const proposed = parsePlanSummary(message.content || '');
    const items = dropNonDeliverables(proposed, options.task);
    if (items.length !== proposed.length) {
      logger.info(
        `TODO planner proposed ${proposed.length} item(s); ${proposed.length - items.length} were not ` +
          'deliverables and were dropped.'
      );
    }
    logger.info(`TODO planner produced ${items.length} item(s).`);
    return items;
  } catch (err) {
    // A failed split is not a failed session: the caller falls back to running the
    // whole task as one item, which is what every model did before this existed.
    logger.warn(`TODO planning failed: ${/** @type {Error} */ (err).message}`);
    return [];
  }
}

module.exports = { plan, planTodos, parsePlanSummary, dropNonDeliverables, MAX_PLAN_STEPS };
