'use strict';

/**
 * Tier B: the constrained one-action-per-turn loop.
 *
 * The model never calls a tool. It emits a single JSON object describing the one
 * thing it wants to do next; the extension performs that action deterministically
 * and feeds the result back as the next turn's input. Repeat until `done` or the
 * step budget runs out.
 *
 * ## Why the conversation is rebuilt every turn
 *
 * The obvious implementation appends each turn to a growing message array. On a 1B
 * model with a ~2000-token working budget that fails within four steps: the history
 * crowds out the system prompt, the model forgets the JSON contract, and the session
 * collapses into prose. So each turn is assembled fresh — system prompt, session
 * memory, the task, a compact trace of what has already been done, and the latest
 * observation in full. The trace is what makes it a conversation; rebuilding is what
 * keeps it inside the window.
 *
 * ## Repetition
 *
 * The characteristic small-model failure is not producing garbage, it is producing
 * the *same correct-looking action forever* — reading one file six times in a row.
 * A budget alone does not fix that; it just wastes eight steps instead of four. So
 * repeats are detected and answered with an escalating nudge, then a stop.
 *
 * @module agent/reactLoop
 */

const logger = require('../utils/logger');
const { parseAction, actionSchema } = require('../core/outputParser');
const { truncateToTokens } = require('../utils/tokenBudget');

/** How many identical actions before the loop intervenes. */
const REPEAT_LIMIT = 2;

/** How many consecutive unparseable turns before giving up. */
const PARSE_FAILURE_LIMIT = 3;

/**
 * Refusals that mean "right action, wrong payload".
 *
 * Every other failure — a path outside the workspace, a file that does not exist, a
 * denied permission — means the action itself was misdirected, and repeating it is
 * how a small model burns its whole budget. These are the exception: the target was
 * correct and only the content was rejected, so the model *should* try the same
 * action on the same path again with a corrected payload.
 */
const RETRYABLE_ERRORS = new Set([
  'SUSPICIOUS_TRUNCATION',
  'FULLY_COMMENTED',
  'MISSING_CONTENT',
  'ECHOED_OBSERVATION',
  // `delete_folder` refuses a non-empty folder and asks for the same call back with
  // `recursive: true`. That is the tool naming the one thing that would work, so it
  // belongs with the content refusals rather than with the misdirected actions.
  'FOLDER_NOT_EMPTY',
]);

/** How many corrected retries a single action/path is forgiven before the repeat guard applies. */
const RETRY_FORGIVENESS_LIMIT = 2;

/** Shortest extension-authored sentence worth checking for in file content. */
const MIN_NOTICE_LENGTH = 20;

/**
 * Has the model pasted one of the extension's own status messages into a file?
 *
 * The loop feeds each result back as the next turn's input, and a small model does
 * not reliably separate "this is what happened" from "this is the text I am writing".
 * Observed on `llama3.2:1b`, which wrote this to disk:
 *
 *     function greet(name) { if (!name) return 'Hello there'; return name; }
 *     Updated src/greet.js (+1 / -6 lines).
 *
 * That trailing sentence is the extension's own words from the previous turn.
 *
 * The comparison is against strings the extension generated, never against anything
 * the model produced, so a match is a fact rather than a judgement about content.
 * Successful reads are excluded when notices are collected — their observation *is*
 * file content, which the next write is supposed to contain.
 *
 * @param {string} code
 * @param {Set<string>} notices
 * @returns {string | null} The echoed sentence, or null.
 */
function echoedNotice(code, notices) {
  for (const notice of notices) {
    if (code.includes(notice)) return notice;
  }
  return null;
}

/**
 * Render the steps so far as a compact trace.
 *
 * Deliberately lossy: one line per step. The model needs to know *what it has
 * already tried* so it does not retry it, which takes far fewer tokens than
 * replaying the full observations.
 *
 * @param {import('./agentSession').AgentStep[]} steps
 * @param {number} budget
 * @returns {string}
 */
