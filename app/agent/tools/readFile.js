'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * The path is resolved and confined by permissionGate → pathGuard before any read,
 * and the absolute path used here comes from that guard, not from the model. */

/**
 * Read a workspace file into the agent's context.
 *
 * Reads need no confirmation, but they do go through the gate — path confinement,
 * symlink resolution, and the audit trail apply to every filesystem touch.
 *
 * ## A read carries what the file imports
 *
 * Reading `App.jsx` without `useTodos.js` tells the model that a hook is imported and
 * nothing about what it returns, so the next thing it must do is spend a turn reading
 * it — and then another, and another, once per import. On CPU inference that is minutes
 * of orientation before any work starts, and on the React benchmark the models never
 * finished paying it: `qwen3.5:4b` spent all 44 of its steps reading and listing, and
 * wrote nothing.
 *
 * So the imports come along with the file, at a fraction of its budget and behind the
 * same gate as any other read. Depth is one — see `core/importGraph` for why, and for
 * what a specifier is and is not allowed to resolve to.
 *
 * @module agent/tools/readFile
 */

const fs = require('fs');

const logger = require('../../utils/logger');
const importGraph = require('../../core/importGraph');
const { redact } = require('../../security/secretsScanner');
const { truncateToTokens, estimateTokens } = require('../../utils/tokenBudget');
const { toLf } = require('../../utils/platform');

/** A file bigger than this is not worth reading into a 1B model's context. */
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * How many imported files ride along with a read.
 *
 * Five covers a React component's hook plus its children, which is the shape this was
 * built for. Past that the companions crowd out the file that was actually asked for.
 */
const MAX_IMPORTS = 5;

/**
 * The share of the observation budget the imports may take, all together.
 *
 * The file the model asked for keeps the majority. An import block that outgrew its
 * subject would be the same failure as not following imports at all, in the opposite
 * direction — the model reading everything except the thing it wanted.
 */
const IMPORT_BUDGET_SHARE = 0.4;

/** Below this there is no room to say anything useful about an import, so none is tried. */
const MIN_TOKENS_PER_IMPORT = 60;

/**
 * Read the files this one imports, as a block to append to the observation.
 *
 * Best-effort throughout: every failure here is answered by omitting the companion,
 * because the read the model actually asked for has already succeeded and must not be
 * turned into an error by a neighbour that could not be opened.
 *
 * @param {string} content        The importing file's contents, already redacted.
 * @param {string} relative       Its workspace-relative path.
 * @param {import('../toolRegistry').ToolContext} context
 * @param {number} budget         Tokens available for the whole block.
 * @returns {Promise<{text: string, paths: string[]}>}
 */
async function readImports(content, relative, context, budget) {
  if (!context.workspaceRoot || budget < MIN_TOKENS_PER_IMPORT) return { text: '', paths: [] };

  /** @type {string[]} */
  let paths;
  try {
    paths = await importGraph.resolveImports({
      content,
      path: relative,
      workspaceRoot: context.workspaceRoot,
      max: MAX_IMPORTS,
    });
  } catch (err) {
    logger.debug(`Could not resolve imports for ${relative}: ${/** @type {Error} */ (err).message}`);
    return { text: '', paths: [] };
  }
  if (paths.length === 0) return { text: '', paths: [] };

  const perFile = Math.floor(budget / paths.length);
  if (perFile < MIN_TOKENS_PER_IMPORT) return { text: '', paths: [] };

  /** @type {string[]} */
  const blocks = [];
  /** @type {string[]} */
  const included = [];

  for (const target of paths) {
    // Through the gate, not straight to `fs`. An import specifier is model-adjacent
    // input — it comes from a file the model may itself have written — so it gets the
    // same path confinement and audit entry as a path the model asked for outright.
    const decision = await context.gate.requestRead({
      path: target,
      sessionId: context.sessionId,
      mode: context.mode,
    });
    if (!decision.allowed) continue;

    // Resolved and confined by the gate immediately above.
    let raw;
    try {
      const stats = await fs.promises.stat(decision.resolved.absolute);
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue;
      raw = await fs.promises.readFile(decision.resolved.absolute, 'utf8');
    } catch {
      continue;
    }
    if (raw.includes('\0')) continue;

    const safe = redact(toLf(raw));
    const trimmed = truncateToTokens(safe, perFile, { keep: 'both' });
    const lines = safe.split('\n').length;
    blocks.push(
      `--- ${decision.resolved.relative} (${lines} lines${trimmed.truncated ? ', showing part of it' : ''}) ---\n` +
        trimmed.text
    );
    included.push(decision.resolved.relative);
  }

  if (blocks.length === 0) return { text: '', paths: [] };

  return {
    text:
      `\n\nFiles ${relative} imports, included so you do not have to read them separately ` +
      `(${included.join(', ')}):\n${blocks.join('\n\n')}`,
    paths: included,
  };
}

