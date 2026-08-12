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

    const items = parsePlanSummary(message.content || '');
    logger.info(`TODO planner produced ${items.length} item(s).`);
    return items;
  } catch (err) {
    // A failed split is not a failed session: the caller falls back to running the
    // whole task as one item, which is what every model did before this existed.
    logger.warn(`TODO planning failed: ${/** @type {Error} */ (err).message}`);
    return [];
  }
}

module.exports = { plan, planTodos, parsePlanSummary, MAX_PLAN_STEPS };
