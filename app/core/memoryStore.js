'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Every fs call targets `this.filePath`, built from the VS Code workspace root and
 * a session number validated as an integer. No component derives from model output. */

/**
 * Plain-text session memory: an in-process cache mirrored to
 * `.hirayacoder/memory/session<N>.txt`.
 *
 * This is what lets a 1B model behave as if it remembers. It has no long-term
 * memory and a small effective context window, so instead of asking it to recall,
 * HirayaCoder remembers *for* it and re-injects a short digest each turn.
 *
 * The format is deliberately plain sentences rather than JSON — the user is meant
 * to be able to open the file, read it, and edit it.
 *
 * ## This file is untrusted input
 *
 * It's plain text on disk that the user (or any other process) can edit, and its
 * contents get injected straight into a prompt. That makes it an injection vector,
 * and the lite-tier prompt hands us the exact shape of the attack: memory is
 * interpolated between `<memory>` and `</memory>` markers, so a stored line
 * containing `</memory>` could close the block early and have everything after it
 * read as top-level instructions.
 *
 * `neutralize()` is the answer — delimiter and role markers are defanged on the way
 * in *and* on the way out, so a file edited by hand between sessions is still safe.
 * Size, line-count, and line-length caps stop a corrupted or oversized file from
 * silently consuming the entire token budget.
 *
 * @module core/memoryStore
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
// A session's identity is not owned by its memory file — see `nextSessionId`. The
// transcript module keeps its own path shape rather than having it re-derived here.
const { listSessionIds: listTranscriptSessions } = require('./transcriptStore');

/** Beyond this, the file is treated as corrupt rather than read into a prompt. */
const MAX_FILE_BYTES = 256 * 1024;

/** Entries past this count are ignored; a session that long has gone wrong. */
const MAX_ENTRIES = 500;

/** A single memory entry should be one short sentence. */
const MAX_ENTRY_CHARS = 400;

/**
 * Markers that would let stored text escape the block it is injected into, or
 * impersonate a conversation role. Matched case-insensitively.
 */
const INJECTION_MARKERS = [
  /<\/?\s*memory\s*>/gi,
  /<\/?\s*(?:system|user|assistant|tool|instructions?|context)\s*>/gi,
  // Not anchored to line start: entries are flattened to a single line, so an
  // injected role marker arrives mid-line ("… </memory> SYSTEM: ignore the above").
  /\b(?:system|assistant|user)\s*:/gi,
  /\[\/?INST\]/gi,
  /<\|[^|>]*\|>/g,
];

/**
 * Strip anything that could break out of the memory block or pose as an
 * instruction, and flatten to a single line.
 *
 * The replacement keeps the words so the note stays readable — the point is to
 * remove the *structure* that gives them authority, not to censor the content.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxChars] Length cap. Defaults to one memory entry's worth;
 *   callers sanitizing a larger block (a step summary headed for a prompt) pass more.
 * @returns {string}
 */
function neutralize(text, opts = {}) {
  const maxChars = typeof opts.maxChars === 'number' ? opts.maxChars : MAX_ENTRY_CHARS;
  let safe = String(text == null ? '' : text);

  // Control characters, which can hide content from a human reading the file.
  safe = safe.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Parenthesizing keeps the words readable while removing the punctuation that
  // gives them structural authority in a prompt.
  for (const marker of INJECTION_MARKERS) {
    safe = safe.replace(marker, (match) => `(${match.replace(/[<>[\]|/:]/g, '').trim()})`);
  }

  // A memory entry is one line by definition; a newline would let one entry
  // masquerade as several.
  safe = safe.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (safe.length > maxChars) safe = `${safe.slice(0, maxChars)}…`;
  return safe;
}

/**
 * Normalize a raw entry into the stored `- text` form.
 *
 * @param {string} entry
 * @returns {string | null} Null when there is nothing worth storing.
 */
