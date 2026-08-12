'use strict';

/**
 * Token estimation and budget allocation.
 *
 * There is no tokenizer dependency here on purpose — shipping one would mean a
 * multi-megabyte vocabulary file per model family, and every model HirayaCoder
 * talks to tokenizes differently anyway. What matters for a 1B model with a
 * ~2000-token working budget is not being *exact*, it's never *under*-estimating:
 * an over-estimate wastes a little context, an under-estimate silently truncates
 * the tail of the prompt inside Ollama and the model answers about half a file.
 *
 * So `estimateTokens` deliberately takes the maximum of two heuristics and adds a
 * margin. It should read slightly high, especially on code.
 *
 * @module utils/tokenBudget
 */

/** Average characters per token for prose. Code runs denser, hence the second heuristic. */
const CHARS_PER_TOKEN = 3.5;

/** Safety margin applied to every estimate. */
const MARGIN = 1.1;

/**
 * Estimate the token count of a string, erring high.
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;

  const byChars = text.length / CHARS_PER_TOKEN;
  // Words and standalone punctuation each cost roughly a token; punctuation-heavy
  // code (`}`, `);`, `=>`) is where the character heuristic under-counts most.
  const pieces = text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g);
  const byPieces = pieces ? pieces.length : 0;

  return Math.ceil(Math.max(byChars, byPieces) * MARGIN);
}

/**
 * Trim text to fit a token budget.
 *
 * For a long file, cutting only the tail loses the imports and the exports at once.
 * `keep: 'both'` preserves the head and tail with a visible elision, which keeps a
 * file's shape legible to the model.
 *
 * @param {string} text
 * @param {number} maxTokens
 * @param {object} [opts]
 * @param {'head' | 'tail' | 'both'} [opts.keep] Default 'head'.
 * @param {string} [opts.marker]
 * @returns {{text: string, truncated: boolean, originalTokens: number}}
 */
function truncateToTokens(text, maxTokens, opts = {}) {
  const source = typeof text === 'string' ? text : '';
  const originalTokens = estimateTokens(source);
  if (originalTokens <= maxTokens || maxTokens <= 0) {
    return { text: source, truncated: originalTokens > maxTokens, originalTokens };
  }

  const keep = opts.keep || 'head';
  const marker = opts.marker || '\n… [trimmed to fit the context budget] …\n';
  const markerTokens = estimateTokens(marker);
  const usable = Math.max(0, maxTokens - markerTokens);
  // Invert the character heuristic to get an approximate character budget.
  const charBudget = Math.floor((usable * CHARS_PER_TOKEN) / MARGIN);

  if (charBudget <= 0) return { text: marker.trim(), truncated: true, originalTokens };

  let result;
  if (keep === 'tail') {
    result = marker + source.slice(-charBudget);
  } else if (keep === 'both') {
    const half = Math.floor(charBudget / 2);
    result = source.slice(0, half) + marker + source.slice(-half);
  } else {
    result = source.slice(0, charBudget) + marker;
  }

  return { text: result, truncated: true, originalTokens };
}

/**
 * @typedef {object} Section
 * @property {string} name
 * @property {string} content
 * @property {number} priority   Higher survives longer. Ties keep declaration order.
 * @property {number} [minTokens] Floor below which the section is dropped entirely.
 * @property {'head' | 'tail' | 'both'} [keep]
 */

/**
 * @typedef {object} AllocationResult
 * @property {Array<{name: string, content: string, tokens: number, truncated: boolean, dropped: boolean}>} sections
 * @property {number} totalTokens
 * @property {number} budget
 * @property {string[]} notes    Human-readable record of what was cut, for the UI.
 */

/**
 * Fit a set of prompt sections into a token budget.
 *
 * Sections are satisfied in priority order. When the budget runs out, lower-priority
 * sections are truncated, and dropped entirely if what remains would fall under
 * their `minTokens` floor — half a memory block is worse than none, because the
 * model can't tell it's reading a fragment.
 *
 * Output preserves the caller's original section order regardless of priority, so
 * the prompt reads the way it was written.
 *
 * @param {Section[]} sections
 * @param {number} budget
 * @returns {AllocationResult}
 */
function allocate(sections, budget) {
  const order = sections.map((section, index) => ({ section, index }));
  const byPriority = [...order].sort((a, b) => b.section.priority - a.section.priority || a.index - b.index);

  /** @type {Map<number, {name: string, content: string, tokens: number, truncated: boolean, dropped: boolean}>} */
  const results = new Map();
  /** @type {string[]} */
  const notes = [];
  let remaining = Math.max(0, budget);

  for (const { section, index } of byPriority) {
    const tokens = estimateTokens(section.content);

    if (tokens <= remaining) {
      remaining -= tokens;
      results.set(index, { name: section.name, content: section.content, tokens, truncated: false, dropped: false });
      continue;
    }

    const floor = section.minTokens || 0;
    if (remaining < floor || remaining <= 0) {
      results.set(index, { name: section.name, content: '', tokens: 0, truncated: false, dropped: true });
      notes.push(`${section.name} omitted — no room in the context budget.`);
      continue;
    }

    const trimmed = truncateToTokens(section.content, remaining, { keep: section.keep });
    const usedTokens = estimateTokens(trimmed.text);
    remaining = Math.max(0, remaining - usedTokens);
    results.set(index, { name: section.name, content: trimmed.text, tokens: usedTokens, truncated: true, dropped: false });
    notes.push(`${section.name} trimmed to fit (was ~${trimmed.originalTokens} tokens).`);
  }

  const ordered = order.map(({ index }) => results.get(index));
  return {
    sections: /** @type {any} */ (ordered),
    totalTokens: ordered.reduce((sum, entry) => sum + (entry ? entry.tokens : 0), 0),
    budget,
    notes,
  };
}

module.exports = {
  estimateTokens,
  truncateToTokens,
  allocate,
  CHARS_PER_TOKEN,
  MARGIN,
};
