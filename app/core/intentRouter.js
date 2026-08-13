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
 * The verbs a *planner* reaches for, on top of the ones a user types.
 *
 * `MUTATING_VERB` was written against messages people send, and it is also applied to
 * text no person wrote: `judgeItem` passes each TODO item through `requiresChange` to
 * decide whether "done, nothing changed" is a legitimate answer for that item. Those
 * two vocabularies are not the same, and the gap had teeth.
 *
 * Measured on the React + Vite + Tailwind benchmark, `qwen3.5:4b` planned six items,
 * two of which were "Configure exact folder structure including components, hooks,
 * assets, and config files" and "Assemble App.jsx layout with glassmorphism styling,
 * floating circles, and responsive design". Neither `configure` nor `assemble` was in
 * the list, so neither item was ever challenged, and both were reported to the user as
 * `done (no files changed)` — including the one item whose entire job was App.jsx,
 * which ended the run still holding Vite's scaffolded counter demo.
 *
 * ## Why this is a separate set rather than a wider one
 *
 * Half of these are ordinary words in a question. "Explain how the router **handles**
 * a request", "what does this component **render**", "does it **support** YAML" are
 * all things people ask, and every one of them finishes correctly having written
 * nothing. Folding these into `MUTATING_VERB` would fire the completion check on the
 * cases it is most likely to be wrong about — the exact mistake the note above warns
 * against — so they only count where the text is known not to be a question: an item
 * that `dropNonDeliverables` has already passed as a piece of work to deliver.
 */
const PLANNED_DELIVERABLE_VERB =
  /\b(?:configure|assemble|compose|construct|wire(?:\s+up)?|hook\s+up|set[\s-]?up|extract|split|extend|introduce|enforce|apply|style|persist|initiali[sz]e|populate|render|support|handle|integrate|connect|expose|export|import|declare|define)\b/i;

/**
 * Does this request only count as finished if something on disk changed?
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.planned]  True when `text` is a TODO item the planner wrote
 *   and `dropNonDeliverables` kept — never a message the user typed. Widens the
 *   vocabulary to the words a model uses to describe producing a file, which are
 *   ambiguous in a question and unambiguous in a deliverable.
 * @returns {boolean}
 */
function requiresChange(text, opts = {}) {
  const subject = String(text || '');
  if (MUTATING_VERB.test(subject)) return true;
  return Boolean(opts.planned) && PLANNED_DELIVERABLE_VERB.test(subject);
}

/**
 * Verbs that ask to be told something, with nothing done about it.
 *
 * Narrower than the read-ish subset of `WORK_VERB`, which is answering a different
 * question — whether the agent runs at all. These are the messages where the agent
 * should run, with tools, and where every one of those tools should be read-only.
 */