/**
 * @param {{path: string}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function readFile(args, context) {
  const decision = await context.gate.requestRead({
    path: args.path,
    sessionId: context.sessionId,
    mode: context.mode,
  });

  if (!decision.allowed) {
    return { ok: false, observation: `Could not read ${args.path}: ${decision.reason}`, error: decision.code };
  }

  const target = decision.resolved;

  /** @type {fs.Stats} */
  let stats;
  try {
    stats = await fs.promises.stat(target.absolute);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      // Phrased so the model's next move is obvious: look, don't guess again.
      return {
        ok: false,
        observation: `${target.relative} does not exist. Use list_files or search_workspace to find the right path.`,
        error: 'ENOENT',
      };
    }
    return { ok: false, observation: `Could not read ${target.relative}: ${/** @type {Error} */ (err).message}` };
  }

  if (stats.isDirectory()) {
    return {
      ok: false,
      observation: `${target.relative} is a folder, not a file. Use list_files to see what is inside it.`,
    };
  }
  if (stats.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      observation: `${target.relative} is ${Math.round(stats.size / 1024)}KB — too large to read. Use search_workspace to find the part you need.`,
    };
  }

  let raw;
  try {
    raw = await fs.promises.readFile(target.absolute, 'utf8');
  } catch (err) {
    return { ok: false, observation: `Could not read ${target.relative}: ${/** @type {Error} */ (err).message}` };
  }

  if (raw.includes('\0')) {
    return { ok: false, observation: `${target.relative} is a binary file and cannot be read as text.` };
  }

  // Redact before truncating, so a credential cannot survive by sitting past the
  // cut and reappearing when the budget changes.
  const safe = redact(toLf(raw));
  const budget = context.maxObservationTokens || 1200;
  // The file the model asked for is sized first and keeps the majority; the imports
  // spend what is left of their share, and nothing of the file's.
  const importBudget = context.followImports === false ? 0 : Math.floor(budget * IMPORT_BUDGET_SHARE);
  const trimmed = truncateToTokens(safe, budget - importBudget, { keep: 'both' });

  const lineCount = safe.split('\n').length;
  const header = trimmed.truncated
    ? `${target.relative} (${lineCount} lines, showing part of it):`
    : `${target.relative} (${lineCount} lines):`;

  const imports = await readImports(safe, target.relative, context, importBudget);

  return {
    ok: true,
    observation: `${header}\n${trimmed.text}${imports.text}`,
    detail: {
      path: target.relative,
      bytes: stats.size,
      lines: lineCount,
      truncated: trimmed.truncated,
      tokens: estimateTokens(trimmed.text + imports.text),
      // The untruncated content, for write_file to diff against later.
      content: safe,
      // What came along with it, so the caller can record that these files have been
      // seen without having to re-derive the graph.
      imports: imports.paths,
    },
  };
};

module.exports.readImports = readImports;
module.exports.MAX_IMPORTS = MAX_IMPORTS;
module.exports.IMPORT_BUDGET_SHARE = IMPORT_BUDGET_SHARE;
module.exports.MIN_TOKENS_PER_IMPORT = MIN_TOKENS_PER_IMPORT;
