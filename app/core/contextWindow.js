'use strict';

/**
 * How many tokens Ollama holds for a model, chosen by the extension instead of left to
 * the server's default.
 *
 * ## Why this exists
 *
 * Until 1.2.0 no request set `num_ctx`, so every prompt ran in whatever window the
 * server picked. On any machine with less than 24 GiB of VRAM that is 4,096 tokens, and
 * what Ollama does with a prompt that does not fit is drop the *front* of it, silently.
 * Measured on machine B (Ollama 0.40, GTX 1650 Super):
 *
 * | Request | Prompt sent | Prompt evaluated | Result |
 * |---|---|---|---|
 * | `llama3.2:1b`, no `num_ctx` | 12,648 tokens | 2,050 | the instruction at the top was gone |
 * | `qwen3.5:0.8b`, no `num_ctx` | 3,959 tokens | 2,050 | lost the first 31 of 60 requirements |
 *
 * And output shares the same window: the second request asked for up to 4,096 tokens of
 * file and got 2,046, `done_reason: "length"`, prompt plus output exactly 4,096. That is
 * the "cut off before the code block ended" which 0.9.0 attributed to `num_predict`.
 *
 * The extension's own budgets assumed far more room than that. Tier A at Medium plans a
 * 12,000-token prompt; the server kept the newest 2,000 or so, which on a native tool
 * loop is the latest tool results and not the task.
 *
 * ## The rules
 *
 *  - **One window per model, for the whole session.** Ollama reloads a model whenever a
 *    request asks for a different `num_ctx`, and a reload costs 7 to 10 seconds even for
 *    a 1B model on a GPU. So the window is sized for the largest prompt the model's tier
 *    can send at *any* thinking capacity, and the client stamps it on every request for
 *    that model, including the translator and inline completion.
 *  - **Fit the prompt to the window, never the other way round.** When the window is
 *    smaller than the tier would like (a setting, or a model trained on less), the
 *    prompt budget shrinks so the extension trims by priority instead of Ollama
 *    trimming from the top.
 *  - **Bounded by default.** A bigger window costs memory for the KV cache, and the
 *    machines this is built for have 4 GB of VRAM or none. Auto stops at 16,384; the
 *    setting goes higher for anyone who has the memory.
 *
 * Pure logic, no I/O.
 *
 * @module core/contextWindow
 */

/** Window sizes worth asking for. Powers of two, so a model is not reloaded over a few tokens. */
const BUCKETS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];

/** Smallest window anyone may configure. Below this nothing useful fits. */
const MIN_WINDOW = 2048;

/** Auto never asks for more than this. Larger is a deliberate choice in settings. */
const AUTO_MAX = 16384;

/**
 * Room kept free for the reply. A dictated file asks for up to 4,096 tokens, and a reply
 * cut short by the window is a truncated file.
 */
const OUTPUT_RESERVE = 4096;

/**
 * What a turn's prompt really costs, as a multiple of `promptTokenTarget`.
 *
 * The target budgets the context block only. A Tier B turn then adds the system prompt,
 * the action list, the memory block, the step trace (up to 20% of the target) and the
 * last observation (up to 45%), so a full turn lands near twice the target. Sizing the
 * window on the target alone would rebuild the bug this module fixes.
 */
const PROMPT_OVERHEAD = 2;

/**
 * @typedef {object} WindowPlan
 * @property {number} numCtx          What every request for this model asks Ollama for.
 * @property {number} wanted          What the tier would use with no limits.
 * @property {'auto' | 'setting'} source
 * @property {boolean} limited        True when the window is below what the tier wanted.
 * @property {string} reason          One sentence for the log and the tier tooltip.
 */

/**
 * @param {number} tokens
 * @returns {number} The smallest bucket that holds `tokens`, or the largest bucket.
 */
function bucketFor(tokens) {
  return BUCKETS.find((size) => size >= tokens) || BUCKETS[BUCKETS.length - 1];
}

/**
 * Format a token count the way the panel shows it: 8192 becomes "8k".
 *
 * @param {number} tokens
 * @returns {string}
 */
