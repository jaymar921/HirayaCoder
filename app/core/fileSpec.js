'use strict';

/**
 * Work out which of a request's requirements are about *this* file.
 *
 * ## The measurement
 *
 * Splitting a long request by its headings and handing each section to the model as its
 * own step is a large improvement, and it is split along the wrong axis. Measured on the
 * benchmark brief:
 *
 * | Section | Files it writes | Graded behaviours it specifies |
 * |---|---|---|
 * | 3. Folder Structure | **15** | 0 |
 * | 4. Features | 0 | **~10 of 12** |
 * | 5. Design | 0 | the completed-state styling |
 *
 * So the step that writes `TodoItem.jsx` — the file that owns toggle, edit and delete —
 * was handed a 1,131-character prompt containing no mention of *Escape*, *blur*,
 * *double-click*, or `line-through`. Every one of those is a point the benchmark grades
 * and the model was never told about any of them.
 *
 * Chunking helps a small model because it cuts how many constraints must be satisfied at
 * once. Chunking along the wrong axis does not cut them, it **drops** them — which looks
 * like the same failure and is strictly worse, because no retry recovers a requirement
 * the model never saw.
 *
 * ## So the unit is the file, not the section
 *
 * The request's own words about a file are scattered: the tree says where it goes and
 * what it is for, the features section says what it must do, the design section says how
 * it must look. This module re-gathers them, by matching the words in a requirement
 * against the words in the file's name and its purpose comment.
 *
 * `TodoItem.jsx` with the purpose *"Single todo row (edit/delete/toggle)"* yields the
 * tokens `todo, item, single, row, edit, delete, toggle` — which is enough to pull
 * *"Delete Todo: remove a single todo…"* and *"Modify Todo: inline edit — double-click…
 * save on Enter/blur, cancel on Escape"* out of a section that names no files at all.
 *
 * It is all token matching. No inference, so it works at 0.8B, and it can be read and
 * checked by whoever is wondering why a file came out the way it did.
 *
 * @module core/fileSpec
 */

/**
 * Words too common to mean anything when matched.
 *
 * Kept small on purpose. A long stop-list starts removing real signal — "list", "form"
 * and "input" are exactly the words that connect a component to its requirement.
 */
const STOPWORDS = new Set([
  'a', 'all', 'an', 'and', 'app', 'are', 'as', 'at', 'be', 'by', 'component', 'components',
  'config', 'css', 'for', 'from', 'in', 'index', 'is', 'it', 'js', 'json', 'jsx', 'main', 'of',
  'on', 'or', 'src', 'the', 'to', 'ts', 'tsx', 'use', 'with',
]);

/** Shortest token worth matching on. Two-letter words carry no signal. */
const MIN_TOKEN = 3;

/** How much requirement text one file's brief may carry. */
const DEFAULT_MAX_CHARS = 900;

/**
 * Break an identifier into words: `TodoItem` → todo, item; `use-contacts` → contacts.
 *
 * @param {string} text
 * @returns {string[]}
 */
function words(text) {
  return String(text || '')
    // camelCase and PascalCase, split before each capital that follows a lower-case
    // letter, so `useTodos` yields `use` and `Todos` rather than one token nothing
    // matches.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= MIN_TOKEN && !STOPWORDS.has(word));
}

/**
 * Singular and plural collapse to the same token.
 *
 * Crude on purpose: `contacts` and `contact` must match, and a real stemmer would be a
 * dependency to make one comparison marginally better.
 *
 * @param {string} word
 * @returns {string}
 */
