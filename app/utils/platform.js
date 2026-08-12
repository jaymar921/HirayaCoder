'use strict';

/**
 * Cross-platform primitives. Every OS-dependent decision in HirayaCoder routes
 * through this module so the rest of the codebase never inspects `process.platform`
 * directly and never hardcodes a path separator or a shell.
 *
 * @module utils/platform
 */

const os = require('os');
const path = require('path');

/** @typedef {'win32' | 'darwin' | 'linux' | 'other'} PlatformName */

/**
 * @typedef {object} ShellSpec
 * @property {string} command   Absolute-or-PATH-resolvable shell binary.
 * @property {string[]} args    Argument array preceding the command string.
 * @property {boolean} windows  True when the resolved shell is a Windows shell.
 */

/**
 * Normalize `os.platform()` into the three families we care about.
 *
 * @param {string} [platform] Override, for tests.
 * @returns {PlatformName}
 */
function platformName(platform = os.platform()) {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return 'other';
}

/**
 * @param {string} [platform] Override, for tests.
 * @returns {boolean}
 */
function isWindows(platform = os.platform()) {
  return platformName(platform) === 'win32';
}

/**
 * Resolve the shell used to execute a user-approved script.
 *
 * The returned spec is always argument-array based — callers pass the command as a
 * single trailing argv entry to `spawn`/`execFile`, never interpolated into a string
 * handed to a shell parser. See `security/scriptRunner.js`.
 *
 * @param {string} [platform] Override, for tests.
 * @param {NodeJS.ProcessEnv} [env] Override, for tests.
 * @returns {ShellSpec}
 */
function resolveShell(platform = os.platform(), env = process.env) {
  if (platformName(platform) === 'win32') {
    // ComSpec is the documented way to find cmd.exe; fall back to the bare name so
    // PATH resolution still works on unusual images.
    return { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c'], windows: true };
  }
  // `sh` is guaranteed present on macOS and Linux; bash is not (Alpine, minimal images).
  return { command: env.SHELL && env.SHELL.endsWith('bash') ? env.SHELL : '/bin/sh', args: ['-c'], windows: false };
}

/**
 * The line ending a piece of text predominantly uses.
 *
 * Diffs and writes must respect the file's existing convention rather than
 * imposing `\n` and rewriting every line of a CRLF file.
 *
 * @param {string} text
 * @returns {'\r\n' | '\n'}
 */
function detectEol(text) {
  if (typeof text !== 'string' || text.length === 0) return os.EOL === '\r\n' ? '\r\n' : '\n';
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Convert text to LF-only for internal processing (diffing, token counting, prompts).
 *
 * @param {string} text
 * @returns {string}
 */
function toLf(text) {
  return String(text).replace(/\r\n/g, '\n');
}

/**
 * Re-apply a target line ending before writing to disk.
 *
 * @param {string} text LF-normalized text.
 * @param {'\r\n' | '\n'} eol
 * @returns {string}
 */
function applyEol(text, eol) {
  const lf = toLf(text);
  return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

/**
 * Convert an OS-native path to the workspace-relative, forward-slash form used in
 * prompts, memory entries, and the audit log — so a session's records read the same
 * on every platform.
 *
 * @param {string} filePath
 * @returns {string}
 */
function toPosixPath(filePath) {
  return String(filePath).split(path.sep).join('/');
}

/**
 * Convert a forward-slash path (as emitted by a model) back to an OS-native path.
 *
 * @param {string} posixPath
 * @returns {string}
 */
function fromPosixPath(posixPath) {
  return String(posixPath).split('/').join(path.sep);
}

/**
 * Path comparison honoring platform case sensitivity. macOS is case-insensitive in
 * practice on its default volume format, so it is grouped with Windows here.
 *
 * @param {string} a
 * @param {string} b
 * @param {string} [platform] Override, for tests.
 * @returns {boolean}
 */
function pathsEqual(a, b, platform = os.platform()) {
  const name = platformName(platform);
  const caseInsensitive = name === 'win32' || name === 'darwin';
  const left = path.normalize(String(a));
  const right = path.normalize(String(b));
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

module.exports = {
  platformName,
  isWindows,
  resolveShell,
  detectEol,
  toLf,
  applyEol,
  toPosixPath,
  fromPosixPath,
  pathsEqual,
};
