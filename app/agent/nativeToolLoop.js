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

/** How many times a model is told its answer was a tool call before the loop gives up. */
const NARRATED_CALL_LIMIT = 2;

/**
 * Does this "answer" look like a tool call the model typed instead of calling?
 *
 * Observed on `llama3.2:latest`, which ended a session with `stopReason: done` and
 * this as its entire summary:
 *
 *   {"name": "edit_file", "parameters": {"file": "src/greet.js", "new_content": "…"}}
 *
 * No tool was called, so nothing was written, and the user was shown raw JSON as the
 * report of a task that never happened. `edit_file` is not even one of this project's
 * tools — the model invented a plausible name and wrote it out as prose.
 *
 * A reply with no tool calls normally means the model is finished, which is why this
 * has to be checked before that conclusion is drawn: the one case where it does not
 * mean finished is when the reply is itself an attempt to call something.
 *
 * @param {string} content
 * @returns {boolean}
 */
function looksLikeNarratedToolCall(content) {
  const text = String(content || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  if (!text.startsWith('{') || !text.endsWith('}')) return false;

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

  // The shapes models actually emit: Ollama's own call format, OpenAI's, and this
  // project's own Tier B action format.
  const named = typeof parsed.name === 'string' && (parsed.parameters || parsed.arguments);
  const wrapped = parsed.function && typeof parsed.function === 'object';
  const tierB = typeof parsed.action === 'string';
  return Boolean(named || wrapped || tierB);
}

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
  let narratedCalls = 0;

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
      const answer = String(message.content || '').trim();

      // A typed-out tool call is not an answer. Accepting it as one ends the session
      // reporting success for work that never happened, with JSON as the summary.
      if (looksLikeNarratedToolCall(answer)) {
        narratedCalls += 1;
        logger.warn(`Native loop got a tool call as text (${narratedCalls}/${NARRATED_CALL_LIMIT}).`);

        if (narratedCalls > NARRATED_CALL_LIMIT) {
          summary =
            'I wrote out tool calls as text instead of calling the tools, so nothing was actually ' +
            `changed. I stopped after ${steps.length} step(s).`;
          stopReason = 'narrated-tool-calls';
          break;
        }

        messages.push(message);
        messages.push({
          role: 'user',
          content:
            'That was a tool call written as text, so nothing ran. Use the tool-calling interface, ' +
            'and only the tools you were given — write_file, read_file, list_files, search_workspace, ' +
            'delete_file, create_folder, delete_folder, run_script, run_tests. To change a file, call ' +
            'write_file with "path" and the complete new contents in "code".',
        });
        continue;
      }

      // No tools requested: the model is answering, which means it is done.
      summary = answer || 'Finished.';
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
        // Only a real boolean counts — see the same rule in `outputParser.parseAction`.
        // A model that types "false" must not thereby authorise a recursive delete.
        recursive: call.args.recursive === true || call.args.recursive === 'true' ? true : undefined,
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

module.exports = { run, callKey, looksLikeNarratedToolCall, REPEAT_LIMIT, NARRATED_CALL_LIMIT };
