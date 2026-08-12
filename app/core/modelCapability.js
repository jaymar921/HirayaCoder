'use strict';

/**
 * Classifies the selected model into a capability tier and derives the budgets the
 * agent loop runs under.
 *
 * Pure logic — no `vscode`, no I/O — so the whole tier matrix is unit-testable.
 *
 * ## Why the tier rule is not "does it advertise tools?"
 *
 * `PROMPT.md` section 5 defines Tier A as any model advertising a tools capability.
 * In practice that rule misclassifies the extension's own flagship target: Ollama
 * reports `capabilities: ["completion", "tools"]` for `llama3.2:1b`. Taken literally,
 * the 1B model the lite ReAct loop exists for would be handed the native
 * tool-calling path, and `agent/reactLoop.js` would never run.
 *
 * Advertised tool support means the chat template can *emit* tool-call syntax, not
 * that the model reliably *orchestrates* multi-tool work. Sub-3B models routinely
 * emit malformed or hallucinated tool calls under real workloads, which is exactly
 * what the constrained one-action-per-turn JSON loop is designed to survive.
 *
 * So the effective rule is size AND capability:
 *
 *   Tier B  ⟸  parameter count ≤ `liteTierMaxParams` (default 3B)  OR  no tools capability
 *   Tier A  ⟸  everything else
 *
 * The threshold is a setting, and a per-model override exists, so either behavior
 * remains reachable without a code change.
 *
 * @module core/modelCapability
 */

/** @typedef {'A' | 'B'} Tier */
/** @typedef {'native' | 'react'} LoopStrategy */
/** @typedef {'low' | 'medium' | 'high'} ThinkingCapacity */

/**
 * @typedef {object} ModelInfo
 * @property {string} name
 * @property {number | null} params           Parameter count in billions, null if unknown.
 * @property {boolean} supportsTools
 * @property {boolean} [supportsThinking]     Ollama's `thinking` capability.
 * @property {number | null} [contextLength]
 */

/**
 * @typedef {object} CapabilityConfig
 * @property {number} [liteTierMaxParams]                 Default 3.
 * @property {Record<string, Tier>} [tierOverrides]       Per-model forced tier.
 * @property {number} [todoMinParams]                     Default 2; see DEFAULT_TODO_MIN_PARAMS.
 */

/**
 * @typedef {object} Capability
 * @property {string} model
 * @property {Tier} tier
 * @property {LoopStrategy} strategy
 * @property {string} label                   'Agentic' | 'Lite' — the dropdown badge.
 * @property {string} reason                  Human-readable justification, shown on hover.
 * @property {boolean} overridden             True when a user override decided the tier.
 * @property {number | null} params
 * @property {boolean} supportsTools
 * @property {boolean} supportsThinking
 * @property {boolean} canPlanTodos          May this model keep a multi-item TODO list?
 * @property {number | null} contextLength
 */

/**
 * @typedef {object} Budgets
 * @property {number} maxSteps
 * @property {number} memoryRecallEntries        `Infinity` means "all, up to the token budget".
 * @property {'none' | 'once' | 'periodic'} planning
 * @property {'session-end' | 'every-step'} translateFrequency
 * @property {boolean} requestReasoning          Pass Ollama's `think` parameter when supported.
 * @property {number} promptTokenTarget          Soft per-turn budget for contextBuilder.
 */

const DEFAULT_LITE_TIER_MAX_PARAMS = 3;

/**
 * Smallest model trusted to work through a TODO list.
 *
 * Keeping a list is gated on the model reporting Ollama's `thinking` capability —
 * that is the line the feature is specified around. Size is a second condition
 * rather than a substitute: `qwen3.5:0.8b` reports `thinking` and still cannot
 * finish a single-file edit, so handing it a three-item list would produce three
 * failures instead of one, more slowly. Both conditions must hold.
 */
const DEFAULT_TODO_MIN_PARAMS = 2;