const COMPREHENSION_VERB =
  /\b(?:read|explain|describe|summari[sz]e|review|tell me about|show me|walk me through|analy[sz]e|understand|look at|go through|what(?:'s| is| are| does| do)\b)/i;

/**
 * Verbs that ask for something to be executed.
 *
 * Separate from `MUTATING_VERB` because running a program is not editing a file and the
 * two need distinguishing here: "run the tests and tell me what breaks" changes nothing
 * on disk and is emphatically not a read-only request.
 */
const EXECUTION_VERB =
  /\b(?:run|execute|start|launch|serve|boot|compile|install|deploy|npm|npx|yarn|pnpm|node|python|java|mvn|gradle|docker)\b/i;

/**
 * Is this message asking to be told about the project, and nothing more?
 *
 * ## The failure this exists for
 *
 * Asked "can you read the README.md file?", the agent proposed reading six files, was
 * told "proceed", and ran `start_development_windows.bat` followed by `node
 * api/server.js`. The batch file was refused by the program allowlist. `node` is on that
 * allowlist — correctly, it is how you run a project's tests — so the agent started the
 * user's API server, which bound a port, failed to reach MongoDB, and hung the session
 * until the step limit. The user's reply: "I asked you to read it not run it."
 *
 * The allowlist was never the right place to catch this. `node` has to be allowed, and a
 * gate that inspects only the command cannot know that the request was to read. What was
 * missing is upstream: nothing connected "read this file" to "therefore do not execute
 * anything", so a planner that drifted from reading to running met no resistance until
 * the command itself was already being approved.
 *
 * ## Why assent inherits
 *
 * "proceed" carries no verb of its own and cannot be classified alone. In the session
 * above it is the word that authorised the escalation — the user was agreeing to the
 * reads that had just been listed, and got a server boot. So a bare assent takes the
 * restriction of the request it is agreeing to, which is the only reading of "proceed"
 * that matches what the user thought they were saying.
 *
 * @param {string} text
 * @param {Array<{role: string, text: string}>} [conversation]
 *   Earlier turns, oldest first, excluding this one. Only consulted for bare assent.
 * @returns {boolean}
 */
function isReadOnlyRequest(text, conversation) {
  const subject = String(text || '').trim();
  if (!subject) return false;

  const words = subject
    .toLowerCase()
    .split(/[^a-z']+/)
    .filter(Boolean);

  // Bare assent inherits from the request it is agreeing to.
  if (words.length > 0 && words.every((word) => ASSENT_WORDS.has(word) || SOCIAL_WORDS.has(word))) {
    const turns = Array.isArray(conversation) ? conversation : [];
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (!turn || turn.role !== 'user') continue;
      return isReadOnlyRequest(turn.text);
    }
    return false;
  }

  if (!COMPREHENSION_VERB.test(subject)) return false;
  if (EXECUTION_VERB.test(subject)) return false;
  return !MUTATING_VERB.test(subject);
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
  // Filipino time-of-day greetings. "Magandang hapon!" was classified as work and ran
  // the agent, which proposed a `start_development_windows.bat` invocation with
  // fourteen invented flags. The extension is named for a Filipino word; its users
  // greet it in Filipino.
  'magandang', 'umaga', 'tanghali', 'hapon', 'gabi', 'mabuhay',
  // Greetings in the other languages that turned up in testing. Cheap to accept: a
  // message only counts as social when *every* word is in this set, so "hola" alone is
  // a greeting and "hola, delete src/old.js" is not.
  'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'gracias', 'adios',
  'bonjour', 'salut', 'merci', 'ciao', 'hallo', 'guten', 'tag', 'danke',
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
  // "it's okay", "that's fine" — the subject of an acknowledgement.
  'its', "it's", 'thats', "that's", 'is', 'was', 'fine', 'all',
  // "thanks again", "thank you too".
  'again', 'too', 'as', 'well',
]);

/**
 * Words that mean "carry on" as easily as they mean "understood".
 *
 * These are **neutral**, which is a third category and not an oversight. Held apart
 * from `SOCIAL_WORDS` because a message made only of them is a go-ahead — "okay
 * proceed", "sure", "alright" — and answering that conversationally drops a request.
 * Held out of the task path too, because a message made of these *plus* real
 * pleasantries is unambiguously an acknowledgement: "okay thank you", "it's okay",
 * "k thanks".
 *
 * The first version simply excluded them, which made any message containing one a task.
 * That was over-corrected, and the cost showed up immediately in testing: "okay thank
 * you" ran a four-item TODO list that re-analysed five files, and "it's okay" spent its
 * budget on refused `which java` calls. The rule is now that assent alone decides
 * nothing — a social word has to be present for the message to count as small talk.
 */
const ASSENT_WORDS = new Set([
  'ok', 'okay', 'okey', 'k', 'kk', 'sure', 'yes', 'yeah', 'yep', 'yup',
  'alright', 'right', 'go', 'ahead', 'proceed', 'continue', 'sige',
]);

/**
 * Asking after the assistant itself rather than the project.
 *
 * "how are you" has no file in it, no verb this module recognises, and no social word
 * — so every earlier rule let it through to the agent, which read two source files and
 * reported on them. The user's next message was "why are you reading the files, i just
 * asked how are you".
 */
const PERSONAL_STATE =
  /\bhow\s+are\s+you\b|\bhow'?s\s+it\s+going\b|\bwhat'?s\s+up\b|\bhow\s+do\s+you\s+do\b|\bhow\s+have\s+you\s+been\b|\bkumusta\s+ka\b/i;

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
 * Asking the assistant which version it is.
 *
 * Separate from `ABOUT_THE_ASSISTANT` only because the failure it fixes is specific
 * enough to deserve its own note. "what version are you?" classified as `task`, so the
 * agent loop ran, and the loop's job is to use tools — it read `api/package.json`,
 * found `1.0.0`, and reported **"My version is v1.0.0. This matches the project's
 * current release tag as shown in `api/package.json`."**
 *
 * The system prompt already carried the right answer and said in as many words not to
 * look for it in the workspace. It lost, because a loop with a file in front of it will
 * believe the file. The fix is not to argue with the model harder; it is to not start a
 * loop for a question that has nothing to do with the project.
 *
 * `your version` and `version are you` are matched, `the version` deliberately is not —
 * "what version of node does this project need" is a real question about the workspace.
 */
const ABOUT_THE_VERSION =
  /\b(?:wh(?:at|ich)\s+version\s+(?:are|r)\s+you|wh(?:at|ich)(?:'s| is)?\s+your\s+version|your\s+version\s+(?:number|is)|are\s+you\s+(?:version|v)\s*\d)/i;

/**
 * Someone telling you their name.
 *
 * "I'm Jay" was classified as `task` and ran the agent loop — four times, across three
 * sessions. Once it read a file, once it started editing `AuthenticationController.js`
 * unprompted, and twice it hit the repeat guard and reported "I stopped because I kept
 * repeating the same step". The user's next message each time was some variation of
 * trying again.
 *
 * The reason it fell through is that an introduction contains no verb, no file, and no
 * pleasantry — `isPurelySocial` requires a social *word*, and "Jay" is not one. It
 * matched nothing and hit the `task` default.
 *
 * ## Why the stoplist
 *
 * "I'm" opens plenty of real requests: "I'm getting an error", "I'm trying to add auth",
 * "I'm not sure why this fails". Most are already claimed by the verb and file rules
 * that run before this one, but not all — "I'm stuck on the auth flow" has neither. So
 * the word after the pronoun has to look like a name rather than a state, and
 * `NOT_A_NAME` holds the continuations that mean the sentence is going somewhere else.
 */
const INTRODUCES_SELF =
  /\b(?:i'?m|i\s+am|my\s+name\s+is|my\s+name'?s|this\s+is|you\s+can\s+call\s+me|call\s+me|ako\s+si|ako'?y|me\s+llamo|je\s+m'?appelle)\s+([a-z][\w'-]*)/i;

/**
 * Words that, following "I'm", mean this is not an introduction.
 *
 * Adjectives and participles: the sentence is describing a situation. A name is a noun
 * and will not be in here, and the cost of a miss is one conversational reply to a
 * message that wanted work — recoverable in a way that silently editing a controller
 * because someone said hello is not.
 */
const NOT_A_NAME = new Set([
  'not', 'no', 'just', 'still', 'also', 'only', 'really', 'quite', 'very', 'so',
  'trying', 'going', 'getting', 'having', 'looking', 'working', 'wondering', 'thinking',
  'seeing', 'using', 'running', 'building', 'writing', 'reading', 'testing', 'debugging',
  'stuck', 'confused', 'lost', 'sure', 'done', 'finished', 'ready', 'back', 'here',
  'new', 'sorry', 'afraid', 'curious', 'interested', 'unable', 'able', 'good', 'fine',
  'ok', 'okay', 'well', 'currently', 'now', 'about', 'on', 'in', 'at', 'with', 'the',
  'a', 'an', 'my', 'your', 'this', 'that', 'it', 'to', 'be', 'been',
]);

/**
 * Is this message someone introducing themselves, and nothing more?
 *
 * @param {string} text
 * @returns {boolean}
 */
function isIntroduction(text) {
  const match = INTRODUCES_SELF.exec(String(text || ''));
  if (!match) return false;
  return !NOT_A_NAME.has(match[1].toLowerCase());
}

/**
 * Asking for something light — a joke, a fun fact.
 *
 * "can you share a joke" ran the agent loop, because `share` is not a work verb and a
 * joke is not a pleasantry, so nothing claimed it. One model answered *"I can't tell
 * jokes or make personal recommendations like that — I'm designed to be helpful,
 * harmless, and honest"* and then told a joke anyway, which is the shape of a model
 * being handed the wrong frame and half-escaping it.
 */
const ASKS_FOR_BANTER = /\b(?:joke|riddle|pun|fun\s+fact|something\s+funny|make\s+me\s+laugh|cheer\s+me\s+up)\b/i;

/**
 * Questions about the conversation rather than about the project.
 *
 * "can you remember our first conversation?" is the message that made this necessary.
 * It is not a request to read anything on disk, and answering it by grepping the
 * workspace is how the agent spent that turn.
 */
const ABOUT_THE_CONVERSATION =
  /\b(?:do|can|could)\s+you\s+(?:still\s+)?(?:remember|recall)\b|\b(?:our|the|my|this)\s+(?:first|initial|previous|last|earlier|whole|entire)?\s*(?:conversation|chat|session)\b|\bwhat\s+(?:did|have)\s+(?:i|we)\s+(?:say|ask|talk|discuss|do)/i;

/**
 * Asking where the work has got to, rather than asking for more of it.
 *
 * A distinct category from the two above and the one that cost the most in testing.
 * "can you verify our conversation, where are we currently right now?" contains
 * `verify`, so the work-verb rule claimed it and the agent re-read the same file until
 * the repeat guard stopped it — twice in a row, because the user rephrased and the
 * rephrasing contained `created`.
 *
 * These are answerable entirely from the conversation and the session notes, both of
 * which are already in the prompt. Reading a file to answer "where are we" is how the
 * agent loses the thread it is being asked about.
 */
const ABOUT_THE_PROGRESS =
  /\bwhere\s+are\s+we\b|\bwhat(?:'s| is)?\s+the\s+(?:state|status|progress)\b|\bwhat\s+have\s+we\s+(?:done|got|finished)\b|\bcatch\s+me\s+up\b|\brecap\b|\bwhere\s+did\s+we\s+(?:leave|stop|get)\b/i;

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
  // Every word has to be social or neutral, and at least one has to be genuinely
  // social. "okay thank you" qualifies; "okay proceed" does not.
  if (!words.every((word) => SOCIAL_WORDS.has(word) || ASSENT_WORDS.has(word))) return false;
  return words.some((word) => SOCIAL_WORDS.has(word));
}

/** Words a greeting may be followed by without becoming a request. */
const GREETING_TAIL_WORDS = 3;

/**
 * A greeting with a name on it.
 *
 * "hello gemma4" went to the agent because `gemma4` is in no vocabulary and never
 * could be — it is whatever the user has installed. The model then asked for "the full
 * task description" for a message that was hello.
 *
 * Bounded hard at three words, and only when a greeting opens the message, so "hi the
 * delete button is broken" is untouched. A greeting followed by an actual instruction
 * has already been claimed by the work-verb rule long before this runs.
 *
 * @param {string} message
 * @returns {boolean}
 */
function isGreetingWithName(message) {
  const words = message
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s:.-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0 || words.length > GREETING_TAIL_WORDS) return false;
  return SOCIAL_WORDS.has(words[0]);
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

  // A request to change something wins outright, before anything else is considered.
  // "hi, can you add a test" is a task, and treating it as a greeting would drop the
  // request on the floor — the one outcome this module must never produce.
  if (MUTATING_VERB.test(message)) {
    return { intent: 'task', reason: 'asks for a change' };
  }

  // Checked ahead of the broader work-verb rule, and only now that a mutating request
  // has been ruled out. These three are about the assistant and the conversation, and
  // they routinely contain a word from `WORK_VERB` while asking for no work at all:
  // "can you *verify* our conversation, where are we currently right now?" spent its
  // whole budget re-reading one file because `verify` claimed it first.
  if (ABOUT_THE_PROGRESS.test(message)) {
    return { intent: 'chat', reason: 'asks where the work has got to' };
  }

  if (ABOUT_THE_CONVERSATION.test(message)) {
    return { intent: 'chat', reason: 'asks about the conversation' };
  }

  if (ABOUT_THE_ASSISTANT.test(message) || PERSONAL_STATE.test(message)) {
    return { intent: 'chat', reason: 'asks about the assistant' };
  }

  // Ahead of the work-verb rule for the same reason as the three above: "what version
  // are you" has no verb, but "can you check what version you are" does, and both are
  // the same question about the same thing — which is not in the workspace.
  if (ABOUT_THE_VERSION.test(message)) {
    return { intent: 'chat', reason: 'asks which version the assistant is' };
  }

  if (ASKS_FOR_BANTER.test(message)) {
    return { intent: 'chat', reason: 'asks for a joke' };
  }

  // Reading, explaining, searching: no change, but real work that needs the tools.
  if (WORK_VERB.test(message)) {
    return { intent: 'task', reason: 'contains an instruction' };
  }

  // A path with no verb is still almost always about doing something to it.
  if (NAMES_A_FILE.test(message)) {
    return { intent: 'task', reason: 'names a file or path' };
  }

  // The whole message, not its opening. A greeting in front of a sentence is a polite
  // request, and the one thing this must never do is answer the greeting and drop the
  // request.
  if (isPurelySocial(message)) {
    return { intent: 'chat', reason: 'nothing but pleasantries' };
  }

  if (isGreetingWithName(message)) {
    return { intent: 'chat', reason: 'a greeting with a name on it' };
  }

  // Last, and deliberately after the verb and file rules: "I'm adding a route" and
  // "I'm looking at src/app.js" are work with a pronoun in front, and they have already
  // been claimed above. What reaches here is an introduction with nothing else in it.
  if (isIntroduction(message)) {
    return { intent: 'chat', reason: 'someone introducing themselves' };
  }

  return { intent: 'task', reason: 'no conversational signal' };
}

module.exports = {
  classify,
  requiresChange,
  isReadOnlyRequest,
  isIntroduction,
  COMPREHENSION_VERB,
  EXECUTION_VERB,
  ABOUT_THE_VERSION,
  INTRODUCES_SELF,
  ASKS_FOR_BANTER,
  isPurelySocial,
  isGreetingWithName,
  WORK_VERB,
  MUTATING_VERB,
  PLANNED_DELIVERABLE_VERB,
  NAMES_A_FILE,
  SOCIAL_WORDS,
  ASSENT_WORDS,
  ABOUT_THE_ASSISTANT,
  ABOUT_THE_CONVERSATION,
  ABOUT_THE_PROGRESS,
  PERSONAL_STATE,
};
