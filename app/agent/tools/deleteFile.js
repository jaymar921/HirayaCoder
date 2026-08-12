'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * The path is resolved, confined, and protected-prefix checked by permissionGate →
 * pathGuard before the unlink; the absolute path is the guard's output. */

/**
 * Delete a workspace file.
 *
 * The most consequential tool in the set, so it is also the most conservative:
 * directories are refused outright (a recursive delete is not something an agent
 * should reach for), the previous contents are captured into the change set before
 * the unlink so the review UI can offer a restore, and `.git`/`.hirayacoder` are
 * unreachable via the path guard's protected prefixes.
 *
 * @module agent/tools/deleteFile
 */

const fs = require('fs');

/**
 * @param {{path: string}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function deleteFile(args, context) {
  // Capture the contents first — after the unlink there is nothing to restore from.
  /** @type {string | null} */
  let previous = null;
  const probe = await context.gate.requestRead({
    path: args.path,
    sessionId: context.sessionId,
    mode: 'agent',
  });

  if (probe.allowed) {
    try {
      const stats = await fs.promises.stat(probe.resolved.absolute);
      if (stats.isDirectory()) {
        return {
          ok: false,
          observation: `${args.path} is a folder. HirayaCoder only deletes individual files.`,
        };
      }
      previous = await fs.promises.readFile(probe.resolved.absolute, 'utf8');
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        return {
          ok: false,
          observation: `${args.path} does not exist, so there is nothing to delete.`,
          error: 'ENOENT',
        };
      }
      // Unreadable but present — a binary, say. Deleting is still legitimate; we
      // just cannot offer a restore.
      previous = null;
    }
  }

  const decision = await context.gate.requestDelete({
    path: args.path,
    sessionId: context.sessionId,
    mode: context.mode,
  });

  if (!decision.allowed) {
    return {
      ok: false,
      observation: `${args.path} was not deleted: ${decision.reason}`,
      error: decision.code,
    };
  }

  const target = decision.resolved;
  try {
    await fs.promises.unlink(target.absolute);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { ok: false, observation: `${target.relative} does not exist.`, error: 'ENOENT' };
    }
    return {
      ok: false,
      observation: `Could not delete ${target.relative}: ${/** @type {Error} */ (err).message}`,
    };
  }

  if (context.changeSet) {
    context.changeSet.record({
      kind: 'delete',
      path: target.relative,
      before: previous,
      after: null,
      added: 0,
      removed: previous === null ? 0 : previous.split('\n').length,
    });
  }

  return {
    ok: true,
    observation: `Deleted ${target.relative}.`,
    detail: { path: target.relative, restorable: previous !== null },
  };
};
