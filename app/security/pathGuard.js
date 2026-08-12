'use strict';

/**
 * Workspace-root confinement for every filesystem path the agent proposes.
 *
 * Two layers, because one is not enough:
 *
 *  1. **Lexical** (`resolvePath`) — resolve the candidate against the workspace root
 *     and verify containment. Catches `../../etc/passwd`, absolute paths outside the
 *     workspace, drive changes on Windows, and NUL-byte truncation tricks.
 *  2. **Real** (`assertRealPath`) — resolve symlinks and re-check containment. A
 *     lexically-clean path like `docs/notes` can still be a symlink pointing at
 *     `/etc`, and lexical checks alone cannot see that. When the target does not
 *     exist yet (a file the agent is creating), the nearest existing ancestor is
 *     checked instead, which is what a write would actually traverse.
 *
 * This module is never bypassed — auto-edit and auto-approve-scripts modes remove
 * the confirmation click, not the guard. See `permissionGate.js`.
 *
 * Pure except for `assertRealPath`, which needs `fs`.
 *
 * @module security/pathGuard
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { platformName } = require('../utils/platform');

/**
 * Paths the agent may never write to or delete, relative to the workspace root.
 *
 * `.git` is excluded because corrupting it can destroy history irrecoverably, and
 * `.hirayacoder` because the agent must not be able to rewrite its own audit log or
 * poison its own memory store (see `PROMPT.md` section 15.10).
 */
const DEFAULT_PROTECTED_PREFIXES = ['.git', '.hirayacoder'];

/** Windows reserved device names — opening these can hang or hit hardware. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Raised for every rejection, with a machine-readable `code`. */
class PathGuardError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {string} [candidate]
   */
  constructor(code, message, candidate) {
    super(message);
    this.name = 'PathGuardError';
    this.code = code;
    this.candidate = candidate;
  }
}

/**
 * @typedef {object} ResolvedPath
 * @property {string} absolute   OS-native absolute path.
 * @property {string} relative   Workspace-relative, forward-slash form.
 * @property {string} root
 */

/**
 * Case-folds a path for comparison on platforms with case-insensitive filesystems.
 *
 * @param {string} value
 * @param {string} platform
 * @returns {string}
 * @private
 */
function foldCase(value, platform) {
  const name = platformName(platform);
  return name === 'win32' || name === 'darwin' ? value.toLowerCase() : value;
}

/**
 * Is `target` the same as, or inside, `root`?
 *
 * Both paths are resolved first, which collapses `..` segments, so the remaining
 * question is pure containment. The prefix test appends a separator deliberately:
 * a bare `startsWith` would accept the sibling `/workspace/project-evil` for root
 * `/workspace/project`.
 *
 * Case sensitivity is decided here rather than delegated to `path.relative`,
 * because `path` follows the *host* platform — on a Windows host it compares
 * case-insensitively even when asked to reason about Linux semantics, which would
 * make the `platform` argument silently inert.
 *
 * @param {string} root Absolute.
 * @param {string} target Absolute.
 * @param {string} [platform]
 * @returns {boolean}
 */
function isInside(root, target, platform = os.platform()) {
  const foldedRoot = foldCase(path.resolve(root), platform);
  const foldedTarget = foldCase(path.resolve(target), platform);
  if (foldedRoot === foldedTarget) return true;

  const rootWithSep = foldedRoot.endsWith(path.sep) ? foldedRoot : foldedRoot + path.sep;
  return foldedTarget.startsWith(rootWithSep);
}

/**
 * Resolve a candidate path against the workspace root, rejecting anything that
 * escapes it.
 *
 * @param {string} root Workspace root (absolute).
 * @param {string} candidate Model- or user-supplied path, relative or absolute.
 * @param {object} [opts]
 * @param {string} [opts.platform] Override, for tests.
 * @returns {ResolvedPath}
 * @throws {PathGuardError}
 */
