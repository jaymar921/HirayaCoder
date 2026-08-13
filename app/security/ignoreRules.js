'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * The only path read here is `<workspaceRoot>/.gitignore`, built from the root the
 * extension was opened on and a hardcoded file name. No model- or file-sourced string
 * reaches it. */

/**
 * Which files the project has said it does not want tracked — and, by extension, does
 * not want read into a prompt without being asked.
 *
 * ## The failure this exists for
 *
 * `api/.env` was read twice, in two separate sessions, and the audit log records both
 * as `"decision":"auto-approved"`. The project's `.gitignore` is three lines long and
 * the first is `*.env`. Nothing in the extension had ever looked at it.
 *
 * That was working as designed, and the design was wrong. `permissionGate.requestRead`
 * is documented as "reads need path confinement but never a confirmation click", on the
 * reasoning that reading cannot damage anything. Reading cannot damage the workspace.
 * It can absolutely leak out of it: the contents go into a prompt, the prompt goes to a
 * model, and while that model is local today, the file's contents also land in the
 * session transcript on disk and in the context of every subsequent turn.
 *
 * A `.env` is the case that makes this concrete, but the rule generalises. A project's
 * `.gitignore` is the closest thing to a machine-readable statement of "this is not
 * part of the source", written by the user, already present, and needing no new
 * setting.
 *
 * ## Why `.gitignore` is not the whole answer
 *
 * Plenty of projects have no `.gitignore`, or have one that omits the secret file
 * because it lives outside the repo, or the user opened a folder that is not a git
 * repository at all. So `ALWAYS_SENSITIVE` is checked independently and first: a file
 * called `.env` is a secret whether or not anyone remembered to ignore it.
 *
 * The converse also matters, and is why `dist/` being ignored does not make it secret.
 * Build output is ignored and dull. The rule is therefore not "refuse", it is "ask" —
 * an ignored file is read after the user says so, and the answer is remembered for the
 * session so a model reading through `dist/` does not produce a dialog per file.
 *
 * ## What this is not
 *
 * Not a general-purpose gitignore implementation. It handles the syntax that appears in
 * real files — globs, directory rules, negation, anchoring — and treats what it cannot
 * parse as "no match", which fails toward the existing behaviour rather than toward
 * refusing to read a project's source. `ALWAYS_SENSITIVE` is the backstop that does not
 * depend on parsing anything.
 *
 * @module security/ignoreRules
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');

/**
 * Files that are secret regardless of what any `.gitignore` says.
 *
 * Matched against the base name and, for a couple of entries, the whole relative path.
 * Deliberately short: every entry is a file whose *entire purpose* is to hold a
 * credential. Adding "config.json" here would be wrong — most are configuration, some
 * are secrets, and a rule that asks about every one of them trains the user to click
 * through the dialog, which is worse than not having it.
 */
const ALWAYS_SENSITIVE = [
  // Environment files, in every spelling that carries values: `.env`, `.env.local`,
  // `.env.production`, `api.env`. Not `.env.example`, which exists to be read and is
  // excluded below.
  /^\.env(\..+)?$/i,
  /\.env$/i,
  // Private keys and certificates.
  /\.(?:pem|key|pfx|p12|jks|keystore)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  // Package-registry and cloud credentials.
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^credentials(\.json)?$/i,
  /^service-account.*\.json$/i,
  /^\.aws$/i,
];

/**
 * Names that look sensitive and are not.
 *
 * A `.env.example` is committed on purpose, holds placeholder values, and is often the
 * single most useful file for answering "what does this project need to run". Asking
 * about it is pure friction.
 */
const NEVER_SENSITIVE = [/^\.env\.(?:example|sample|template|dist)$/i, /\.example$/i, /\.sample$/i];

/**
 * Turn one `.gitignore` line into a matcher.
 *
 * Returns null for blanks, comments, and anything with syntax this does not implement.
 *
 * @param {string} line
 * @returns {{negated: boolean, directoryOnly: boolean, test: (relativePath: string) => boolean} | null}
 */
function compileRule(line) {
  let pattern = line.trim();
  if (!pattern || pattern.startsWith('#')) return null;

  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);

  // A trailing slash means "directory only". The slash itself is not part of the match.
  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) pattern = pattern.slice(0, -1);

  // A leading slash anchors to the repository root rather than matching at any depth.
  const anchored = pattern.startsWith('/');
  if (anchored) pattern = pattern.slice(1);

  if (!pattern) return null;

  // A pattern containing a slash anywhere is anchored in git's rules, not just one
  // starting with it: `*/node_modules` matches at the root's children, not everywhere.
  const hasSlash = pattern.includes('/');

  const source = globToRegExpSource(pattern);
  if (source === null) return null;

  let regex;
  try {
    regex =
      anchored || hasSlash
        ? new RegExp(`^${source}(?:/.*)?$`)
        : // Unanchored: match the name at any depth.
          new RegExp(`(?:^|/)${source}(?:/.*)?$`);
  } catch (err) {
    logger.debug(`Ignoring unparseable .gitignore rule "${line}": ${/** @type {Error} */ (err).message}`);
    return null;
  }

  return {
    negated,
    directoryOnly,
    test: (relativePath) => regex.test(relativePath),
  };
}