function renderTrace(steps, budget) {
  if (steps.length === 0) return '';

  const lines = steps.map((step, index) => {
    const target = step.action.path || step.action.command || step.action.query || '';
    const outcome = step.result && step.result.ok ? 'ok' : 'failed';
    return `${index + 1}. ${step.action.action} ${target} → ${outcome}`;
  });

  // The most recent steps matter most, so trim from the front.
  return truncateToTokens(`Steps you have already taken:\n${lines.join('\n')}`, budget, { keep: 'tail' }).text;
}

/**
 * A stable key for detecting a repeated action.
 *
 * @param {import('../core/outputParser').ParsedAction} action
 * @returns {string}
 */
function actionKey(action) {
  return [action.action, action.path || '', action.query || '', action.command || ''].join('|');
}

/**
 * The line appended to the next turn telling the model where it stands.
 *
 * This is the scaffolding that makes a 1B model finish a task instead of orbiting
 * one. Observed live on `llama3.2:1b`: asked to change a function, it read the file
 * correctly and then read it again, and again, until the repeat guard stopped it —
 * it never made the leap from "I have the contents" to "so now I edit it". The
 * extension knows a read just succeeded and which tools exist, so it can say so
 * plainly. A stronger model ignores the hint; a weak one needs it.
 *
 * @param {import('../core/outputParser').ParsedAction} action
 * @param {import('../agent/toolRegistry').ToolResult} result
 * @param {number} repeats
 * @param {import('../core/promptRouter').Route} activeRoute
 * @returns {string}
 */
function nextStepHint(action, result, repeats, activeRoute) {
  // A content refusal is the one failure the model should answer by trying again.
  // The tool has already explained exactly what was wrong with the payload, and that
  // explanation is in the observation directly above this hint — so the only job here
  // is to not contradict it. Observed on `qwen3.5:0.8b`: `write_file` was refused for
  // commenting out the whole file and told the model to resend it with live code,
  // while this function simultaneously told it never to write that path again. It
  // obeyed the loop, went back to read_file, and the session ended having done
  // nothing.
  // The folder case is a retryable refusal with a different remedy: nothing is wrong
  // with the payload, a flag is missing. Sending it through the "corrected content"
  // wording below would ask a small model to fix something that is not broken.
  if (!result.ok && result.error === 'FOLDER_NOT_EMPTY') {
    return (
      `${action.path || 'That folder'} still exists — it is not empty, so it was left alone. ` +
      'If you meant to remove it and everything inside it, send delete_folder for the same path with ' +
      '"recursive": true. If you only wanted particular files gone, use delete_file on each of them.'
    );
  }

  if (!result.ok && RETRYABLE_ERRORS.has(result.error)) {
    return (
      `${action.path || 'The file'} was NOT changed — the content you sent was rejected for the reason above. ` +
      `Send ${action.action} for the same path again with corrected content. Do not read the file again; ` +
      'you already have it.'
    );
  }

  // A refusal by the user is not an obstacle to be worked around.
  //
  // Observed on `qwen3.5:2b`: its delete was declined, so it retried the delete,
  // then reached for `run_script rm -rf src/obsolete.js`. The allow-list stopped
  // that, but the model was not *told* anything to stop it trying — the generic
  // "use a different action" hint reads as encouragement to find another route.
  // A declined action is a decision, and the only correct next move is to leave it
  // alone and carry on with the rest of the work.
  if (!result.ok && result.error === 'USER_DENIED') {
    return (
      `You asked to ${action.action}${action.path ? ` ${action.path}` : ''} and the user said no. ` +
      'That is their decision — do NOT try it again, and do NOT try to achieve the same thing ' +
      'another way (no shell commands, no rewriting the file to be empty). ' +
      'Move on to the rest of the task, or finish with "done" and say that this part was declined.'
    );
  }

  // Every other failure with no alternative offered gets retried verbatim until the
  // budget is gone, so correct it immediately rather than waiting for a repeat.
  if (!result.ok) {
    return (
      `That did not work. Do NOT try ${action.action}${action.path ? ` on "${action.path}"` : ''} again — ` +
      'use a different path or a different action, or finish with "done".'
    );
  }

  if (repeats > 1) {
    return (
      `You have already done ${action.action}${action.path ? ` on ${action.path}` : ''} and have the result above. ` +
      'Do NOT do it again. Take the next step, or finish with "done".'
    );
  }

  if (action.action === 'read_file' && action.path) {
    const canWrite = activeRoute.allowedActions.has('write_file');
    return canWrite
      ? `You now have the full contents of ${action.path}. If that is enough to do the task, make the change now with write_file — send the complete updated file in "code". Do not read it again.`
      : `You now have the full contents of ${action.path}. Do not read it again — look at another file or finish with "done" and give your plan.`;
  }

  if (action.action === 'list_files' || action.action === 'search_workspace') {
    return 'You now know what is in the project. Open the file you need with read_file.';
  }

  // Without this, a successful write left the model with no guidance at all, and it
  // fell back to the only thing it was sure about: reading the file again. Seen on
  // `qwen3.5:0.8b`, which wrote the file correctly and then re-read it until the
  // repeat guard ended the session — turning a finished task into a "repeating" stop
  // with no summary of what it had accomplished.
  if (action.action === 'write_file' && action.path) {
    return (
      `${action.path} is saved. Do NOT read or write it again. ` +
      'If every part of the task is now complete, reply with the "done" action and summarise what you changed. ' +
      'If part of the task is still outstanding, do that part next.'
    );
  }

  if (action.action === 'delete_file' && action.path) {
    return (
      `${action.path} is dealt with. If the whole task is complete, reply with "done" and summarise what you changed.`
    );
  }

  return '';
}

