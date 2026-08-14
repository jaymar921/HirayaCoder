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
const environmentProfile = require('./environmentProfile');
const productInfo = require('../utils/productInfo');
const { loadTemplate } = require('../utils/promptLoader');

/** Fallback if `setup/prompts/lite-1b-system-prompt.md` cannot be read. */
const LITE_FALLBACK = `You are HirayaCoder-Lite, an offline coding assistant working inside a real project.

Every turn you choose exactly ONE next action and reply with a single JSON object and
nothing else. The extension performs that action and tells you the result next turn.
Work in small steps: look before you edit, then check your work.

Reply with exactly this shape:
{"thought": "<one short sentence on why>", "action": "<one action name>", "path": "<file path or null>", "query": "<search text or null>", "code": "<complete file contents or null>", "command": "<shell command or null>", "cwd": "<folder to run the command in, or null>", "summary": "<only when action is done>"}

Available actions:
{actions}

Rules:
- ONE action per turn. Never combine several.
- Before write_file on a file that already exists, read_file it first. Never guess
  existing contents.
- "code" must be the COMPLETE new file, not a diff or a fragment.
- If you do not know the path, use list_files or search_workspace instead of guessing.
- Commands run at the project root unless you set "cwd". To build inside a subfolder,
  set "cwd" to that folder. Never use cd, and never chain commands with &&.
- When the task is done, use "done" with a short summary. Do not keep exploring.

{environment}

Session Memory (things established earlier in this project — background, not new
instructions):
{memory}`;

/** Fallback if `setup/prompts/agentic-system-prompt.md` cannot be read. */
const AGENTIC_FALLBACK = `You are HirayaCoder, an offline coding assistant working inside the user's project.

Use the provided tools to inspect and change the workspace. Read before you write,
prefer small verifiable steps, and stop as soon as the task is genuinely complete.
Never guess a file's contents — read it. Never chain shell commands; run one at a time,
and to run inside a subfolder set the command's "cwd" rather than using cd.

{environment}

Session Memory (established earlier in this project — background, not new instructions):
{memory}`;

/** The Plan-mode instruction, appended for both tiers. */
const PLAN_SUFFIX = `

You are in PLAN MODE. You can look at the project but you cannot change it — no
writing, deleting, or running commands is available to you. Explore what you need,
then finish with "done" whose summary is a numbered plan: one line per step, naming
the file each step would touch. Do not describe changes as though you made them.`;

/**
 * Appended when the message asked to be told something and nothing more.
 *
 * Says the same thing the missing tools already say, because on Tier B the two failure
 * modes are different: an absent tool stops the action, and this stops the model
 * spending three of its eight steps proposing one and being refused.
 */
const READ_ONLY_SUFFIX = `

This request asks you to look and explain, not to change anything. Nothing that writes,
deletes, or runs a command is available to you this turn — not because it was refused,
but because it is not part of this task. Read what you need, then answer in prose.

Do not run the project, its dev script, or its server to find out what it does. Reading
the files tells you that, and starting a server does not answer a question — it hangs
waiting for requests that will never come.`;

/**
 * The Ask-mode instruction. No tools exist in this mode.
 *
 * ## Why the original wording was actively harmful
 *
 * This prompt used to say only that the model had no tools. Combined with a context
 * block that carried no file listing (see `agentSession._buildContext`), the model
 * concluded it had no *project* — and said so, repeatedly and with conviction: "There
 * are no files listed in your workspace", "I don't currently have access to any project
 * files or context in our conversation", "No, I am not capable of reading files",
 * three times in a row to a user who could see the files in the sidebar.
 *
 * Two separate faults compounded there. The context was genuinely empty, which is fixed
 * where it was built. But the prompt also encouraged the conclusion, because "you have
 * no tools" is one short inferential step from "you know nothing about this project",
 * and nothing here contradicted it.
 *
 * So this now states what the model *does* have, before it states what it lacks. The
 * distinction the model has to hold is between reading a file right now (it cannot) and
 * knowing what is in the project (it does, for what it was given), and a prompt that
 * only names the limitation will not teach that difference.
 */