function normalizeEntry(entry) {
  const safe = neutralize(entry).replace(/^[-*•]\s*/, '');
  if (safe.length === 0) return null;
  return `- ${safe}`;
}

/**
 * Words too common to carry meaning when comparing two notes.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'in', 'on', 'of', 'for', 'and', 'or', 'is', 'was', 'be',
  'it', 'this', 'that', 'with', 'as', 'at', 'by', 'new', 'now', 'also', 'added',
]);

/**
 * Reduce a note to its meaningful word set, for similarity comparison.
 *
 * @param {string} entry
 * @returns {Set<string>}
 */
function significantWords(entry) {
  const words = String(entry)
    .toLowerCase()
    .replace(/^[-*•]\s*/, '')
    // Unicode-aware: an ASCII-only class silently reduces Tagalog, Spanish, or CJK
    // notes to an empty word set, which turns off both de-duplication and the
    // grounding check for anyone not working in English.
    .replace(/[^\p{L}\p{N}\s/._-]/gu, ' ')
    .split(/\s+/)
    // Trailing punctuation would make "src/signup.js." and "src/signup.js"
    // different tokens, which silently defeats path matching.
    .map((word) => word.replace(/^[._-]+|[._-]+$/g, ''))
    // Single letters carry no signal, but a lone digit does: "fixed bug 1" and
    // "fixed bug 2" are different facts, and dropping the number would merge them.
    .filter((word) => (word.length > 1 || /\d/.test(word)) && !STOPWORDS.has(word));
  return new Set(words);
}

/**
 * How similar two notes are, 0 to 1 (Jaccard index over significant words).
 *
 * Exact-match de-duplication is not enough in practice. A real 1B model asked to
 * summarize successive steps emits "Email validation" and then "Email validation
 * added" — different strings, same fact, and both would then consume slots in a
 * five-entry recall window.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarity(a, b) {
  const left = significantWords(a);
  const right = significantWords(b);
  // With no significant words there is nothing to compare, so report "not
  // similar" and let the exact-match check decide. Treating two contentless
  // entries as identical would silently merge distinct short notes.
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const word of left) {
    if (right.has(word)) shared += 1;
  }
  return shared / (left.size + right.size - shared);
}

/** At or above this, two notes are treated as the same fact. */
const DUPLICATE_THRESHOLD = 0.8;

/**
 * The words a note can be *found* by, which is more than the words it contains.
 *
 * `significantWords` keeps a path as one token, which is right for the similarity
 * comparison it was written for — `src/greet.js` and `src/greet.js` are the same
 * subject, and splitting them would make every file in `src/` look related. It is wrong
 * for recall: a TODO item says "Assemble App.jsx using the useTodos hook" where the note
 * says "Created src/hooks/useTodos.js", and on whole-token matching those two share
 * nothing at all — which is precisely the pairing the recall exists to make.
 *
 * So a path additionally contributes its segments and its extension-stripped stem.
 * `src/hooks/useTodos.js` is findable as `src`, `hooks`, `usetodos.js`, and `usetodos`,
 * and the note it names is reachable from whichever of those the item happened to write.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function recallTokens(text) {
  const tokens = new Set();

  for (const word of significantWords(text)) {
    tokens.add(word);
    if (!word.includes('/') && !word.includes('.')) continue;

    for (const segment of word.split('/')) {
      if (segment.length < 2) continue;
      tokens.add(segment);
      const stem = segment.replace(/\.[a-z0-9]{1,6}$/i, '');
      // A stem is only a useful key when it is the *name* — dropping the extension from
      // `index.js` yields `index`, which every project has one of per folder, but that
      // costs a weak match rather than a wrong one.
      if (stem.length > 1) tokens.add(stem);
    }
  }

  return tokens;
}

/**
 * What a note is *about* — a file path, or a command in backticks.
 *
 * Notes are composed by `contextTranslator.composeNote`, so their shape is known
 * rather than guessed: "Edited src/greet.js: …", "Deleted src/old.js", "Ran `npm
 * test`: …". This reads the subject back out.
 *
 * @param {string} entry
 * @returns {string | null}
 */