/**
 * Turn a parse error into an instruction the model can act on.
 *
 * The generic "your last reply could not be used" restates that something is wrong
 * without saying what to do differently, and a small model answers it by repeating
 * the same malformed reply. The parser already knows precisely what was missing, so
 * that knowledge is passed through as a correction rather than a complaint.
 *
 * @param {string | undefined} error The `error` from parseAction.
 * @returns {string}
 */
function recoveryHint(error) {
  const text = String(error || '');

  // The dominant Tier B failure: the model announces a write but sends no content.
  // Seen on `qwen3.5:0.8b` and `qwen3.5:2b`.
  if (/missing:.*\bcode\b/.test(text)) {
    return (
      'Your last reply asked to write a file but contained no "code" field. ' +
      'Send the action again with "code" set to the COMPLETE new contents of the file — ' +
      'every line, not just the part you changed, and not a description of the change.'
    );
  }
  if (/missing:.*\bpath\b/.test(text)) {
    return (
      'Your last reply had no "path" field. Send it again with "path" set to the file, ' +
      'relative to the project root, like "src/app.js".'
    );
  }
  if (/missing:/.test(text)) return `Your last reply was incomplete — ${text}`;
  if (/empty response|did not return a JSON object/.test(text)) {
    return 'Your last reply contained no JSON at all.';
  }
  if (/unknown action|not available in this mode/.test(text)) {
    return `${text} Choose one of the actions listed above instead.`;
  }
  return `Your last reply could not be used (${text}).`;
}

