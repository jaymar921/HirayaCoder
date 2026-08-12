'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Paths are resolved and confined by permissionGate → pathGuard before the mkdir;
 * the absolute path used here is the guard's output, not the model's string. */

/**
 * Create an empty directory.
 *
 * ## Why this exists when `write_file` already makes directories
 *
 * It does, and that is still the right way to get `src/main/java` — you write the file
 * and the folder appears. But "the folder you want will appear when you write into it"
 * is a fact about a *sequence of steps*, and a model that has been told to create a
 * project layout does not reliably rewrite its plan around it. Observed across four
 * sessions on two different models: `mkdir -p src/main/java build`, refused, sent
 * again, refused, sent again, and the repeat guard ends the item. 0.3.0 answered that
 * refusal with "you do not need to create directories at all", which is true and which
 * `ornith:9b` read three times before giving up anyway.
 *
 * The cheaper fix is to stop making it a puzzle. A folder is a thing the model asked
 * for; now there is a tool that makes one, it goes through the same gate as every other
 * mutation, and the loop moves on. `write_file`'s implicit creation is unchanged, so
 * nothing is forced to use this.
 *
 * Creating a folder that already exists is a success, not an error — `mkdir -p`
 * semantics. A model checking its work should not be handed a failure to recover from.
 *
 * @module agent/tools/createFolder
 */

const fs = require('fs');

/**
 * @param {{path: string}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function createFolder(args, context) {
  if (typeof args.path !== 'string' || args.path.trim().length === 0) {
    return {
      ok: false,
      observation: 'create_folder needs the folder to create in "path".',
      error: 'MISSING_PATH',
    };
  }

  // Probe first, so an existing folder costs no confirmation click at all.
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
          ok: true,
          observation: `${probe.resolved.relative}/ already exists. Nothing to create — write the files you need into it.`,
          detail: { path: `${probe.resolved.relative}/`, unchanged: true },
        };
      }
      return {
        ok: false,
        observation: `${probe.resolved.relative} already exists and is a file, not a folder. Pick a different path.`,
        error: 'NOT_A_DIRECTORY',
      };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
        return {
          ok: false,
          observation: `Could not check ${args.path}: ${/** @type {Error} */ (err).message}`,
          error: 'STAT_FAILED',
        };
      }
      // ENOENT is the ordinary case: it does not exist yet, so make it.
    }
  }

  const decision = await context.gate.requestCreateFolder({
    path: args.path,
    sessionId: context.sessionId,
    mode: context.mode,
  });

  if (!decision.allowed) {
    return {
      ok: false,
      observation: `${args.path} was not created: ${decision.reason}`,
      error: decision.code,
    };
  }

  const target = decision.resolved;
  try {
    await fs.promises.mkdir(target.absolute, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      observation: `Could not create ${target.relative}: ${/** @type {Error} */ (err).message}`,
      error: 'MKDIR_FAILED',
    };
  }

  if (context.changeSet) {
    // Trailing slash so the review list reads as a folder rather than an empty file.
    context.changeSet.record({
      kind: 'create',
      path: `${target.relative}/`,
      before: null,
      after: null,
      added: 0,
      removed: 0,
    });
  }

  return {
    ok: true,
    observation: `Created the folder ${target.relative}/. Now write the files that belong in it.`,
    detail: { path: `${target.relative}/`, isNew: true },
  };
};
