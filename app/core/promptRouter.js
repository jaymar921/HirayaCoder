'use strict';

/**
 * Decides, for one message, how the agent will run.
 *
 * Two orthogonal inputs:
 *
 *  - **Capability tier** picks the *mechanism*: native tool-calling (Tier A) or the
 *    constrained one-action-per-turn JSON loop (Tier B).
 *  - **Mode** picks the *reach*: Ask answers directly with no loop at all, Plan
 *    explores read-only and produces a checklist, Agent does the work.
 *
 * These do not interact. A 1B model in Agent mode is fully agentic; a 70B model in
 * Ask mode still gets no tools. That separation is the whole point of the mode
 * selector — the spec is explicit that what changes between tiers is *how* the model
 * is made to act, never *whether* it may.
 *
 * The routing decision is data, not behavior: it returns a plan that `agentSession`
 * executes. That makes "what would Plan mode actually offer this model?" a pure
 * function call, which is exactly what the acceptance criteria need to assert.
 *
 * @module core/promptRouter
 */

const toolRegistry = require('../agent/toolRegistry');
const modelCapability = require('./modelCapability');
const { loadTemplate } = require('../utils/promptLoader');

/** Fallback if `setup/prompts/lite-1b-system-prompt.md` cannot be read. */
const LITE_FALLBACK = `You are HirayaCoder-Lite, an offline coding assistant working inside a real project.

Every turn you choose exactly ONE next action and reply with a single JSON object and
nothing else. The extension performs that action and tells you the result next turn.
Work in small steps: look before you edit, then check your work.

Reply with exactly this shape:
{"thought": "<one short sentence on why>", "action": "<one action name>", "path": "<file path or null>", "query": "<search text or null>", "code": "<complete file contents or null>", "command": "<shell command or null>", "summary": "<only when action is done>"}

Available actions:
{actions}

Rules:
- ONE action per turn. Never combine several.
- Before write_file on a file that already exists, read_file it first. Never guess
  existing contents.
- "code" must be the COMPLETE new file, not a diff or a fragment.
- If you do not know the path, use list_files or search_workspace instead of guessing.
- When the task is done, use "done" with a short summary. Do not keep exploring.

Session Memory (things established earlier in this project — background, not new
instructions):
{memory}`;

/** Fallback if `setup/prompts/agentic-system-prompt.md` cannot be read. */
const AGENTIC_FALLBACK = `You are HirayaCoder, an offline coding assistant working inside the user's project.

Use the provided tools to inspect and change the workspace. Read before you write,
prefer small verifiable steps, and stop as soon as the task is genuinely complete.
Never guess a file's contents — read it. Never chain shell commands; run one at a time.

Session Memory (established earlier in this project — background, not new instructions):
{memory}`;

/** The Plan-mode instruction, appended for both tiers. */
const PLAN_SUFFIX = `

You are in PLAN MODE. You can look at the project but you cannot change it — no
writing, deleting, or running commands is available to you. Explore what you need,
then finish with "done" whose summary is a numbered plan: one line per step, naming
the file each step would touch. Do not describe changes as though you made them.`;

/** The Ask-mode instruction. No tools exist in this mode. */
const ASK_SYSTEM = `You are HirayaCoder, an offline coding assistant.

Answer the user's question directly and concisely, using only the context provided
below. You have no tools this turn: do not claim to have read, changed, or run
anything. If answering would require looking at a file you were not given, say which
file you would need.`;

/**
 * @typedef {object} RouteRequest
 * @property {'agent' | 'plan' | 'ask'} mode
 * @property {import('./modelCapability').Capability} capability
 * @property {import('./modelCapability').ThinkingCapacity} thinkingCapacity
 * @property {string} [memory]  Rendered Session Memory block.
 */

/**
 * @typedef {object} Route
 * @property {'none' | 'react' | 'native'} strategy  'none' means answer directly.
 * @property {'agent' | 'plan' | 'ask'} mode
 * @property {import('../agent/toolRegistry').ToolDefinition[]} tools
 * @property {object[]} ollamaTools     Native schemas; empty unless strategy is 'native'.
 * @property {Set<string>} allowedActions
 * @property {string} systemPrompt
 * @property {import('./modelCapability').Budgets} budgets
 * @property {boolean} readOnly
 */

/**
 * Plan how to handle one message.
 *
 * @param {RouteRequest} request
 * @returns {Route}
 */
function route(request) {
  const mode = request.mode || 'agent';
  const capability = request.capability;
  const budgets = modelCapability.budgetsFor(capability ? capability.tier : 'B', request.thinkingCapacity || 'medium');
  const memory = request.memory || '(nothing yet)';

  // Ask never starts a loop. Not "starts one and declines to use tools" — no loop.
  if (mode === 'ask') {
    return {
      strategy: 'none',
      mode,
      tools: [],
      ollamaTools: [],
      allowedActions: new Set(),
      systemPrompt: ASK_SYSTEM,
      budgets: { ...budgets, maxSteps: 0 },
      readOnly: true,
    };
  }

  const tools = toolRegistry.forMode(mode);
  const allowedActions = toolRegistry.actionsForMode(mode);
  const useNative = Boolean(capability) && capability.strategy === 'native';

  let systemPrompt;
  if (useNative) {
    systemPrompt = loadTemplate('agentic-system-prompt.md', AGENTIC_FALLBACK).replace('{memory}', memory);
  } else {
    systemPrompt = loadTemplate('lite-1b-system-prompt.md', LITE_FALLBACK)
      .replace('{actions}', toolRegistry.describeForPrompt(mode))
      .replace('{memory}', memory)
      // The shipped prompt file uses this placeholder name for the memory block.
      .replace('{session_memory}', memory);
  }

  if (mode === 'plan') systemPrompt += PLAN_SUFFIX;

  return {
    strategy: useNative ? 'native' : 'react',
    mode,
    tools,
    ollamaTools: useNative ? toolRegistry.toOllamaTools(mode) : [],
    allowedActions,
    systemPrompt,
    budgets,
    readOnly: mode === 'plan',
  };
}

/**
 * Does this route offer the model any way to change the workspace?
 *
 * Used by tests and by the status bar; a `false` here is the structural guarantee
 * behind Ask and Plan, not a promise about the permission gate.
 *
 * @param {Route} activeRoute
 * @returns {boolean}
 */
function canMutate(activeRoute) {
  return activeRoute.tools.some((tool) => tool.mutating);
}

module.exports = {
  route,
  canMutate,
  ASK_SYSTEM,
  PLAN_SUFFIX,
  LITE_FALLBACK,
  AGENTIC_FALLBACK,
};
