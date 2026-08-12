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
 * @module agent/tools/readFile
 */

const fs = require('fs');

const { redact } = require('../../security/secretsScanner');
const { truncateToTokens, estimateTokens } = require('../../utils/tokenBudget');
const { toLf } = require('../../utils/platform');

/** A file bigger than this is not worth reading into a 1B model's context. */
const MAX_FILE_BYTES = 1024 * 1024;

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
  const trimmed = truncateToTokens(safe, budget, { keep: 'both' });

  const lineCount = safe.split('\n').length;
  const header = trimmed.truncated
    ? `${target.relative} (${lineCount} lines, showing part of it):`
    : `${target.relative} (${lineCount} lines):`;

  return {
    ok: true,
    observation: `${header}\n${trimmed.text}`,
    detail: {
      path: target.relative,
      bytes: stats.size,
      lines: lineCount,
      truncated: trimmed.truncated,
      tokens: estimateTokens(trimmed.text),
      // The untruncated content, for write_file to diff against later.
      content: safe,
    },
  };
};