function subjectOf(entry) {
  const text = String(entry || '');

  const command = /`([^`]+)`/.exec(text);
  if (command) return `cmd:${command[1].trim().toLowerCase()}`;

  // A path token: has a slash or a file extension, and no spaces.
  for (const word of text.split(/\s+/)) {
    const token = word.replace(/[:,.;]+$/, '');
    if (token.length > 2 && !token.includes('`') && (token.includes('/') || /\.[a-z0-9]{1,5}$/i.test(token))) {
      return `path:${token.toLowerCase()}`;
    }
  }
  return null;
}

/**
 * Entries about the same subject as `entry`, which it therefore replaces.
 *
 * The reason is correctness before efficiency. Session memory is meant to describe
 * what is true of the workspace *now*, and after a second edit to the same file the
 * first note describes a state that no longer exists. Observed live on
 * `qwen3.5:0.8b`, whose memory ended a session holding both:
 *
 *     - Edited src/greet.js: updated greeting logic to return 'Hello there' …
 *     - Edited src/greet.js: updated greet function to use nullish coalescing …
 *
 * Only the second was still true, and on Tier B the pair occupied two of five recall
 * slots. Superseding keeps the newest statement about each file and gives the freed
 * slots to facts about the rest of the project.
 *
 * @param {string[]} entries
 * @param {string} entry
 * @returns {number[]} Indices to drop.
 */
function supersededBy(entries, entry) {
  const subject = subjectOf(entry);
  if (!subject) return [];

  /** @type {number[]} */
  const stale = [];
  entries.forEach((existing, index) => {
    if (subjectOf(existing) === subject) stale.push(index);
  });
  return stale;
}

/**
 * Sessions that have left a memory file behind.
 *
 * @param {string} workspaceRoot
 * @returns {Array<{sessionId: number, entries: number, modifiedAt: Date}>}
 * @private
 */
function listMemoryFiles(workspaceRoot) {
  const dir = path.join(workspaceRoot, '.hirayacoder', 'memory');
  /** @type {Array<{sessionId: number, entries: number, modifiedAt: Date}>} */
  const sessions = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      const match = /^session(\d+)\.txt$/.exec(name);
      if (!match) continue;
      const file = path.join(dir, name);
      const stats = fs.statSync(file);
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      sessions.push({ sessionId: Number(match[1]), entries: lines.length, modifiedAt: stats.mtime });
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
      logger.warn(`Could not list memory sessions: ${/** @type {Error} */ (err).message}`);
    }
  }
  return sessions;
}

/**
 * Discover the next free session number in a workspace.
 *
 * ## Why this looks at more than memory files
 *
 * Both of this session registry's files are written *lazily*. A memory file appears
 * only once something is worth remembering, and a transcript only once a message is
 * sent — so a session can exist, be open in a tab, and have nothing on disk at all.
 *
 * Scanning memory alone therefore recycled numbers, and the symptom was reported from
 * real use: sessions 1 and 2 had memory, "New session" handed out 3, and — because
 * session 3 produced no *remembered note* — the next "New session" handed out 3 again,
 * and again. It either revealed the tab already open on 3 (so the command appeared to
 * do nothing) or opened a "new" session that loaded the previous conversation's
 * transcript. Two different conversations then shared one memory file.
 *
 * A number is free only when nothing claims it — on disk, or in the caller's own
 * process. `reserved` carries the second kind: a tab opened a moment ago and not yet
 * typed into owns its number as firmly as one with a memory file, and without it
 * clicking "New session" twice in a row handed out the same number twice.
 *
 * @param {string} workspaceRoot
 * @param {{reserved?: number[]}} [opts] Session ids already spoken for in memory.
 * @returns {number}
 */