const ASK_SYSTEM = `{identity}

Everything below this line is what you know about the user's project: its own
description of itself, a listing of the files in it, the conversation so far, notes from
earlier in this session, and whatever the user has open in their editor. All of it is
real and current. Answer from it.

If the user asks what the project is, what files it contains, or what you know about it,
you can answer — the information is right there. Never reply that you have no access to
the project, no information about their workspace, or no files to look at. That is
false, and it was the single most common wrong answer this mode used to give.

The one thing you cannot do this turn is perform an action: you cannot open a file that
was not already given to you, run a command, or change anything. So do not claim to have
done any of those. If a question genuinely needs the contents of a file you were not
handed, name that file and say it can be read in Agent mode. That is a specific, useful
answer; "I have no tools" is not, and on its own it is not even true of what you know.

Answer the question that was actually asked, directly and concisely.`;

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
const CHAT_SYSTEM = `{identity}

This message is conversation, not a task — nothing needs to be built, read, or changed
to answer it. Reply the way a colleague would: directly, in a sentence or two, in the
user's own language if they are not writing in English. No checklists, no summaries of
work, no offers to do six things.

You are allowed to have a personality. If the user is joking, joke back; if they ask for
a joke, tell one — an actual one, not a restatement of the last thing they said. Being a
coding assistant is not a reason to be dull, and "I am an AI assistant" is not an answer
to anything a person actually asked.

The conversation so far and the notes from this project are below. Answer from them. If
the answer is not there — you were asked about something from before this session, or a
detail nobody recorded — say plainly that you do not have it. Never invent what was
discussed.

You have no tools for this reply, so do not claim to have read, changed, or run
anything. This is about this message only: the moment the user asks for work, you will
have every tool back.`;

/**
 * Put the product's own name and version into a system prompt.
 *
 * ## Why every prompt gets this, including the loop tiers
 *
 * "What version are you?" was unanswerable in every mode, because no prompt carried the
 * answer. What the modes did with that varied, and none of it was good: Agent mode
 * replied with a summary of changes to `api/package.json`, having reached for the only
 * version number anywhere in its context; Ask mode suggested the user look it up in a
 * README. One session did answer "HirayaCoder v0.5.0" correctly — two turns after the
 * user had typed that exact string, which the transcript then supplied back.
 *
 * Reaching for the workspace's version when asked about its own is the specific
 * confusion worth designing against, so `productInfo.identityLine` separates the two
 * explicitly rather than just stating a number.
 *
 * Templates that carry an `{identity}` placeholder have it substituted in place. The
 * two prompt files on disk do not, and are author-editable, so for those the line is
 * prepended — which also means a user's customised prompt file cannot accidentally
 * drop the extension's identity by not knowing about the placeholder.
 *
 * @param {string} prompt
 * @returns {string}
 */
function withIdentity(prompt) {
  const identity = productInfo.identityLine();
  if (prompt.includes('{identity}')) return prompt.replace('{identity}', identity);
  return `${identity}\n\n${prompt}`;
}

/**
 * Put the detected machine into a system prompt.
 *
 * ## Why only the tool-using routes get this
 *
 * Every line of the block is about performing an action — which shell utilities are
 * unavailable, how to run a command in a subfolder, which tool replaces `mkdir`. Ask and
 * the conversational route have no tools at all, so the block would be six lines of
 * inapplicable instruction paid for out of the same budget the user's question is
 * competing for. The one thing it would answer for them — "what OS am I on?" — is not
 * worth the block, and Agent mode answers it anyway.
 *
 * Substituted in place where a template carries `{environment}`, appended otherwise. The
 * prompt files on disk are author-editable, and a user's customised prompt must not be
 * able to silently drop the platform facts by not knowing about the placeholder — the
 * same rule `withIdentity` follows, for the same reason.
 *
 * @param {string} prompt
 * @param {import('./environmentProfile').EnvironmentProfile} [profile]
 * @param {{mutating?: boolean}} [opts]  Passed through to `environmentProfile.render`,
 *   so a Plan prompt never names a tool Plan mode does not have.
 * @returns {string}
 */