/**
 * Translate a gitignore glob into regular-expression source.
 *
 * Built character by character rather than by chained `replace` calls, because the
 * chained form re-scans its own output — a `.` inserted by an earlier replacement gets
 * treated as a metacharacter by a later one, and the bugs that produces are subtle and
 * silent.
 *
 * @param {string} pattern
 * @returns {string | null} Null if the pattern uses syntax this does not implement.
 */
function globToRegExpSource(pattern) {
  let source = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**` crosses directory separators; `**/` should also match zero directories,
        // so `**/foo` matches a bare `foo`.
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        // A single star stops at a separator.
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    if (char === '[') {
      // Character classes are passed through, but only when well-formed and simple.
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) return null;
      const body = pattern.slice(i + 1, close);
      if (/[\\\]]/.test(body)) return null;
      source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = close;
      continue;
    }

    // Everything else is a literal.
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  return source;
}

/**
 * Read and compile a workspace's `.gitignore`.
 *
 * Only the root file. Nested `.gitignore` files are legal git and rare in the projects
 * this runs on, and walking for them would mean a directory scan on a path that is
 * consulted before every read.
 *
 * @param {string} workspaceRoot
 * @returns {Array<ReturnType<typeof compileRule>>}
 */
function loadRules(workspaceRoot) {
  try {
    const raw = fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf8');
    return raw
      .split(/\r?\n/)
      .map(compileRule)
      .filter(Boolean);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') {
      logger.debug(`Could not read .gitignore: ${/** @type {Error} */ (err).message}`);
    }
    return [];
  }
}

/** Normalise a relative path to forward slashes, with no leading `./`. */
function normalize(relativePath) {
  return String(relativePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/**
 * @typedef {object} Verdict
 * @property {boolean} sensitive   True if this needs the user's say-so before a read.
 * @property {'always' | 'gitignore' | null} because
 * @property {string} [rule]       The `.gitignore` line responsible, for the dialog.
 */

/** Not sensitive. */
const FINE = { sensitive: false, because: null };

class IgnoreRules {
  /**
   * @param {string} workspaceRoot
   */
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    /** @type {Array<ReturnType<typeof compileRule>> | null} */
    this._rules = null;
    /**
     * Paths the user has already allowed this session.
     *
     * Per path, not per pattern: agreeing to read `api/.env` is not agreeing to read
     * every `.env` in the workspace, and the second one is a separate decision.
     *
     * @type {Set<string>}
     */
    this.granted = new Set();
  }

  /** @returns {Array<ReturnType<typeof compileRule>>} */
  get rules() {
    // Loaded on first use and cached. A `.gitignore` edited mid-session is rare, and
    // re-reading it before every file read is a syscall on the hot path.
    if (this._rules === null) this._rules = loadRules(this.workspaceRoot);
    return this._rules;
  }

  /** Drop the cached rules, so an edited `.gitignore` is picked up. */
  reload() {
    this._rules = null;
  }

  /**
   * Does reading this path need the user's permission first?
   *
   * @param {string} relativePath  Workspace-relative, as `pathGuard` returns it.
   * @returns {Verdict}
   */
  classify(relativePath) {
    const target = normalize(relativePath);
    if (!target) return FINE;

    const base = target.split('/').pop() || '';

    if (NEVER_SENSITIVE.some((pattern) => pattern.test(base))) return FINE;

    if (ALWAYS_SENSITIVE.some((pattern) => pattern.test(base))) {
      return { sensitive: true, because: 'always' };
    }

    // Last matching rule wins, and a negation un-ignores. That is git's own precedence,
    // and getting it backwards would make `!important.env` do nothing.
    /** @type {Verdict} */
    let verdict = FINE;
    for (const rule of this.rules) {
      if (!rule.test(target)) continue;
      verdict = rule.negated ? FINE : { sensitive: true, because: 'gitignore' };
    }

    return verdict;
  }

  /** Has the user already allowed this exact path this session? */
  isGranted(relativePath) {
    return this.granted.has(normalize(relativePath));
  }

  /** Remember that the user allowed this path. */
  grant(relativePath) {
    this.granted.add(normalize(relativePath));
  }
}

module.exports = {
  IgnoreRules,
  compileRule,
  globToRegExpSource,
  normalize,
  ALWAYS_SENSITIVE,
  NEVER_SENSITIVE,
};
