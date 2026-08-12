'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * The directory is resolved and confined by permissionGate → pathGuard; traversal
 * below it stays inside that resolved root. */

/**
 * List what exists in the workspace.
 *
 * This is how an agent finds files it was never told about — the capability the
 * acceptance criteria call for ("read files it wasn't given the path to"). It is
 * therefore tuned for orientation rather than completeness: noisy directories are
 * skipped, depth is bounded, and the output is capped, because a 1B model handed
 * 4,000 paths has learned nothing and lost its context window.
 *
 * @module agent/tools/listFiles
 */

const fs = require('fs');
const path = require('path');

const { toPosixPath } = require('../../utils/platform');

/** Directories that are never interesting to an agent and enormous when walked. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.hirayacoder', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target', 'vendor',
  '.vscode-test', '.idea',
]);

const MAX_ENTRIES = 200;
const MAX_DEPTH = 3;

/**
 * @param {{path?: string}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function listFiles(args, context) {
  const requested = args && args.path ? args.path : '.';

  const decision = await context.gate.requestRead({
    path: requested,
    sessionId: context.sessionId,
    mode: context.mode,
  });
  if (!decision.allowed) {
    return { ok: false, observation: `Could not list ${requested}: ${decision.reason}`, error: decision.code };
  }

  const root = decision.resolved;

  try {
    const stats = await fs.promises.stat(root.absolute);
    if (!stats.isDirectory()) {
      return { ok: false, observation: `${root.relative || '.'} is a file, not a folder. Use read_file for it.` };
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { ok: false, observation: `The folder ${root.relative || '.'} does not exist.`, error: 'ENOENT' };
    }
    return { ok: false, observation: `Could not list ${root.relative}: ${/** @type {Error} */ (err).message}` };
  }

  /** @type {string[]} */
  const entries = [];
  let truncated = false;
  let skippedDirectories = 0;

  /**
   * @param {string} absolute
   * @param {string} relative
   * @param {number} depth
   */
  async function walk(absolute, relative, depth) {
    if (entries.length >= MAX_ENTRIES) {
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

    // Files before folders, alphabetically — a stable order helps a small model
    // that is re-reading this listing across turns.
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }

      const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        if (SKIP_DIRECTORIES.has(dirent.name)) {
          skippedDirectories += 1;
          continue;
        }
        entries.push(`${childRelative}/`);
        if (depth < MAX_DEPTH) {
          await walk(path.join(absolute, dirent.name), childRelative, depth + 1);
        }
      } else if (dirent.isFile()) {
        entries.push(childRelative);
      }
    }
  }

  await walk(root.absolute, root.relative, 0);

  if (entries.length === 0) {
    return { ok: true, observation: `${root.relative || 'The workspace root'} is empty.`, detail: { entries: [] } };
  }

  const label = root.relative || 'workspace root';
  const notes = [];
  if (truncated) notes.push(`only the first ${MAX_ENTRIES} entries`);
  if (skippedDirectories > 0) notes.push(`${skippedDirectories} build/dependency folder(s) skipped`);
  const suffix = notes.length > 0 ? ` (${notes.join(', ')})` : '';

  return {
    ok: true,
    observation: `Files under ${label}${suffix}:\n${entries.map(toPosixPath).join('\n')}`,
    detail: { entries, truncated },
  };
};