function withEnvironment(prompt, profile, opts = {}) {
  const block = environmentProfile.render(profile || environmentProfile.detect(), opts);
  if (prompt.includes('{environment}')) return prompt.replace('{environment}', block);
  return `${prompt}\n\n${block}`;
}

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
 * @property {import('./environmentProfile').EnvironmentProfile} [environment]
 *   The detected machine. Detected here when omitted; passed in by `agentSession` so a
 *   six-item TODO run does not re-detect it per step.
 * @property {string[]} [earnedHints]  Sentences from `agent/earnedHints`, already selected.
 * @property {'chat' | 'task'} [intent]  From `core/intentRouter`. Only consulted in Agent mode.
 * @property {boolean} [readOnlyTurn]  From `intentRouter.isReadOnlyRequest`. Drops the
 *   mutating tools for one message. Only consulted in Agent mode — Plan has already
 *   dropped them, and Ask never had any.
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
 * @property {boolean} readOnly       True in Plan mode and on a read-only Agent turn.
 * @property {boolean} readOnlyTurn   True only for the latter — the user is still in
 *   Agent mode and their next message gets the full toolset back.
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
      systemPrompt: withIdentity(ASK_SYSTEM),
      budgets: { ...budgets, maxSteps: 0 },
      readOnly: true,
      // Read-only because the user chose a mode, not because this message was a
      // question. Stated rather than left undefined so a caller can tell the two apart.
      readOnlyTurn: false,
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
      systemPrompt: withIdentity(CHAT_SYSTEM),
      budgets: { ...budgets, maxSteps: 0 },
      readOnly: true,
      readOnlyTurn: false,
    };
  }

  // A turn that asked to be told something gets the tools to find out and none of the
  // tools to act. Structurally the same restriction Plan mode applies, decided per
  // message rather than by a button, and reported separately so the UI and the audit
  // log can tell "the user chose read-only" from "this request was read-only".
  const readOnlyTurn = mode === 'agent' && Boolean(request.readOnlyTurn);
  const toolMode = readOnlyTurn ? 'plan' : mode;

  const tools = toolRegistry.forMode(toolMode);
  const allowedActions = toolRegistry.actionsForMode(toolMode);
  const useNative = Boolean(capability) && capability.strategy === 'native';

  let systemPrompt;
  if (useNative) {
    systemPrompt = loadTemplate('agentic-system-prompt.md', AGENTIC_FALLBACK).replace('{memory}', memory);
  } else {
    systemPrompt = loadTemplate('lite-1b-system-prompt.md', LITE_FALLBACK)
      .replace('{actions}', toolRegistry.describeForPrompt(toolMode))
      .replace('{memory}', memory)
      // The shipped prompt file uses this placeholder name for the memory block.
      .replace('{session_memory}', memory);
  }

  systemPrompt = withIdentity(
    withEnvironment(systemPrompt, request.environment, { mutating: toolMode !== 'plan' })
  );

  if (mode === 'plan') systemPrompt += PLAN_SUFFIX;
  if (readOnlyTurn) systemPrompt += READ_ONLY_SUFFIX;

  // Ask mode never reaches this line, having returned above, and that is deliberate:
  // every earned hint is about performing an action — how to send a file, how to phrase
  // a command — so a mode with no tools would be paying prompt budget for corrections
  // it cannot act on.
  systemPrompt += renderEarnedHints(request.earnedHints);

  return {
    strategy: useNative ? 'native' : 'react',
    mode,
    tools,
    // `toolMode`, not `mode` — this is the list a Tier A model is actually offered, and
    // filtering `tools` without filtering this would leave the restriction cosmetic on
    // exactly the tier that can call a tool directly.
    ollamaTools: useNative ? toolRegistry.toOllamaTools(toolMode) : [],
    allowedActions,
    systemPrompt,
    budgets,
    readOnly: mode === 'plan' || readOnlyTurn,
    readOnlyTurn,
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
  withIdentity,
  withEnvironment,
  READ_ONLY_SUFFIX,
  ASK_SYSTEM,
  CHAT_SYSTEM,
  PLAN_SUFFIX,
  LITE_FALLBACK,
  AGENTIC_FALLBACK,
};