function stem(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/**
 * The vocabulary that identifies one file.
 *
 * @param {string} filePath
 * @param {string} [purpose]  The author's comment beside it in their folder tree.
 * @returns {Set<string>}
 */
function tokensFor(filePath, purpose) {
  const name = String(filePath || '').split('/').pop() || '';
  const stemOfName = name.replace(/\.[^.]*$/, '');
  return new Set([...words(stemOfName), ...words(purpose)].map(stem));
}

/**
 * Split requirement text into the units a requirement is actually written in.
 *
 * Bullets and numbered items, mostly. A paragraph with no list in it stays whole, which
 * is right — an unbulleted requirement is one thought.
 *
 * @param {string} text
 * @returns {string[]}
 */
function bulletsOf(text) {
  const lines = String(text || '').split(/\r?\n/);
  /** @type {string[]} */
  const chunks = [];
  let current = '';

  const startsItem = (line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line);

  for (const line of lines) {
    if (!line.trim()) {
      if (current.trim()) chunks.push(current.trim());
      current = '';
      continue;
    }
    if (startsItem(line)) {
      if (current.trim()) chunks.push(current.trim());
      current = line;
      continue;
    }
    // A continuation line belongs to the item above it.
    current = current ? `${current}\n${line}` : line;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/**
 * How much this chunk of requirement is about this file.
 *
 * @param {Set<string>} tokens
 * @param {string} chunk
 * @returns {number}
 */
function score(tokens, chunk) {
  if (tokens.size === 0) return 0;
  const seen = new Set(words(chunk).map(stem));
  let hits = 0;
  for (const token of tokens) {
    if (seen.has(token)) hits += 1;
  }
  return hits;
}

/**
 * A token common to most of the requirements tells you nothing about any one file.
 *
 * In the TODO brief the word is `todo`; in the contacts brief it is `contact`. It is in
 * every filename and every requirement, so matching on it scored every file against
 * every line and the selection stopped discriminating — five components each received
 * the same nine chunks, including the scaffold command.
 *
 * The subject of the project is exactly the word that cannot separate its parts.
 */
const UBIQUITOUS_SHARE = 0.6;

/** Below this many chunks, "common to most" is not a meaningful measurement. */
const MIN_CHUNKS_FOR_IDF = 5;

/**
 * Drop the tokens that appear in most of the chunks.
 *
 * @param {Set<string>} tokens
 * @param {string[]} chunks
 * @returns {Set<string>}
 */
function discriminating(tokens, chunks) {
  if (chunks.length < MIN_CHUNKS_FOR_IDF) return tokens;

  const seenPerChunk = chunks.map((chunk) => new Set(words(chunk).map(stem)));
  const kept = new Set();
  for (const token of tokens) {
    const appearances = seenPerChunk.filter((seen) => seen.has(token)).length;
    if (appearances / chunks.length <= UBIQUITOUS_SHARE) kept.add(token);
  }
  // If every token was ubiquitous the file has no distinguishing vocabulary at all, and
  // the original set is a better answer than an empty one.
  return kept.size > 0 ? kept : tokens;
}

/**
 * Is this the file the others are assembled into?
 *
 * The composition root is the one file that legitimately needs the whole feature list:
 * it is where every component is wired together, and it is the file that shipped Vite's
 * counter demo in both baseline runs that got as far as building. It also, by its
 * nature, shares no vocabulary with any individual requirement — `App.jsx` with the
 * purpose "Composes layout + components" matched **nothing** in the first version of
 * this module, which is precisely the wrong answer.
 *
 * @param {string} filePath
 * @param {string} [purpose]
 * @returns {boolean}
 */
function isComposition(filePath, purpose) {
  if (/\b(?:compos|assembl|layout|entry point|root component|wires? together)/i.test(String(purpose || ''))) {
    return true;
  }
  const name = String(filePath || '').split('/').pop() || '';
  return /^(?:app|main|index)\.(?:jsx?|tsx?|vue|svelte)$/i.test(name);
}

/**
 * The parts of a request's requirements that are about this file.
 *
 * Returns the chunks in the order the user wrote them — a requirement list is often
 * sequential, and reordering it by score would read as a different specification.
 *
 * @param {object} options
 * @param {string} options.path
 * @param {string} [options.purpose]
 * @param {string} [options.requirements]  Every section that asks for behaviour.
 * @param {number} [options.maxChars]
 * @returns {{text: string, matched: number, considered: number}}
 */
function forFile(options) {
  const requirements = String(options.requirements || '').trim();
  if (!requirements) return { text: '', matched: 0, considered: 0 };

  const chunks = bulletsOf(requirements);
  const maxChars = typeof options.maxChars === 'number' ? options.maxChars : DEFAULT_MAX_CHARS;
  const tokens = discriminating(tokensFor(options.path, options.purpose), chunks);

  const scored = chunks.map((chunk, index) => ({ chunk, index, hits: score(tokens, chunk) }));
  // The composition root gets everything, in order, up to the budget. It is the file the
  // rest are wired into, so "which requirement is this about" has the answer "all of
  // them" — and matching on vocabulary gives it none of them.
  //
  // For everything else, a single shared word is not a match. Where any chunk manages
  // two, one becomes the bar — otherwise the budget fills with lines that merely say
  // "todo" somewhere, and the scaffold command crowds out the sentence about Escape.
  // Where nothing reaches two, one is all there is and is taken.
  const best = scored.reduce((most, entry) => Math.max(most, entry.hits), 0);
  const cutoff = best >= 2 ? 2 : 1;
  const matching = isComposition(options.path, options.purpose)
    ? scored.map((entry) => ({ ...entry, hits: Math.max(entry.hits, 1) }))
    : scored.filter((entry) => entry.hits >= cutoff);
  if (matching.length === 0) return { text: '', matched: 0, considered: chunks.length };

  // Strongest first for *selection*, so a tight budget keeps the most relevant lines —
  // then back into document order for *presentation*.
  const chosen = [];
  let used = 0;
  for (const entry of [...matching].sort((a, b) => b.hits - a.hits || a.index - b.index)) {
    if (used + entry.chunk.length > maxChars && chosen.length > 0) continue;
    chosen.push(entry);
    used += entry.chunk.length;
  }
  chosen.sort((a, b) => a.index - b.index);

  return {
    text: chosen.map((entry) => entry.chunk).join('\n').slice(0, maxChars),
    matched: chosen.length,
    considered: chunks.length,
  };
}

module.exports = {
  forFile,
  tokensFor,
  bulletsOf,
  words,
  stem,
  score,
  discriminating,
  isComposition,
  STOPWORDS,
  DEFAULT_MAX_CHARS,
  MIN_TOKEN,
  UBIQUITOUS_SHARE,
};
