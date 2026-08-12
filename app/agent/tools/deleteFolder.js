'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * The path is resolved, confined, and protected-prefix checked by permissionGate →
 * pathGuard before anything is removed; the absolute path is the guard's output. */

/**
 * Remove a directory.
 *
 * ## The gap this closes
 *
 * `delete_file` refuses directories outright, and 0.3.0's command redirect sends `rm`
 * and `rmdir` to `delete_file`. So a folder was not merely awkward to remove — it was
 * unreachable by every route the agent had. Observed live: asked to remove an empty
 * `src/main/java` left behind after its two files were deleted, the model tried
 * `delete_file`, was told "HirayaCoder only deletes individual files", and then
 * reported to the user that the folder "has been removed from the workspace". It had
 * not. A dead end the model cannot see is a dead end it will narrate its way out of.
 *
 * ## Why this is the most conservative tool in the set
 *
 * Three separate brakes, because a recursive delete is the one mutation the change set
 * cannot undo:
 *
 *  1. **Empty by default.** A folder with anything in it is refused unless the caller
 *     explicitly passes `recursive: true`. The common case — tidying up an empty
 *     directory — never touches the recursive path at all.
 *  2. **Always confirms.** `permissionGate.requestDeleteFolder` ignores both Auto Edit
 *     and `alwaysConfirmDeletes`. There is no configuration in which this runs
 *     unattended, and the prompt names the number of items at stake.
 *  3. **Bounded.** Past `MAX_RECURSIVE_ENTRIES` the tool refuses regardless of the
 *     answer, and says so. The distance between `src/main/java` and `src` is one token
 *     of model output, and a confirmation dialog is a poor last line of defence
 *     against a mis-click on a subtree the user has not read.
 *
 * @module agent/tools/deleteFolder
 */

const fs = require('fs');
const path = require('path');

/**
 * The most a single recursive delete may remove.
 *
 * Set where it is because the legitimate uses are small — an abandoned source folder,
 * a stale build output, a scaffold that went the wrong way. A directory with hundreds
 * of entries under it is a part of the project the user knows about, and removing it
 * is a decision worth making with a file manager rather than through a 1B model's
 * summary.
 */
const MAX_RECURSIVE_ENTRIES = 100;

/**
 * Count what is under a directory, stopping once the limit is exceeded.
 *
 * The early exit is the point: the answer is only used to decide "is this small enough
 * to remove, and how much do I tell the user is at stake", and neither needs an exact
 * figure for a tree of 40,000 files.
 *
 * @param {string} absolute
 * @param {number} limit
 * @returns {Promise<{count: number, exceeded: boolean}>}
 */
async function countEntries(absolute, limit) {
  let count = 0;
  /** @type {string[]} */
  const queue = [absolute];

  while (queue.length > 0) {
    const dir = queue.pop();
    /** @type {import('fs').Dirent[]} */
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable subdirectory: it still counts as something in the way.
      count += 1;
      continue;
    }

    for (const entry of entries) {
      count += 1;
      if (count > limit) return { count, exceeded: true };
      // Symlinked directories are counted but never followed — walking one would
      // leave the workspace, and `fs.rm` does not follow them either.
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(path.join(dir, entry.name));
    }
  }

  return { count, exceeded: false };
}

/**
 * @param {{path: string, recursive?: boolean}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function deleteFolder(args, context) {
  if (typeof args.path !== 'string' || args.path.trim().length === 0) {
    return {
      ok: false,
      observation: 'delete_folder needs the folder to remove in "path".',
      error: 'MISSING_PATH',
    };
  }

  const probe = await context.gate.requestRead({
    path: args.path,
    sessionId: context.sessionId,
    mode: 'agent',
  });

  if (!probe.allowed) {
    return { ok: false, observation: `${args.path} was not removed: ${probe.reason}`, error: probe.code };
  }

  try {
    const stats = await fs.promises.lstat(probe.resolved.absolute);
    if (stats.isSymbolicLink()) {
      return {
        ok: false,
        observation: `${probe.resolved.relative} is a symbolic link, not a folder. Refused.`,
        error: 'IS_SYMLINK',
      };
    }
    if (!stats.isDirectory()) {
      return {
        ok: false,
        observation: `${probe.resolved.relative} is a file, not a folder. Use delete_file for it.`,
        error: 'NOT_A_DIRECTORY',
      };
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return {
        ok: true,
        observation: `${probe.resolved.relative} does not exist, so there is nothing to remove.`,
        detail: { path: `${probe.resolved.relative}/`, unchanged: true },
      };
    }
    return {
      ok: false,
      observation: `Could not check ${args.path}: ${/** @type {Error} */ (err).message}`,
      error: 'STAT_FAILED',
    };
  }

  const { count, exceeded } = await countEntries(probe.resolved.absolute, MAX_RECURSIVE_ENTRIES);
  const recursive = args.recursive === true;

  if (count > 0 && !recursive) {
    return {
      ok: false,
      observation:
        `${probe.resolved.relative}/ is not empty — it holds ${exceeded ? `more than ${MAX_RECURSIVE_ENTRIES}` : count} item(s). ` +
        'To remove it and everything inside it, send delete_folder again for the same path with "recursive" set to true. ' +
        'If you only meant to remove particular files, use delete_file on each of them instead.',
      error: 'FOLDER_NOT_EMPTY',
    };
  }

  if (exceeded) {
    return {
      ok: false,
      observation:
        `Refused: ${probe.resolved.relative}/ contains more than ${MAX_RECURSIVE_ENTRIES} items, which is too much ` +
        'to remove in one step. Stop and tell the user which folder you wanted to delete and why, so they can do it ' +
        'themselves if they agree.',
      error: 'FOLDER_TOO_LARGE',
    };
  }

  const decision = await context.gate.requestDeleteFolder({
    path: args.path,
    sessionId: context.sessionId,
    mode: context.mode,
    entries: count,
  });

  if (!decision.allowed) {
    return {
      ok: false,
      observation: `${args.path} was not removed: ${decision.reason}`,
      error: decision.code,
    };
  }

  const target = decision.resolved;
  try {
    await fs.promises.rm(target.absolute, { recursive: true, force: false });
  } catch (err) {
    return {
      ok: false,
      observation: `Could not remove ${target.relative}: ${/** @type {Error} */ (err).message}`,
      error: 'RM_FAILED',
    };
  }

  if (context.changeSet) {
    context.changeSet.record({
      kind: 'delete',
      path: `${target.relative}/`,
      // Nothing to restore from: a directory tree is not something the change set can
      // hold, which is exactly why the confirmation above is unconditional.
      before: null,
      after: null,
      added: 0,
      removed: count,
    });
  }

  return {
    ok: true,
    observation:
      count > 0
        ? `Removed the folder ${target.relative}/ and the ${count} item(s) in it.`
        : `Removed the empty folder ${target.relative}/.`,
    detail: { path: `${target.relative}/`, entries: count, restorable: false },
  };
};

module.exports.countEntries = countEntries;
module.exports.MAX_RECURSIVE_ENTRIES = MAX_RECURSIVE_ENTRIES;