/**
 * Step / memory / planning budgets per tier and thinking capacity.
 * Mirrors the matrix in `PROMPT.md` section 5.
 *
 * Note the deliberate asymmetry: on Tier B, raising Thinking Capacity buys *more
 * recalled memory and more frequent re-condensing*, not more steps. Small models
 * don't get better with a longer leash — they get better with a shorter, fresher
 * context. Tier B's step budget is 8 at both medium and high for that reason.
 *
 * @type {Record<Tier, Record<ThinkingCapacity, Budgets>>}
 */
const BUDGETS = {
  A: {
    low: {
      maxSteps: 8,
      memoryRecallEntries: 3,
      planning: 'none',
      translateFrequency: 'session-end',
      requestReasoning: false,
      promptTokenTarget: 6000,
    },
    medium: {
      maxSteps: 15,
      memoryRecallEntries: 8,
      planning: 'once',
      translateFrequency: 'session-end',
      requestReasoning: false,
      promptTokenTarget: 12000,
    },
    high: {
      maxSteps: 25,
      memoryRecallEntries: Infinity,
      planning: 'periodic',
      translateFrequency: 'session-end',
      requestReasoning: true,
      promptTokenTarget: 24000,
    },
  },
  // Tier B never runs the planning pass. Section 5's Tier B column asks only for
  // deeper memory recall and more frequent re-condensing as capacity rises — not
  // planning — and the reason holds up in practice: a planning call costs a full
  // extra inference on a model that takes seconds per turn, and a 1B model's plan
  // is rarely worth what it displaces from an already tiny context budget. The
  // planner remains available to this tier; it is simply off by default.
  B: {
    low: {
      maxSteps: 4,
      memoryRecallEntries: 1,
      planning: 'none',
      translateFrequency: 'session-end',
      requestReasoning: false,
      promptTokenTarget: 1200,
    },
    medium: {
      maxSteps: 8,
      memoryRecallEntries: 5,
      planning: 'none',
      translateFrequency: 'session-end',
      requestReasoning: false,
      promptTokenTarget: 1800,
    },
    high: {
      maxSteps: 8,
      memoryRecallEntries: Infinity,
      planning: 'none',
      translateFrequency: 'every-step',
      requestReasoning: false,
      promptTokenTarget: 2000,
    },
  },
};

/**
 * Parse Ollama's `parameter_size` string into billions of parameters.
 *
 * Handles the shapes Ollama actually emits: `"1.2B"`, `"3B"`, `"7.6B"`, `"137M"`,
 * and mixture-of-experts `"8x7B"` (reported as total, since total is what governs
 * memory pressure on a low-spec laptop).
 *
 * @param {string | number | null | undefined} raw
 * @returns {number | null} Billions of parameters, or null if unparseable.
 */
function parseParameterSize(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string') return null;

  const text = raw.trim().toUpperCase();
  const moe = text.match(/^(\d+)\s*X\s*([\d.]+)\s*([BM])$/);
  if (moe) {
    const experts = Number(moe[1]);
    const each = Number(moe[2]);
    const scale = moe[3] === 'M' ? 1 / 1000 : 1;
    return Number.isFinite(experts * each) ? experts * each * scale : null;
  }

  const simple = text.match(/^([\d.]+)\s*([BM])?$/);
  if (!simple) return null;
  const value = Number(simple[1]);
  if (!Number.isFinite(value)) return null;
  return simple[2] === 'M' ? value / 1000 : value;
}

/**
 * Classify a model into a tier.
 *
 * @param {ModelInfo} model
 * @param {CapabilityConfig} [config]
 * @returns {Capability}
 */