function resolvePath(root, candidate, opts = {}) {
  const platform = opts.platform || os.platform();

  if (typeof root !== 'string' || root.length === 0) {
    throw new PathGuardError('NO_WORKSPACE', 'No workspace folder is open, so file access is refused.');
  }
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new PathGuardError('EMPTY_PATH', 'A file path is required.', String(candidate));
  }
  // A NUL byte truncates the path at the OS layer, so 'safe.txt\0../../etc' would
  // pass a string check and then open something else entirely.
  if (candidate.includes('\0')) {
    throw new PathGuardError('NUL_BYTE', 'Path contains a NUL byte and was refused.', candidate);
  }

  const absoluteRoot = path.resolve(root);
  // Models emit forward slashes regardless of platform; accept both separators.
  const native = platformName(platform) === 'win32' ? candidate.replace(/\//g, path.sep) : candidate;
  const absolute = path.resolve(absoluteRoot, native);

  if (!isInside(absoluteRoot, absolute, platform)) {
    // The message is the model's only chance to recover. Observed live:
    // `llama3.2:1b` invented "/home/user/project/README.md" and retried it four
    // times against a bare "refused" — it had no way to learn the convention.
    // Naming the convention turns a dead end into a correctable mistake.
    throw new PathGuardError(
      'OUTSIDE_WORKSPACE',
      `"${candidate}" is outside the workspace and was refused. ` +
        'Use a path relative to the project root, like "src/app.js" — never an absolute path.',
      candidate
    );
  }

  if (platformName(platform) === 'win32') {
    for (const segment of path.relative(absoluteRoot, absolute).split(path.sep)) {
      const stem = segment.split('.')[0].toLowerCase();
      if (WINDOWS_RESERVED.has(stem)) {
        throw new PathGuardError(
          'RESERVED_NAME',
          `"${segment}" is a reserved Windows device name and was refused.`,
          candidate
        );
      }
    }
  }

  const relative = path.relative(absoluteRoot, absolute).split(path.sep).join('/');
  return { absolute, relative, root: absoluteRoot };
}

/**
 * Is this path inside a protected prefix (`.git`, `.hirayacoder`, …)?
 *
 * @param {string} relativePath Forward-slash, workspace-relative.
 * @param {string[]} [protectedPrefixes]
 * @param {string} [platform]
 * @returns {string | null} The matched prefix, or null.
 */
function matchProtectedPrefix(relativePath, protectedPrefixes = DEFAULT_PROTECTED_PREFIXES, platform = os.platform()) {
  const folded = foldCase(relativePath, platform);
  for (const prefix of protectedPrefixes) {
    const foldedPrefix = foldCase(prefix, platform);
    if (folded === foldedPrefix || folded.startsWith(`${foldedPrefix}/`)) return prefix;
  }
  return null;
}

/**
 * Resolve a path intended for a write or delete, additionally rejecting protected
 * locations. Reads are deliberately not subject to the protected list — the agent
 * may usefully read `.git/HEAD` or its own memory file.
 *
 * @param {string} root
 * @param {string} candidate
 * @param {object} [opts]
 * @param {string[]} [opts.protectedPrefixes]
 * @param {string} [opts.platform]
 * @returns {ResolvedPath}
 * @throws {PathGuardError}
 */
function resolveForMutation(root, candidate, opts = {}) {
  const resolved = resolvePath(root, candidate, opts);
  const platform = opts.platform || os.platform();

  if (resolved.relative === '') {
    throw new PathGuardError('IS_ROOT', 'Refusing to modify the workspace root itself.', candidate);
  }

  const matched = matchProtectedPrefix(resolved.relative, opts.protectedPrefixes, platform);
  if (matched) {
    throw new PathGuardError(
      'PROTECTED_PATH',
      `"${resolved.relative}" is inside the protected "${matched}" directory and cannot be modified by the agent.`,
      candidate
    );
  }

  return resolved;
}

/**
 * Verify that the path's *real* location — after following symlinks — is still
 * inside the workspace.
 *
 * For a path that does not exist yet, the nearest existing ancestor is checked,
 * since that is the directory a create would actually land in.
 *
 * @param {ResolvedPath} resolved
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @returns {Promise<ResolvedPath>}
 * @throws {PathGuardError}
 */
async function assertRealPath(resolved, opts = {}) {
  const platform = opts.platform || os.platform();
  let probe = resolved.absolute;
  let real = null;

  // Walk up until something exists, so a not-yet-created file still gets checked
  // against the real directory it would be created in.
  for (;;) {
    try {
      // Resolving an attacker-influenced path is precisely this function's purpose;
      // the result is containment-checked against the workspace root just below.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      real = await fs.promises.realpath(probe);
      break;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code !== 'ENOENT') {
        throw new PathGuardError('REALPATH_FAILED', `Could not verify "${resolved.relative}": ${/** @type {Error} */ (err).message}`, resolved.relative);
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        throw new PathGuardError('REALPATH_FAILED', `Could not verify "${resolved.relative}".`, resolved.relative);
      }
      probe = parent;
    }
  }

  // The workspace root comes from VS Code, never from model output.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const realRoot = await fs.promises.realpath(resolved.root).catch(() => resolved.root);

  if (!isInside(realRoot, real, platform)) {
    throw new PathGuardError(
      'SYMLINK_ESCAPE',
      `"${resolved.relative}" resolves through a link to "${real}", outside the workspace. Refused.`,
      resolved.relative
    );
  }

  return resolved;
}

module.exports = {
  PathGuardError,
  resolvePath,
  resolveForMutation,
  assertRealPath,
  isInside,
  matchProtectedPrefix,
  DEFAULT_PROTECTED_PREFIXES,
  WINDOWS_RESERVED,
};
