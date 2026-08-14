'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Both files written here are fixed names under the VS Code workspace root. No
 * component of either path derives from model output. */

/**
 * The two things a workspace needs before the first turn runs.
 *
 * Both are small, both are idempotent, and both were previously left to chance:
 *
 *  1. `.hirayacoder/environment.json` — what machine this is, so the model is told
 *     rather than guessing. See `core/environmentProfile` for the run that motivated it.
 *  2. `.gitignore` carries `.hirayacoder/` — so a session's audit log, transcripts, and
 *     memory do not turn up in the user's next commit.
 *
 * ## Why the .gitignore entry is not optional
 *
 * `.hirayacoder/` holds `audit.log`, `outcomes.jsonl`, `transcripts/*.json`, and
 * `memory/session*.txt`. Transcripts contain the full text of every message in a
 * session, and memory contains file paths and command lines from the project. None of
 * that is secret exactly, and all of it is noise in a diff — but the failure mode is a
 * user committing their whole conversation history to a public repository without
 * noticing, which is a privacy claim this extension makes and should therefore keep.
 *
 * Every benchmark workspace in `.ignore/` shows the same thing: `.hirayacoder/` sitting
 * beside the scaffolded project, untracked and unmentioned, next to a `.gitignore` the
 * scaffolder wrote that lists `node_modules` and nothing else.
 *
 * ## The rules this follows
 *
 * - An existing `.gitignore` is **appended to**, never rewritten. It is the user's file.
 * - Nothing is appended if any existing line already covers `.hirayacoder`, whatever
 *   form it is written in — a second entry would be noise, and a `!.hirayacoder`
 *   negation is a decision to respect rather than to overrule.
 * - A missing `.gitignore` is created with the one entry and nothing else. Guessing at
 *   `node_modules`, `dist`, and `.env` for a project whose language is unknown is how a
 *   helpful default becomes a wrong one.
 * - Every failure is logged and swallowed. A session must start on a read-only checkout.
 *
 * @module core/workspaceBootstrap
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');
const environmentProfile = require('./environmentProfile');

/** The entry written into `.gitignore`. Trailing slash: it is always a directory. */
const IGNORE_ENTRY = '.hirayacoder/';

/** The comment written above the entry, so a reader knows what put it there. */
const IGNORE_COMMENT = '# HirayaCoder session data (audit log, transcripts, memory)';

/**
 * Does this `.gitignore` already have an opinion about `.hirayacoder`?
 *
 * Deliberately broad. `.hirayacoder`, `.hirayacoder/`, `/.hirayacoder`, `**\/.hirayacoder`,
 * and `!.hirayacoder` all count — the question is whether the user has already dealt
 * with this path, not whether they spelled it the way this module would.
 *
 * @param {string} contents
 * @returns {boolean}
 */
function alreadyIgnored(contents) {
  return String(contents || '')
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      // Strip the negation marker and any leading/trailing path decoration, then compare
      // on the bare name.
      const bare = trimmed
        .replace(/^!/, '')
        .replace(/^\*\*\//, '')
        .replace(/^\//, '')
        .replace(/\/$/, '');
      return bare === '.hirayacoder';
    });
}

/**
 * Add `.hirayacoder/` to the workspace's `.gitignore`, creating it if there is none.
 *
 * @param {string} workspaceRoot
 * @returns {'created' | 'appended' | 'present' | 'failed'} What happened, for the log
 *   and for tests. Never throws.
 */
function ensureGitignore(workspaceRoot) {
  if (!workspaceRoot) return 'failed';
  const file = path.join(workspaceRoot, '.gitignore');

  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `${IGNORE_COMMENT}\n${IGNORE_ENTRY}\n`, 'utf8');
      logger.info('Created .gitignore with .hirayacoder/ ignored.');
      return 'created';
    }

    const contents = fs.readFileSync(file, 'utf8');
    if (alreadyIgnored(contents)) return 'present';

    // Respect the file's own line ending, and never join the entry onto a last line
    // that has no newline of its own.
    const eol = contents.includes('\r\n') ? '\r\n' : '\n';
    const separator = contents.length === 0 || contents.endsWith('\n') ? '' : eol;
    fs.appendFileSync(file, `${separator}${eol}${IGNORE_COMMENT}${eol}${IGNORE_ENTRY}${eol}`, 'utf8');
    logger.info('Added .hirayacoder/ to the existing .gitignore.');
    return 'appended';
  } catch (err) {
    logger.warn(`Could not update .gitignore: ${/** @type {Error} */ (err).message}`);
    return 'failed';
  }
}

/**
 * Prepare a workspace for agent sessions.
 *
 * Safe to call repeatedly — on activation, and again whenever a chat tab opens. Both
 * halves are idempotent, and the environment profile is deliberately rewritten each
 * time rather than reused: a workspace synced between two machines must not report the
 * other one's operating system.
 *
 * @param {string | null} workspaceRoot
 * @returns {{profile: import('./environmentProfile').EnvironmentProfile, gitignore: string} | null}
 *   null when no workspace is open.
 */
function bootstrap(workspaceRoot) {
  if (!workspaceRoot) return null;

  const profile = environmentProfile.persist(workspaceRoot);
  const gitignore = ensureGitignore(workspaceRoot);

  logger.debug(`Workspace ready: ${profile.osName} (${profile.platform}), .gitignore ${gitignore}.`);
  return { profile, gitignore };
}

module.exports = { bootstrap, ensureGitignore, alreadyIgnored, IGNORE_ENTRY, IGNORE_COMMENT };