function classify(model, config = {}) {
  const threshold =
    typeof config.liteTierMaxParams === 'number' ? config.liteTierMaxParams : DEFAULT_LITE_TIER_MAX_PARAMS;
  const overrides = config.tierOverrides || {};

  const params = typeof model.params === 'number' && Number.isFinite(model.params) ? model.params : null;
  const supportsTools = Boolean(model.supportsTools);
  const todoMinParams =
    typeof config.todoMinParams === 'number' ? config.todoMinParams : DEFAULT_TODO_MIN_PARAMS;
  // Unknown size is treated as too small: a model that cannot be measured is not
  // given a multi-item plan to hold on to.
  const canPlanTodos = Boolean(model.supportsThinking) && params !== null && params >= todoMinParams;

  const override = overrides[model.name];
  if (override === 'A' || override === 'B') {
    return finalize(model, override, `Tier forced to ${override} by your settings.`, true, params, supportsTools, canPlanTodos);
  }

  if (!supportsTools) {
    return finalize(
      model,
      'B',
      'No native tool-calling support reported — running the constrained JSON action loop.',
      false,
      params,
      supportsTools,
      canPlanTodos
    );
  }

  if (params === null) {
    // Unknown size with tool support: trust the capability, but say so, since an
    // unknown-size model is more likely to be exotic than to be tiny.
    return finalize(
      model,
      'A',
      'Reports native tool-calling; parameter size unknown, so size-based demotion was skipped.',
      false,
      params,
      supportsTools,
      canPlanTodos
    );
  }

  if (threshold > 0 && params <= threshold) {
    return finalize(
      model,
      'B',
      `Reports native tool-calling, but at ${formatParams(params)} it is at or below the ${formatParams(
        threshold
      )} lite threshold — small models emit tool-call syntax far more reliably than they orchestrate it, so the constrained loop is used instead.`,
      false,
      params,
      supportsTools,
      canPlanTodos
    );
  }

  return finalize(
    model,
    'A',
    `Native tool-calling at ${formatParams(params)} — running the full multi-tool agent loop.`,
    false,
    params,
    supportsTools,
    canPlanTodos
  );
}

/**
 * @param {ModelInfo} model
 * @param {Tier} tier
 * @param {string} reason
 * @param {boolean} overridden
 * @param {number | null} params
 * @param {boolean} supportsTools
 * @returns {Capability}
 */
function finalize(model, tier, reason, overridden, params, supportsTools, canPlanTodos) {
  return {
    model: model.name,
    tier,
    strategy: tier === 'A' ? 'native' : 'react',
    label: tier === 'A' ? 'Agentic' : 'Lite',
    reason,
    overridden,
    params,
    supportsTools,
    supportsThinking: Boolean(model.supportsThinking),
    canPlanTodos: Boolean(canPlanTodos),
    contextLength: typeof model.contextLength === 'number' ? model.contextLength : null,
  };
}

/**
 * Map view of BUDGETS. Both keys originate in user settings, so a plain object
 * lookup would resolve `'constructor'` to a prototype member and hand the agent
 * loop a non-budget. A Map has no prototype chain to walk into.
 *
 * @type {Map<string, Map<string, Budgets>>}
 */
const BUDGET_INDEX = new Map(
  Object.entries(BUDGETS).map(([tier, byCapacity]) => [tier, new Map(Object.entries(byCapacity))])
);

/**
 * Budgets for a tier at a given thinking capacity. Unrecognized values fall back
 * to Tier B / medium — the conservative end of both axes.
 *
 * @param {Tier} tier
 * @param {ThinkingCapacity} thinkingCapacity
 * @returns {Budgets}
 */
function budgetsFor(tier, thinkingCapacity) {
  const byTier = BUDGET_INDEX.get(tier) || /** @type {Map<string, Budgets>} */ (BUDGET_INDEX.get('B'));
  return byTier.get(thinkingCapacity) || /** @type {Budgets} */ (byTier.get('medium'));
}

/**
 * @param {number} params Billions.
 * @returns {string}
 */
function formatParams(params) {
  if (params < 1) return `${Math.round(params * 1000)}M`;
  return `${Number(params.toFixed(1))}B`;
}

module.exports = {
  classify,
  budgetsFor,
  parseParameterSize,
  formatParams,
  BUDGETS,
  DEFAULT_LITE_TIER_MAX_PARAMS,
};