function formatTokens(tokens) {
  const value = Number(tokens) || 0;
  if (value < 1000) return String(value);
  const thousands = value / 1024;
  return `${thousands >= 10 || Number.isInteger(thousands) ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

/**
 * Choose the window for a model.
 *
 * @param {object} options
 * @param {number} options.largestPromptTarget  The biggest `promptTokenTarget` the tier
 *   uses at any thinking capacity.
 * @param {number | null} [options.modelMax]     The model's trained context length, when known.
 * @param {number} [options.configured]          `hirayacoder.ollama.contextLength`; 0 means auto.
 * @returns {WindowPlan}
 */
function plan(options) {
  const target = Math.max(0, Number(options.largestPromptTarget) || 0);
  const wanted = target * PROMPT_OVERHEAD + OUTPUT_RESERVE;
  const modelMax =
    typeof options.modelMax === 'number' && Number.isFinite(options.modelMax) && options.modelMax > 0
      ? options.modelMax
      : null;
  const configured = Number(options.configured) || 0;

  if (configured > 0) {
    let numCtx = Math.max(MIN_WINDOW, Math.floor(configured));
    if (modelMax !== null && numCtx > modelMax) numCtx = Math.max(MIN_WINDOW, modelMax);
    return {
      numCtx,
      wanted,
      source: 'setting',
      limited: numCtx < wanted,
      reason:
        numCtx < wanted
          ? `${formatTokens(numCtx)} context from your settings, below the ${formatTokens(bucketFor(wanted))} this tier ` +
            'would use, so prompts are trimmed to fit.'
          : `${formatTokens(numCtx)} context from your settings.`,
    };
  }

  let numCtx = Math.min(bucketFor(wanted), AUTO_MAX);
  if (modelMax !== null && numCtx > modelMax) numCtx = Math.max(MIN_WINDOW, modelMax);
  const limited = numCtx < wanted;
  return {
    numCtx,
    wanted,
    source: 'auto',
    limited,
    reason: limited
      ? `${formatTokens(numCtx)} context, the most auto mode asks for. Prompts are trimmed to fit; raise ` +
        'hirayacoder.ollama.contextLength if this machine has memory to spare.'
      : `${formatTokens(numCtx)} context, enough for this tier's largest prompt plus a full file of output.`,
  };
}

/**
 * The largest prompt budget a set of capacity budgets would ever send.
 *
 * @param {Iterable<{promptTokenTarget: number}>} budgets
 * @returns {number}
 */
function largestTarget(budgets) {
  let largest = 0;
  for (const entry of budgets) largest = Math.max(largest, Number(entry.promptTokenTarget) || 0);
  return largest;
}

/**
 * The prompt budget that fits a window, given the overhead and the output reserve.
 *
 * The reserve gives way first on a small window: on 4,096 tokens, holding 4,096 back for
 * output would leave no prompt at all, so it shrinks to half the window.
 *
 * @param {number} numCtx
 * @returns {number}
 */
function promptBudgetFor(numCtx) {
  const window = Math.max(MIN_WINDOW, Number(numCtx) || MIN_WINDOW);
  const reserve = Math.min(OUTPUT_RESERVE, Math.floor(window / 2));
  return Math.floor((window - reserve) / PROMPT_OVERHEAD);
}

/**
 * Shrink a budget's prompt target to fit a window. Never grows it.
 *
 * @template {{promptTokenTarget: number}} B
 * @param {B} budgets
 * @param {number | null | undefined} numCtx
 * @returns {B}
 */
function fit(budgets, numCtx) {
  if (!budgets || !numCtx) return budgets;
  const ceiling = promptBudgetFor(numCtx);
  if (budgets.promptTokenTarget <= ceiling) return budgets;
  return { ...budgets, promptTokenTarget: ceiling };
}

module.exports = {
  plan,
  fit,
  largestTarget,
  promptBudgetFor,
  bucketFor,
  formatTokens,
  BUCKETS,
  AUTO_MAX,
  MIN_WINDOW,
  OUTPUT_RESERVE,
  PROMPT_OVERHEAD,
};