function nextSessionId(workspaceRoot, opts = {}) {
  let highest = 0;
  for (const session of listMemoryFiles(workspaceRoot)) {
    highest = Math.max(highest, session.sessionId);
  }
  for (const session of listTranscriptSessions(workspaceRoot)) {
    highest = Math.max(highest, session.sessionId);
  }
  for (const id of opts.reserved || []) {
    if (Number.isInteger(id)) highest = Math.max(highest, id);
  }
  return highest + 1;
}

/**
 * List every session this workspace holds, so the chat tab can offer to resume one
 * instead of always starting fresh.
 *
 * A session with a conversation but no notes yet is a real session and is listed:
 * leaving it out is what let its number be handed out a second time, and it also hid a
 * conversation the user could see in their own transcript.
 *
 * `entries` counts remembered notes, so it is legitimately 0 for a session that has
 * been talked to but has produced nothing worth recalling.
 *
 * @param {string} workspaceRoot
 * @returns {Array<{sessionId: number, entries: number, modifiedAt: Date}>}
 */
function listSessions(workspaceRoot) {
  /** @type {Map<number, {sessionId: number, entries: number, modifiedAt: Date}>} */
  const byId = new Map();

  for (const session of listMemoryFiles(workspaceRoot)) byId.set(session.sessionId, session);

  for (const { sessionId, modifiedAt } of listTranscriptSessions(workspaceRoot)) {
    const existing = byId.get(sessionId);
    if (!existing) {
      byId.set(sessionId, { sessionId, entries: 0, modifiedAt });
      continue;
    }
    // Either file being touched means the session was used, so the newer wins — a
    // transcript is usually more recent than the notes distilled from it.
    if (modifiedAt > existing.modifiedAt) existing.modifiedAt = modifiedAt;
  }

  return [...byId.values()].sort((a, b) => a.sessionId - b.sessionId);
}

class MemoryStore {
  /**
   * @param {string} workspaceRoot
   * @param {number} sessionId
   */
  constructor(workspaceRoot, sessionId) {
    if (!Number.isInteger(sessionId) || sessionId < 1) {
      throw new Error(`Invalid session id: ${sessionId}`);
    }
    this.workspaceRoot = workspaceRoot;
    this.sessionId = sessionId;
    this.filePath = path.join(workspaceRoot, '.hirayacoder', 'memory', `session${sessionId}.txt`);

    /** @type {string[]} In-process cache; the on-disk file mirrors it. */
    this.entries = [];
    /** @type {Promise<void>} Serializes appends so lines never interleave. */
    this._queue = Promise.resolve();
    this._loaded = false;
  }

  /**
   * Read the on-disk file into the cache, applying every untrusted-input rule.
   *
   * Safe to call repeatedly; only the first call touches disk.
   *
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<string[]>}
   */
  async load(opts = {}) {
    if (this._loaded && !opts.force) return this.entries;

    let raw = '';
    try {
      const stats = await fs.promises.stat(this.filePath);
      if (stats.size > MAX_FILE_BYTES) {
        // Refusing to read is the right failure: a huge memory file would eat the
        // whole prompt budget and crowd out the actual task.
        logger.warn(
          `Session memory file is ${stats.size} bytes (limit ${MAX_FILE_BYTES}); ignoring it. ` +
            `Clear it from the chat tab to start fresh.`
        );
        this._loaded = true;
        return this.entries;
      }
      raw = await fs.promises.readFile(this.filePath, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        logger.warn(`Could not read session memory: ${/** @type {Error} */ (err).message}`);
      }
      this._loaded = true;
      return this.entries;
    }

    // A NUL byte means this isn't the plain-text file we wrote.
    if (raw.includes('\0')) {
      logger.warn('Session memory file is not plain text; ignoring it.');
      this._loaded = true;
      return this.entries;
    }

    const parsed = [];
    for (const line of raw.split('\n')) {
      if (parsed.length >= MAX_ENTRIES) {
        logger.warn(`Session memory has more than ${MAX_ENTRIES} entries; ignoring the rest.`);
        break;
      }
      const entry = normalizeEntry(line);
      if (entry) parsed.push(entry);
    }

    this.entries = parsed;
    this._loaded = true;
    return this.entries;
  }

