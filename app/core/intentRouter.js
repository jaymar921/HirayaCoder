'use strict';

/**
 * Is this message something to *do*, or something to *answer*?
 *
 * ## The failure this exists for
 *
 * Agent mode constrains Tier B decoding to `outputParser.actionSchema`, a grammar whose
 * every branch is a tool call. A greeting cannot produce a greeting, because a greeting
 * is not in the language the model is allowed to speak. Asked "what model are you", the
 * only legal outputs are `read_file`, `list_files`, `write_file`, and the rest — so the
 * model picks one, the loop feeds back a file, it picks another, and the repeat guard
 * ends the turn. Observed across a whole evaluation session: every single message,
 * including "can you remember our first conversation?", came back as "I stopped because
 * I kept repeating the same step (read_file on todoapp.html)".
 *
 * The model was never the problem there. A 1B model can say hello perfectly well. It was
 * not permitted to.
 *
 * ## Why the default is `task`
 *
 * Being wrong toward `task` costs one loop that reads a file and answers — which is
 * exactly what happens today, for every message. Being wrong toward `chat` costs the
 * user a request that was silently not carried out, which is the worse failure by a
 * wide margin, and the harder one to notice.
 *
 * So `chat` is never inferred from the *absence* of task signals. It requires positive
 * evidence, and any imperative anywhere in the message overrides all of it: "hey, can
 * you fix the bug in app.js" is work with a greeting attached, not a greeting.
 *
 * ## Why this is patterns rather than a model call
 *
 * It runs before every turn on hardware where an inference is seconds, and it is
 * answering a question the message usually settles outright. A classifier that costs a
 * round-trip to decide that "hi" is not a refactor is a bad trade — and worse, it is
 * another chance for a small model to be wrong about something the caller can simply
 * read. Where the patterns genuinely cannot tell, the answer is `task`, and the agent
 * loop is perfectly capable of answering a question.
 *
 * @module core/intentRouter
 */

/**
 * Verbs that make a message a request for work, wherever they appear.
 *
 * Shared in spirit with `agentSession.looksLikeAQuestion`, which draws a different line
 * for a different purpose — that one separates questions from work to decide whether to
 * build a TODO list, and both of its outcomes are agent runs. This one decides whether
 * an agent runs at all.
 */
const WORK_VERB =
  /\b(?:add|create|write|implement|update|edit|change|fix|refactor|delete|remove|rename|move|install|generate|build|make|run|compile|convert|migrate|rewrite|replace|set\s?up|scaffold|debug|test|deploy|open|show\s+me|list|find|search|read|check|review|explain|describe|analy[sz]e)\b/i;

/** A filename, an extension, or a path — a message about the project's contents. */
const NAMES_A_FILE = /(?:[\w-]+\.[a-z0-9]{1,6}\b|\b[\w-]+\/[\w./-]+)/i;

/**
 * Openings that are social rather than instructional.
 *
 * Tagalog is here because the user base for this extension is, and "kumusta" arriving as
 * a `read_file` loop is the same bug in a second language. The welcome screen already
 * greets in it.
 */
const GREETING =
  /^\s*(?:hi|hey|hello|yo|sup|hiya|howdy|kumusta|kamusta|musta|good\s+(?:morning|afternoon|evening|day)|greetings)\b/i;

/** Closings and acknowledgements. Nothing follows these that needs a tool. */
const PLEASANTRY =
  /^\s*(?:thanks|thank\s+you|salamat|ty|ok|okay|k|cool|nice|great|awesome|perfect|got\s+it|understood|sounds\s+good|no\s+worries|never\s?mind|nvm|bye|goodbye|see\s+you|good\s?night)\b/i;

/**
 * Questions about the assistant itself.
 *
 * These are the ones that look most like work to a keyword matcher and are least like
 * it in fact. "what model are you" contains no file and no verb, but "are you" is doing
 * all the work of the sentence.
 */
const ABOUT_THE_ASSISTANT =
  /\b(?:who\s+are\s+you|what\s+are\s+you|are\s+you\s+(?:a|an|the)?\s*\w*(?:model|llm|ai|bot|human)|what(?:'s| is)?\s+your\s+name|wh(?:at|ich)\s+(?:model|llm|ai)\b|you\s+are\s+\S+:\S+)\b/i;

/**
 * Questions about the conversation rather than about the project.
 *
 * "can you remember our first conversation?" is the message that made this necessary.
 * It is not a request to read anything on disk, and answering it by grepping the
 * workspace is how the agent spent that turn.
 */
const ABOUT_THE_CONVERSATION =
  /\b(?:do|can|could)\s+you\s+(?:still\s+)?(?:remember|recall)\b|\b(?:our|the)\s+(?:first|previous|last|earlier)\s+(?:conversation|chat|session|message)\b|\bwhat\s+(?:did|have)\s+(?:i|we)\s+(?:say|ask|talk|discuss)/i;

/** Beyond this many words, a message is doing more than being polite. */
const MAX_PLEASANTRY_WORDS = 6;

/**
 * @typedef {object} Intent
 * @property {'chat' | 'task'} intent
 * @property {string} reason  Why, for the log. Never shown to the model.
 */

/**
 * Classify one message.
 *
 * @param {string} text The user's message, verbatim.
 * @returns {Intent}
 */
function classify(text) {
  const message = String(text == null ? '' : text).trim();

  if (message.length === 0) return { intent: 'task', reason: 'empty message' };

  // An instruction anywhere wins, before anything else is considered. "hi, can you add
  // a test" is a task, and treating it as a greeting would drop the request on the
  // floor — the one outcome this module must never produce.
  if (WORK_VERB.test(message)) {
    return { intent: 'task', reason: 'contains an instruction' };
  }

  // A path with no verb is still almost always about doing something to it.
  if (NAMES_A_FILE.test(message)) {
    return { intent: 'task', reason: 'names a file or path' };
  }

  if (ABOUT_THE_CONVERSATION.test(message)) {
    return { intent: 'chat', reason: 'asks about the conversation' };
  }

  if (ABOUT_THE_ASSISTANT.test(message)) {
    return { intent: 'chat', reason: 'asks about the assistant' };
  }

  const words = message.split(/\s+/).filter(Boolean).length;

  if (GREETING.test(message)) {
    return { intent: 'chat', reason: 'greeting' };
  }

  // Length matters for these and not for greetings: "hello" opening a paragraph of
  // requirements is still a greeting followed by work, and the verb check above has
  // already claimed that case. "ok" is only ever an acknowledgement when it is the
  // whole message — "ok now the other file needs the same treatment" is not.
  if (PLEASANTRY.test(message) && words <= MAX_PLEASANTRY_WORDS) {
    return { intent: 'chat', reason: 'pleasantry' };
  }

  return { intent: 'task', reason: 'no conversational signal' };
}

module.exports = {
  classify,
  WORK_VERB,
  NAMES_A_FILE,
  GREETING,
  PLEASANTRY,
  ABOUT_THE_ASSISTANT,
  ABOUT_THE_CONVERSATION,
  MAX_PLEASANTRY_WORDS,
};