/**
 * Run a Tier B session.
 *
 * @param {object} options
 * @param {import('../core/ollamaClient').OllamaClient} options.client
 * @param {string} options.model
 * @param {import('../core/promptRouter').Route} options.route
 * @param {string} options.task
 * @param {string} options.context           Prebuilt context block from contextBuilder.
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
  const images = Array.isArray(options.images) ? options.images : [];

  /** @type {import('./agentSession').AgentStep[]} */
  const steps = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** Corrected retries already forgiven, per action key. */
  const forgiveness = new Map();
  /** Status sentences this loop has shown the model, for the echo check below. */
  /** @type {Set<string>} */
  const notices = new Set();

  let observation = '';
  let summary = '';
  let stopReason = 'budget';
  let parseFailures = 0;
  // Two independent nudges. `hint` is about the task ("you have the file, now edit
  // it") and survives a bad reply; `parseNudge` is about the last reply's shape and
  // is cleared as soon as one parses. Folding them into one variable meant a parse
  // failure silently erased the task guidance a small model most depends on.
  let hint = '';
  let parseNudge = '';

  // Constrains decoding to the shape of one valid action. Bare `format: 'json'` only
  // guarantees valid JSON, which is how a 0.8B model can spend an entire session
  // emitting well-formed objects that are missing the one field that matters.
  // Dropped back to plain JSON mode if this Ollama build will not take a schema.
  let format = /** @type {object | string} */ (actionSchema(activeRoute.allowedActions));

  /**
   * Send a turn, degrading to plain JSON mode if the schema is rejected.
   *
   * Schema-constrained decoding is a server-side feature, and this extension is
   * pointed at whatever Ollama the user already has. A build that rejects the schema
   * should cost the user shape-guarantees, not the whole session — the parser has
   * validated unconstrained output since before this existed.
   *
   * @param {object} body
   * @returns {Promise<any>}
   */
  async function requestAction(body) {
    try {
      return await client.chat(body, { signal: options.signal });
    } catch (err) {
      const message = /** @type {Error} */ (err).message || '';
      const schemaRejected = typeof format !== 'string' && /format|schema|grammar/i.test(message);
      if (!schemaRejected) throw err;

      logger.warn(`This Ollama build rejected the action schema (${message}); falling back to plain JSON mode.`);
      format = 'json';
      return client.chat({ ...body, format }, { signal: options.signal });
    }
  }

  for (let stepIndex = 0; stepIndex < budgets.maxSteps; stepIndex += 1) {
    if (options.signal && options.signal.aborted) {
      stopReason = 'cancelled';
      break;
    }

    // Rebuilt from scratch each turn — see the module comment.
    const traceBudget = Math.max(80, Math.floor(budgets.promptTokenTarget * 0.2));
    const sections = [
      options.context,
      renderTrace(steps, traceBudget),
      observation ? `Result of your last action:\n${observation}` : '',
      hint,
      parseNudge,
      'Reply with one JSON action now.',
    ].filter(Boolean);

    const userContent = sections.join('\n\n');

    emit({ type: 'thinking', step: stepIndex + 1, maxSteps: budgets.maxSteps });

    /** @type {string} */
    let raw;
    try {
      const response = await requestAction({
        model,
        messages: [
          { role: 'system', content: activeRoute.systemPrompt },
          // The task is already the highest-priority section inside `context`.
          // Images ride along on the first turn only — see `AgentSession.images`.
          {
            role: 'user',
            content: userContent,
            ...(stepIndex === 0 && images.length > 0 ? { images } : {}),
          },
        ],
        // A JSON Schema, so decoding is constrained to the shape of one valid
        // action. The parser still validates — a grammar cannot stop a model from
        // putting a description where file content belongs.
        format,
        // Hybrid reasoning models think by default, and the trace consumes the
        // entire token budget before any answer is produced. Measured on
        // `qwen3.5:2b`: 3,659 characters of thinking, empty content,
        // `done_reason: "length"`, 94 seconds. With thinking off: 2.3 seconds and
        // a usable reply. This loop wants one JSON action, not a monologue.
        think: false,
        options: {
          temperature: 0.1,
          num_predict: 800,
        },
      });
      const message = response && response.message ? response.message : null;
      raw = message ? message.content : '';

      // A reasoning model that ignored `think: false` and spent its whole budget
      // thinking returns empty content. Say so plainly — otherwise this surfaces as
      // a generic "did not return a JSON object" and the real cause stays hidden.
      if (!String(raw || '').trim() && message && message.thinking) {
        logger.warn(
          `${model} returned only a reasoning trace (${String(message.thinking).length} chars) and no answer.`
        );
        raw = '';
      }
    } catch (err) {
      const message = /** @type {Error} */ (err).message;
      logger.error(`ReAct turn failed: ${message}`);
      summary = `The model could not be reached: ${message}`;
      stopReason = 'error';
      break;
    }

    const parsed = parseAction(raw, { allowedActions: activeRoute.allowedActions });

    if (!parsed.ok) {
      parseFailures += 1;
      emit({ type: 'parse-error', error: parsed.error, raw: parsed.raw });

      if (parseFailures >= PARSE_FAILURE_LIMIT) {
        // Never "repair" and run a guessed action — end with the raw text shown.
        summary = parsed.action.summary || 'The model stopped producing usable actions.';
        stopReason = 'unparseable';
        break;
      }
      // Restate the contract once; small models often recover from a single nudge.
      // The observation is deliberately NOT cleared: a malformed reply is a fact
      // about the model's output, not about the world. Observed on `qwen3.5:0.8b` —
      // it read a file, emitted `write_file` with no `code`, and the next turn
      // arrived with the file contents gone, so it read the same file again and the
      // repeat guard ended the session. What it needed was the contents it already
      // had, plus a note on what was wrong with the reply.
      parseNudge = `${recoveryHint(parsed.error)} Reply with ONLY a JSON object containing "action".`;
      continue;
    }

    parseFailures = 0;
    parseNudge = '';
    const action = parsed.action;

    if (action.action === 'done') {
      summary = action.summary || 'Finished.';
      stopReason = 'done';
      emit({ type: 'done', summary, thought: action.thought });
      break;
    }

    // Repetition guard.
    const key = actionKey(action);
    const repeats = (seen.get(key) || 0) + 1;
    seen.set(key, repeats);

    if (repeats > REPEAT_LIMIT) {
      logger.warn(`ReAct loop repeated "${key}" ${repeats} times; stopping.`);
      // Careful not to overclaim failure: the loop can repeat itself *after* doing
      // real work, and reporting "without making progress" over a session that
      // edited a file tells the user something untrue about their workspace.
      const done = steps.filter((step) => step.result && step.result.ok);
      summary =
        `I stopped because I kept repeating the same step (${action.action}${action.path ? ` on ${action.path}` : ''}). ` +
        (done.length > 0
          ? `Before that I completed ${done.length} step(s) — check the changes above before relying on them.`
          : 'Nothing was changed.');
      stopReason = 'repeating';
      break;
    }

    // Numbered by steps actually taken, not by turns consumed. `stepIndex` counts
    // unparseable turns too, so a single bad reply used to make the next step
    // announce itself as "3." when it was the second thing the agent had done.
    emit({ type: 'action', step: steps.length + 1, action });

    // Checked before the write reaches the gate: the contaminated content must never
    // become a pending change the user could approve.
    const echoed = action.action === 'write_file' && action.code ? echoedNotice(action.code, notices) : null;

    const result = echoed
      ? {
          ok: false,
          observation:
            `Refused: the content you sent for ${action.path} contains "${echoed}" — that is a status ` +
            'message from this session, not part of the file. Send only the file\'s own code in "code".',
          error: 'ECHOED_OBSERVATION',
        }
      : await execute(action);
    steps.push({ action, result });
    emit({ type: 'observation', step: steps.length, action, result });

    // A refused write changed nothing, so the corrected retry the hint just asked
    // for is not the model going in circles — it is the model doing as it was told.
    // Charging it against the repeat budget would make the two guards cancel out.
    // Forgiveness is capped, so a model that cannot produce valid content still
    // stops instead of rewriting the same broken file forever.
    if (!result.ok && RETRYABLE_ERRORS.has(result.error)) {
      const forgiven = (forgiveness.get(key) || 0) + 1;
      if (forgiven <= RETRY_FORGIVENESS_LIMIT) {
        forgiveness.set(key, forgiven);
        seen.set(key, repeats - 1);
      }
    }

    hint = nextStepHint(action, result, repeats, activeRoute);

    // A successful read's observation is file content — the very thing the next write
    // is meant to reproduce — so it is never treated as a status sentence. Everything
    // else the model sees here is the extension talking.
    if (!(action.action === 'read_file' && result.ok)) {
      const firstLine = String(result.observation || '').split('\n')[0].trim();
      if (firstLine.length >= MIN_NOTICE_LENGTH) notices.add(firstLine);
    }

    observation = truncateToTokens(result.observation, Math.floor(budgets.promptTokenTarget * 0.45), {
      keep: 'both',
    }).text;
  }

  if (!summary) {
    summary =
      steps.length === 0
        ? 'I was not able to make any progress on this task.'
        : `I reached the step limit after ${steps.length} step(s) without finishing.`;
  }

  logger.info(`ReAct session ended: ${stopReason} after ${steps.length} step(s).`);
  return { steps, summary, stopReason };
}

module.exports = {
  run,
  renderTrace,
  actionKey,
  nextStepHint,
  recoveryHint,
  echoedNotice,
  REPEAT_LIMIT,
  PARSE_FAILURE_LIMIT,
  RETRYABLE_ERRORS,
  RETRY_FORGIVENESS_LIMIT,
};
