'use strict';

/**
 * Loads model-facing prompts from `setup/prompts/*.md`.
 *
 * Those files mix explanation for the human reader with the actual prompt in a
 * fenced code block. The fenced block is the prompt; everything around it is
 * commentary the model must never see. This module extracts the first fence and
 * caches it.
 *
 * Keeping the prompts as editable markdown rather than string literals in code is
 * the point — the author can tune how the 1B model is instructed without touching
 * JavaScript, which is the single highest-leverage knob on Tier B behavior.
 *
 * Two consequences worth knowing:
 *  - `setup/prompts/` must ship inside the `.vsix` (see `.vscodeignore`), or the
 *    extension would fall back to the embedded defaults in production.
 *  - Every template has an embedded fallback, so a missing or malformed file
 *    degrades to a working prompt instead of a broken session.
 *
 * @module utils/promptLoader
 */

const fs = require('fs');
const path = require('path');

const logger = require('./logger');

/** `app/utils` → repo root → `setup/prompts`. */
const PROMPTS_DIR = path.join(__dirname, '..', '..', 'setup', 'prompts');

/** @type {Map<string, string>} */
const cache = new Map();

/**
 * Pull the first fenced code block out of a markdown document.
 *
 * @param {string} markdown
 * @returns {string | null}
 */
function extractFencedBlock(markdown) {
  // Non-greedy so the first fence wins, and tolerant of a language tag.
  const match = /```[^\n]*\n([\s\S]*?)```/.exec(markdown);
  // Normalize to LF: the prompt files are edited on Windows, and stray CRs would
  // otherwise inflate every token estimate and show up in the model's input.
  return match ? match[1].replace(/\r\n/g, '\n').trim() : null;
}

/**
 * Load a prompt template by file name.
 *
 * @param {string} fileName e.g. 'context-translator-prompt.md'
 * @param {string} fallback Used when the file is missing or has no fenced block.
 * @returns {string}
 */
function loadTemplate(fileName, fallback) {
  const cached = cache.get(fileName);
  if (cached) return cached;

  let template = null;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const raw = fs.readFileSync(path.join(PROMPTS_DIR, fileName), 'utf8');
    template = extractFencedBlock(raw);
    if (!template) {
      logger.warn(`${fileName} has no fenced prompt block; using the built-in default.`);
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      logger.warn(`${fileName} not found; using the built-in default.`);
    } else {
      logger.warn(`Could not read ${fileName}: ${/** @type {Error} */ (err).message}`);
    }
  }

  const resolved = template || fallback;
  cache.set(fileName, resolved);
  return resolved;
}

/**
 * Substitute `{placeholder}` tokens.
 *
 * Values are inserted literally — callers are responsible for having sanitized
 * anything model- or disk-sourced first (see `memoryStore.neutralize`).
 *
 * @param {string} template
 * @param {Record<string, string>} values
 * @returns {string}
 */
function render(template, values) {
  // A Map rather than direct indexing: placeholder names come from an editable
  // markdown file, and `{constructor}` would otherwise resolve to a prototype
  // member and splice a function body into the prompt.
  const lookup = new Map(Object.entries(values || {}));
  return String(template).replace(/\{(\w+)\}/g, (match, key) =>
    lookup.has(key) ? String(lookup.get(key)) : match
  );
}

/** Drop the cache — used by tests and after an author edits a prompt file. */
function clearCache() {
  cache.clear();
}

module.exports = { loadTemplate, render, extractFencedBlock, clearCache, PROMPTS_DIR };
