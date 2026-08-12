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

/**
 * The subset of `WORK_VERB` that asks for the project to be *different* afterwards.
 *
 * `WORK_VERB` is deliberately broad — it decides whether the agent runs at all, and
 * "explain the auth flow" needs tools even though it changes nothing. This narrower set
 * answers a different question: if the model reports it has finished and the change set
 * is empty, was that a legitimate answer or a claim about work that never happened?
 *
 * Reading, checking, and explaining are absent for exactly that reason. They finish
 * correctly having written nothing, and treating them as unfinished would make the
 * check fire on the cases it is most likely to be wrong about.
 */
const MUTATING_VERB =
  /\b(?:add|create|write|implement|update|edit|change|fix|refactor|delete|remove|rename|move|install|generate|build|compile|convert|migrate|rewrite|replace|scaffold|make)\b/i;

/**
 * Does this request only count as finished if something on disk changed?
 *
 * @param {string} text
 * @returns {boolean}
 */
function requiresChange(text) {
  return MUTATING_VERB.test(String(text || ''));
}

/** A filename, an extension, or a path — a message about the project's contents. */
const NAMES_A_FILE = /(?:[\w-]+\.[a-z0-9]{1,6}\b|\b[\w-]+\/[\w./-]+)/i;

/**
 * Words that carry no request on their own — greetings, thanks, sign-offs, and the
 * filler that travels with them.
 *
 * ## Why this is a vocabulary and not a prefix match
 *
 * The first version matched a pleasantry at the *start* of a message and capped the
 * length at six words. `"okay proceed"` satisfied both, and the consequences were
 * exactly what this module's own header warns about: routed to chat, the model had no
 * tools, so it replied with the complete HTML file in a code fence and the sentence
 * "Saved to `todoapp.html`." Nothing was saved. The user asked three more times.
 *
 * A social word at the front of a message says nothing about the rest of it. So the
 * test is now that the *whole* message is social — every token has to be in here — and
 * anything left over means there is a request attached.
 *
 * Tagalog is included because the user base for this extension is, and "salamat"
 * arriving as a `read_file` loop is the same bug in a second language.
 */
const SOCIAL_WORDS = new Set([
  // Greetings.
  'hi', 'hey', 'hello', 'yo', 'sup', 'hiya', 'howdy', 'greetings',
  'kumusta', 'kamusta', 'musta', 'good', 'morning', 'afternoon', 'evening', 'day',
  // Tagalog pronouns and particles, which is what a greeting in it is mostly made of:
  // "kamusta ka", "salamat na lang", "sige po". Safe to include even though some are
  // common words, because a message only counts as social when *every* word is here.
  'ka', 'kayo', 'na', 'lang', 'din', 'rin', 'sige', 'oo',
  // Thanks and sign-offs.
  'thanks', 'thank', 'ty', 'salamat', 'maraming', 'cheers', 'bye', 'goodbye',
  'night', 'later', 'ingat',
  // Acknowledgements that cannot mean "go ahead" — see the note below.
  'cool', 'nice', 'great', 'awesome', 'perfect', 'excellent', 'understood', 'noted',
  'lol', 'haha', 'nvm', 'nevermind',
  // Filler that rides along: "thanks a lot", "no worries", "nice one", "see you".
  'a', 'lot', 'so', 'much', 'very', 'the', 'for', 'that', 'it', 'one', 'you', 'u',
  'no', 'worries', 'problem', 'never', 'mind', 'see', 'ya', 'there', 'man', 'dude',
  'bro', 'sir', 'maam', "ma'am", 'po', 'help', 'got',
]);

/**
 * Assent words are deliberately **absent** from `SOCIAL_WORDS`.
 *
 * "ok", "okay", "sure", "yes", "yeah", "alright", "go ahead", "proceed" — every one of
 * them routinely means *carry on with what I just asked for*, and treating one as small
 * talk drops a request silently. Routing them to the agent instead costs a loop that
 * reads a file, and since 0.4.0 the loop has the conversation in its context, so it can
 * see what it is being told to carry on with.
 *
 * Documented as a constant so the omission reads as a decision rather than an oversight.
 */
const ASSENT_IS_NOT_SOCIAL = ['ok', 'okay', 'k', 'sure', 'yes', 'yeah', 'yep', 'alright', 'right', 'go', 'proceed'];

/**
 * Questions about the assistant itself.
 *
 * These are the ones that look most like work to a keyword matcher and are least like
 * it in fact. "what model are you" contains no file and no verb, but "are you" is doing
 * all the work of the sentence.
 */
const ABOUT_THE_ASSISTANT =
  // The "are you a … model" branch keeps its optional qualifier anchored to a trailing
  // space (`[\w-]+\s+`) rather than letting `\w*` sit directly against the alternation.
  // Adjacent quantifiers that can both claim the same characters are the shape that
  // backtracks exponentially, and this pattern runs on every message the user types.
  /\b(?:who\s+are\s+you|what\s+are\s+you|are\s+you\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+)?(?:model|llm|ai|bot|human)|what(?:'s| is)?\s+your\s+name|wh(?:at|ich)\s+(?:model|llm|ai)\b|you\s+are\s+\S+:\S+)\b/i;

/**
 * Questions about the conversation rather than about the project.
 *
 * "can you remember our first conversation?" is the message that made this necessary.
 * It is not a request to read anything on disk, and answering it by grepping the
 * workspace is how the agent spent that turn.
 */
const ABOUT_THE_CONVERSATION =
  /\b(?:do|can|could)\s+you\s+(?:still\s+)?(?:remember|recall)\b|\b(?:our|the)\s+(?:first|previous|last|earlier)\s+(?:conversation|chat|session|message)\b|\bwhat\s+(?:did|have)\s+(?:i|we)\s+(?:say|ask|talk|discuss)/i;

/**
 * Is every word in this message a social one?
 *
 * @param {string} message
 * @returns {boolean}
 */
function isPurelySocial(message) {
  const words = message
    .toLowerCase()
    // Punctuation and emoji go, so "thanks!" and "hi 👋" read as their words alone.
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) return false;
  return words.every((word) => SOCIAL_WORDS.has(word));
}

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

  // The whole message, not its opening. A greeting in front of a sentence is a polite
  // request, and the one thing this must never do is answer the greeting and drop the
  // request.
  if (isPurelySocial(message)) {
    return { intent: 'chat', reason: 'nothing but pleasantries' };
  }

  return { intent: 'task', reason: 'no conversational signal' };
}

module.exports = {
  classify,
  requiresChange,
  isPurelySocial,
  WORK_VERB,
  MUTATING_VERB,
  NAMES_A_FILE,
  SOCIAL_WORDS,
  ASSENT_IS_NOT_SOCIAL,
  ABOUT_THE_ASSISTANT,
  ABOUT_THE_CONVERSATION,
};
