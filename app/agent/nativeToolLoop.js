'use strict';

/**
 * Tier A: the native tool-calling loop.
 *
 * Structurally the same plan → act → observe cycle as `reactLoop`, driven by
 * Ollama's function-calling format instead of hand-parsed JSON. The differences are
 * real but narrow:
 *
 *  - The conversation *is* accumulated here. A model with native tool support has a
 *    context window that can hold it, and the tool-call/tool-result message pairing
 *    is what the chat template was trained on — rebuilding each turn would throw
 *    away the structure that makes this tier work.
 *  - A model may request several tools in one message; each is executed in order and
 *    answered with its own `tool` message.
 *  - A reply with no tool calls means the model is finished, so its text is the
 *    summary. There is no `done` action to emit.
 *
 * Everything downstream — the permission gate, the change set, the audit log — is
 * identical, because both loops call the same `execute`.
 *
 * @module agent/nativeToolLoop
 */

const logger = require('../utils/logger');
const { parseToolCalls } = require('../core/outputParser');
const { truncateToTokens } = require('../utils/tokenBudget');

/** Guards against a model that calls the same tool with the same arguments forever. */
const REPEAT_LIMIT = 3;

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @returns {string}
 */
function callKey(name, args) {
  return `${name}|${args.path || ''}|${args.query || ''}|${args.command || ''}`;
}

/**
 * Run a Tier A session.
 *
 * @param {object} options
 * @param {import('../core/ollamaClient').OllamaClient} options.client
 * @param {string} options.model
 * @param {import('../core/promptRouter').Route} options.route
 * @param {string} options.task
 * @param {string} options.context
 * @param {(action: import('../core/outputParser').ParsedAction) => Promise<import('../agent/toolRegistry').ToolResult>} options.execute
 * @param {(event: object) => void} [options.onEvent]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{steps: import('./agentSession').AgentStep[], summary: string, stopReason: string}>}
 */
async function run(options) {
  // The task arrives inside `context` as its highest-priority section, so the loop
  // does not prepend it separately. Doing both put it in the prompt twice.
  const { client, model, route: activeRoute, execute } = options;
  const emit = options.onEvent || (() => {});
  const budgets = activeRoute.budgets;

  /** @type {Array<Record<string, unknown>>} */
  const messages = [
    { role: 'system', content: activeRoute.systemPrompt },
    // The task is already the highest-priority section inside `context`.
    // Images are attached here, to the opening message, and never re-sent: the
    // conversation array grows across turns, so anything added here is already
    // carried forward without paying for the upload again.
    {
      role: 'user',
      content: options.context,
      ...(Array.isArray(options.images) && options.images.length > 0 ? { images: options.images } : {}),
    },
  ];

  /** @type {import('./agentSession').AgentStep[]} */
  const steps = [];
  /** @type {Map<string, number>} */
  const seen = new Map();

  let summary = '';
  let stopReason = 'budget';

  for (let stepIndex = 0; stepIndex < budgets.maxSteps; stepIndex += 1) {
    if (options.signal && options.signal.aborted) {
      stopReason = 'cancelled';
      break;
    }

    emit({ type: 'thinking', step: stepIndex + 1, maxSteps: budgets.maxSteps });

    /** @type {any} */
    let message;
    try {
      const response = await client.chat(
        {
          model,
          messages,
          tools: activeRoute.ollamaTools,
          // Passed through only where the model advertises support; harmless otherwise.
          // Explicit either way: hybrid reasoning models default to thinking, which
          // burns the budget before any tool call is emitted.
          think: Boolean(budgets.requestReasoning),
          options: { temperature: 0.2 },
        },
        { signal: options.signal }
      );
      message = response && response.message ? response.message : null;
    } catch (err) {
      const errorMessage = /** @type {Error} */ (err).message;
      logger.error(`Native tool turn failed: ${errorMessage}`);
      summary = `The model could not be reached: ${errorMessage}`;
      stopReason = 'error';
      break;
    }

    if (!message) {
      summary = 'The model returned an empty response.';
      stopReason = 'error';
      break;
    }

    const calls = parseToolCalls(message);

    if (calls.length === 0) {
      // No tools requested: the model is answering, which means it is done.
      summary = String(message.content || '').trim() || 'Finished.';
      stopReason = 'done';
      emit({ type: 'done', summary });
      break;
    }

    // Keep the assistant's tool-call message; the tool results below must follow it.
    messages.push(message);

    let stopped = false;
    for (const call of calls) {
      const key = callKey(call.name, call.args);
      const repeats = (seen.get(key) || 0) + 1;
      seen.set(key, repeats);

      if (repeats > REPEAT_LIMIT) {
        logger.warn(`Native loop repeated "${key}"; stopping.`);
        summary = `I kept calling ${call.name} the same way without progressing, so I stopped after ${steps.length} step(s).`;
        stopReason = 'repeating';
        stopped = true;
        break;
      }

      /** @type {import('../core/outputParser').ParsedAction} */
      const action = {
        action: call.name,
        path: typeof call.args.path === 'string' ? call.args.path : undefined,
        query: typeof call.args.query === 'string' ? call.args.query : undefined,
        code: typeof call.args.code === 'string' ? call.args.code : undefined,
        command: typeof call.args.command === 'string' ? call.args.command : undefined,
        // A native tool call carries no `thought` field the way a Tier B action
        // does, but models routinely narrate alongside their calls. Capturing that
        // text gives Tier A the same fallback Tier B has — without it, a rejected
        // translator phrase leaves the memory note bare, which is exactly what was
        // observed with gemma4:e2b: accurate notes with no description at all.
        thought: typeof message.content === 'string' && message.content.trim() ? message.content.trim() : undefined,
      };

      // Numbered by steps taken, not by turns: one Tier A turn can carry several
      // tool calls, and numbering them all by `stepIndex` made a model that read
      // three files in one turn report each of them as step 1.
      emit({ type: 'action', step: steps.length + 1, action });
      const result = await execute(action);
      steps.push({ action, result });
      emit({ type: 'observation', step: steps.length, action, result });

      messages.push({
        role: 'tool',
        // Ollama matches results to calls by name when no id is supplied.
        ...(call.id ? { tool_call_id: call.id } : {}),
        name: call.name,
        content: truncateToTokens(result.observation, 1500, { keep: 'both' }).text,
      });
    }

    if (stopped) break;
  }

  if (!summary) {
    summary =
      steps.length === 0
        ? 'I was not able to make any progress on this task.'
        : `I reached the step limit after ${steps.length} step(s) without finishing.`;
  }

  logger.info(`Native tool session ended: ${stopReason} after ${steps.length} step(s).`);
  return { steps, summary, stopReason };
}

module.exports = { run, callKey, REPEAT_LIMIT };