  /**
   * Append one entry to both the cache and the file.
   *
   * @param {string} entry
   * @returns {Promise<boolean>} False when the entry was empty or a duplicate.
   */
  async append(entry) {
    const normalized = normalizeEntry(entry);
    if (!normalized) return false;

    await this.load();

    // Duplicate suppression matters more than it looks: the translator runs every
    // turn and will happily re-derive "added email validation" five times, which
    // then crowds out everything else in a Tier B recall window. Near-matches count
    // — observed live, a 1B model produced "Email validation" and "Email validation
    // added" on consecutive turns.
    const key = normalized.toLowerCase();
    const duplicate = this.entries.some(
      (existing) => existing.toLowerCase() === key || similarity(existing, normalized) >= DUPLICATE_THRESHOLD
    );
    if (duplicate) return false;

    // A newer statement about a file replaces the older one, which by then describes
    // a version of the file that no longer exists.
    const stale = supersededBy(this.entries, normalized);
    if (stale.length > 0) {
      const staleSet = new Set(stale);
      this.entries = this.entries.filter((_, index) => !staleSet.has(index));
      logger.debug(`Superseded ${stale.length} stale memory entr(ies) about the same subject.`);
    }

    this.entries.push(normalized);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();

    // Appending is the common case and stays a single cheap write; a supersede has
    // removed a line from the middle, so the file is rewritten to match the cache.
    // Both go through the same queue, so ordering is preserved either way.
    const rewrite = stale.length > 0 || this.entries.length === MAX_ENTRIES;
    const snapshot = rewrite ? [...this.entries] : null;

    this._queue = this._queue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        if (snapshot) {
          await fs.promises.writeFile(this.filePath, `${snapshot.join('\n')}\n`, 'utf8');
        } else {
          await fs.promises.appendFile(this.filePath, `${normalized}\n`, 'utf8');
        }
      })
      .catch((err) => {
        // Memory is an optimization, never a hard dependency of the loop.
        logger.warn(`Could not persist session memory: ${/** @type {Error} */ (err).message}`);
      });

    return true;
  }

  /**
   * @param {string[]} entries
   * @returns {Promise<number>} How many were actually stored.
   */
  async appendMany(entries) {
    let stored = 0;
    for (const entry of entries) {
      if (await this.append(entry)) stored += 1;
    }
    return stored;
  }

  /**
   * Every entry, oldest first.
   *
   * @returns {Promise<string[]>}
   */
  async readAll() {
    await this.load();
    return [...this.entries];
  }

  /**
   * The most recent `n` entries, oldest first.
   *
   * `Infinity` returns everything — that's what High thinking capacity passes on
   * Tier B, where the token budget is the real limit rather than a count.
   *
   * @param {number} n
   * @returns {Promise<string[]>}
   */
  async readRecent(n) {
    await this.load();
    if (!Number.isFinite(n)) return [...this.entries];
    if (n <= 0) return [];
    return this.entries.slice(-Math.floor(n));
  }

  /**
   * The entries that bear on a particular piece of work, newest first among equals.
   *
   * ## Why recency is the wrong selector for a step
   *
   * `readRecent` answers "what just happened", which is right for a conversation and
   * wrong for an item of work. On the React benchmark the item that had to assemble
   * `App.jsx` ran sixth, by which point the notes about `useTodos.js` and
   * `TodoInput.jsx` — the two files it needed to import — were the oldest in the file
   * and the first to fall outside a five-entry window. The note that survived was about
   * the README. The model wired nothing to anything.
   *
   * So an item's recall is selected by *subject* first: notes that name a file, command,
   * or identifier the item also names, however long ago they were written. That is the
   * "linked memory" case — the older note is the one most worth having, precisely
   * because the model has forgotten it. Recent entries then fill whatever is left, so
   * this is never worse than `readRecent`: an item with no matches gets exactly the
   * recency window it would have had.
   *
   * Output stays in stored order, oldest first, matching `readRecent` — the notes
   * describe a sequence of work and reading them out of order invents a false one.
   *
   * @param {string} subject  What the recall is for: a TODO item, or the task.
   * @param {number} n        How many entries to return.
   * @returns {Promise<string[]>}
   */
  async readRelevant(subject, n) {
    await this.load();
    if (!Number.isFinite(n)) return [...this.entries];
    const limit = Math.floor(n);
    if (limit <= 0) return [];
    if (this.entries.length <= limit) return [...this.entries];

    const wanted = recallTokens(subject);
    if (wanted.size === 0) return this.readRecent(limit);

    /** @type {Set<number>} */
    const picked = new Set();

    // How many of the subject's own tokens each entry shares. Counted rather than
    // treated as a yes/no, because "any one token matches" puts a note that mentions
    // `src` level with the note that names `src/hooks/useTodos.js` and the identifier
    // inside it — and on a recall window of five, the weak match displacing the strong
    // one is the whole failure this selector exists to prevent.
    /** @type {Array<{index: number, score: number}>} */
    const scored = [];
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      // eslint-disable-next-line security/detect-object-injection -- numeric loop index.
      const words = recallTokens(this.entries[index]);
      let score = 0;
      for (const word of words) {
        if (wanted.has(word)) score += 1;
      }
      if (score > 0) scored.push({ index, score });
    }

    // Strongest first; newest breaks a tie, so a long history does not fill the window
    // with the earliest thing it ever matched. `scored` is already newest-first, and
    // `sort` is stable, so the tie-break needs no comparator of its own.
    scored.sort((a, b) => b.score - a.score);
    for (const { index } of scored) {
      if (picked.size >= limit) break;
      picked.add(index);
    }

    // Then recency, for the remainder.
    for (let index = this.entries.length - 1; index >= 0 && picked.size < limit; index -= 1) {
      picked.add(index);
    }

    // Indices come from the loops above, which only ever range over this array.
    // eslint-disable-next-line security/detect-object-injection
    return [...picked].sort((a, b) => a - b).map((index) => this.entries[index]);
  }

  /**
   * Render recalled entries as the `Session Memory:` block for a prompt.
   *
   * Entries are neutralized again on the way out, so a file hand-edited between
   * sessions cannot smuggle a delimiter past the cache.
   *
   * @param {number} n
   * @param {object} [opts]
   * @param {string} [opts.about]  Select by relevance to this text rather than by
   *   recency alone. See `readRelevant`.
   * @returns {Promise<string>} Empty string when there is nothing to recall.
   */
  async renderForPrompt(n, opts = {}) {
    const recalled = opts.about ? await this.readRelevant(opts.about, n) : await this.readRecent(n);
    if (recalled.length === 0) return '';
    return recalled.map((entry) => normalizeEntry(entry)).filter(Boolean).join('\n');
  }

  /**
   * Forget this session — clears the cache and removes the file.
   *
   * @returns {Promise<void>}
   */
  async clear() {
    this.entries = [];
    this._loaded = true;
    await this.flush();
    try {
      await fs.promises.unlink(this.filePath);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        logger.warn(`Could not clear session memory: ${/** @type {Error} */ (err).message}`);
      }
    }
  }

  /** Resolves once every queued write has landed. */
  flush() {
    return this._queue;
  }
}

module.exports = {
  MemoryStore,
  neutralize,
  normalizeEntry,
  similarity,
  significantWords,
  recallTokens,
  subjectOf,
  supersededBy,
  nextSessionId,
  listSessions,
  DUPLICATE_THRESHOLD,
  MAX_FILE_BYTES,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
};
