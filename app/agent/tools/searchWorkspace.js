'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Traversal starts from the gate-resolved workspace root and never leaves it. */

/**
 * Find a string across the workspace.
 *
 * A plain substring search, not a regex: the query comes from a model, and a
 * model-authored regex is both a correctness hazard (it rarely means what the model
 * thinks) and a denial-of-service one (catastrophic backtracking on a large tree).
 * Substring matching is predictable and fast, which is what an agent actually needs
 * to locate a symbol.
 *
 * @module agent/tools/searchWorkspace
 */

const fs = require('fs');
const path = require('path');

const { redact } = require('../../security/secretsScanner');

const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.hirayacoder', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target', 'vendor',
  '.vscode-test', '.idea',
]);

/** Skipped by extension — searching a minified bundle or an image wastes the budget. */
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.pdf', '.zip', '.gz',
  '.tar', '.exe', '.dll', '.so', '.dylib', '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.mov', '.lock', '.map', '.vsix',
]);

const MAX_MATCHES = 40;
const MAX_FILES_SCANNED = 2000;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_LINE_CHARS = 200;

/**
 * @param {{query: string}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function searchWorkspace(args, context) {
  const query = String(args.query || '').trim();
  if (query.length < 2) {
    return { ok: false, observation: 'Provide at least two characters to search for.' };
  }

  const decision = await context.gate.requestRead({
    path: '.',
    sessionId: context.sessionId,
    mode: context.mode,
  });
  if (!decision.allowed) {
    return { ok: false, observation: `Could not search the workspace: ${decision.reason}`, error: decision.code };
  }

  const root = decision.resolved.absolute;
  const needle = query.toLowerCase();
  const ignoreRules = context.gate ? context.gate.ignoreRules : null;

  /** @type {string[]} */
  const matches = [];
  let filesScanned = 0;
  let filesWithMatches = 0;
  let skippedSensitive = 0;
  let truncated = false;

  /**
   * @param {string} absolute
   * @param {string} relative
   */
  async function walk(absolute, relative) {
    if (matches.length >= MAX_MATCHES || filesScanned >= MAX_FILES_SCANNED) {
      truncated = true;
      return;
    }

    /** @type {fs.Dirent[]} */
    let dirents;
    try {
      dirents = await fs.promises.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (matches.length >= MAX_MATCHES || filesScanned >= MAX_FILES_SCANNED) {
        truncated = true;
        return;
      }

      const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
      const childAbsolute = path.join(absolute, dirent.name);

      if (dirent.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(dirent.name)) await walk(childAbsolute, childRelative);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (SKIP_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) continue;

      // A search returns matching *lines*, so a `.env` that matches the needle would
      // put its values straight into the prompt — past `read_file`'s new confirmation,
      // which only guards a whole-file read. Skipped rather than prompted: a search
      // touches hundreds of files, and a dialog per sensitive hit would be unusable and
      // would train the user to click through. `redact` is not enough on its own; it
      // recognises provider key formats, not `SECRET=value`.
      if (ignoreRules && ignoreRules.classify(childRelative).sensitive) {
        if (!ignoreRules.isGranted(childRelative)) {
          skippedSensitive += 1;
          continue;
        }
      }

      let content;
      try {
        const stats = await fs.promises.stat(childAbsolute);
        if (stats.size > MAX_FILE_BYTES) continue;
        content = await fs.promises.readFile(childAbsolute, 'utf8');
      } catch {
        continue;
      }

      filesScanned += 1;
      if (content.includes('\0')) continue;
      if (!content.toLowerCase().includes(needle)) continue;

      filesWithMatches += 1;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        // Numeric loop index into an array.
        // eslint-disable-next-line security/detect-object-injection
        if (!lines[i].toLowerCase().includes(needle)) continue;
        // Numeric loop index into an array.
        // eslint-disable-next-line security/detect-object-injection
        const line = lines[i].trim().slice(0, MAX_LINE_CHARS);
        matches.push(`${childRelative}:${i + 1}: ${redact(line)}`);
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(root, '');

  // Stated rather than silent. A model that searched for a variable name and got no
  // hits would otherwise conclude the project does not use it and act on that; told the
  // file was skipped, it can say so or ask.
  const skipped = skippedSensitive > 0 ? `\n${skippedSensitive} ignored or credential file(s) were not searched.` : '';

  if (matches.length === 0) {
    return {
      ok: true,
      observation: `No matches for "${query}" in ${filesScanned} files searched.${skipped}`,
      detail: { query, matches: [], filesScanned, skippedSensitive },
    };
  }

  const suffix = truncated ? `\n(showing the first ${matches.length} matches)` : '';
  return {
    ok: true,
    observation: `${matches.length} match(es) for "${query}" across ${filesWithMatches} file(s):\n${matches.join('\n')}${suffix}${skipped}`,
    detail: { query, matches, filesScanned, truncated, skippedSensitive },
  };
};
