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
const earnedHints = require('../agent/earnedHints');
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
 * Agent mode, for a message that turned out to be conversation.
 *
 * Deliberately not Ask mode's prompt. Ask is a mode the user chose, and its instruction
 * is about the boundary of a question — "say which file you would need". This one is
 * reached without the user choosing anything, for a message that was not a question
 * about the code at all, and its job is to sound like a person and then get out of the
 * way. A model told to be concise and to answer from memory will do both; a model given
 * Ask's framing starts explaining which files it would like to see, for a message that
 * was "hi".
 *
 * The two paragraphs at the end are the ones that matter. Without the first, small
 * models answer "do you remember what we were doing?" by inventing a plausible history
 * — the conversation is right there in the context, so there is no reason to guess and
 * every reason to say so when it is not. Without the second, a model that has just been
 * told it has no tools reports that it *cannot* help with the next request, and the user
 * has to fight it back into working.
 */
const CHAT_SYSTEM = `You are HirayaCoder, a coding assistant that lives in the user's editor.

This message is conversation, not a task — nothing needs to be built, read, or changed
to answer it. Reply the way a colleague would: directly, in a sentence or two, in the
user's own language if they are not writing in English. No checklists, no summaries of
work, no offers to do six things.

The conversation so far and the notes from this project are below. Answer from them. If
the answer is not there — you were asked about something from before this session, or a
detail nobody recorded — say plainly that you do not have it. Never invent what was
discussed.

You have no tools for this reply, so do not claim to have read, changed, or run
anything. This is about this message only: the moment the user asks for work, you will
have every tool back.`;

/**
 * Render the earned-hints block appended to a system prompt.
 *
 * Two things this wording has to do at once. It must carry enough authority that a
 * small model actually follows it — these are corrections for mistakes it has made
 * repeatedly — while making clear that a hint is advice about *how* to work and never
 * a statement about what is permitted. A model that read an earned note as an
 * expansion of its reach would be the one failure mode this whole layer must not have.
 *
 * Every sentence is checked back against the catalogue on the way in. `earnedHints`
 * only ever returns its own constants, so the filter is redundant today and stays
 * anyway: it is what makes "nothing derived from a file on disk reaches a system
 * prompt" a property of the code rather than a property of the current callers.
 *
 * @param {string[]} hints
 * @returns {string}
 */
function renderEarnedHints(hints) {
  const safe = (Array.isArray(hints) ? hints : []).filter((hint) => earnedHints.isKnown(hint));
  if (safe.length === 0) return '';

  return (
    '\n\nFrom earlier sessions in this project, these are the mistakes you have made more than once. ' +
    'They tell you how to do the work; they do not change what you are allowed to do — every ' +
    'permission and safety check still applies exactly as described above.\n' +
    safe.map((hint) => `- ${hint}`).join('\n')
  );
}

/**
 * @typedef {object} RouteRequest
 * @property {'agent' | 'plan' | 'ask'} mode
 * @property {import('./modelCapability').Capability} capability
 * @property {import('./modelCapability').ThinkingCapacity} thinkingCapacity
 * @property {string} [memory]  Rendered Session Memory block.
 * @property {string[]} [earnedHints]  Sentences from `agent/earnedHints`, already selected.
 * @property {'chat' | 'task'} [intent]  From `core/intentRouter`. Only consulted in Agent mode.
 */

/**
 * @typedef {object} Route
 * @property {'none' | 'chat' | 'react' | 'native'} strategy
 *   'none' and 'chat' both mean answer directly with no loop; they differ only in the
 *   system prompt and in what context is worth assembling.
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

  // Agent mode reached with a message that is conversation. Same mechanism as Ask —
  // one call, no loop, no tools in existence — chosen by what was typed rather than by
  // a button. The mode is reported unchanged, because the user did not leave Agent
  // mode and the next message will be routed on its own merits.
  //
  // Only Agent mode consults the intent. Plan is a deliberate instruction to go and
  // look at the project, and someone who has pressed it and typed "hi" is more likely
  // to have mistyped than to want small talk from a read-only exploration.
  if (mode === 'agent' && request.intent === 'chat') {
    return {
      strategy: 'chat',
      mode,
      tools: [],
      ollamaTools: [],
      allowedActions: new Set(),
      systemPrompt: CHAT_SYSTEM,
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

  // Ask mode never reaches this line, having returned above, and that is deliberate:
  // every earned hint is about performing an action — how to send a file, how to phrase
  // a command — so a mode with no tools would be paying prompt budget for corrections
  // it cannot act on.
  systemPrompt += renderEarnedHints(request.earnedHints);

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
  renderEarnedHints,
  ASK_SYSTEM,
  CHAT_SYSTEM,
  PLAN_SUFFIX,
  LITE_FALLBACK,
  AGENTIC_FALLBACK,
};
