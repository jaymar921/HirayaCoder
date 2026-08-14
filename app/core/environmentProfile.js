'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Every fs call here targets a path built from the VS Code workspace root and a fixed
 * filename. No component derives from model output. */

/**
 * What machine this is, told to the model instead of left for it to guess.
 *
 * ## The failure this exists for
 *
 * A live macOS run of the React TODO benchmark on 0.6.0, `ornith:9b`, eight steps, four
 * of them refused. Three of the four were the model reaching for shell syntax it had no
 * way to know was unavailable:
 *
 *     mkdir -p todo-glass-app && cd todo-glass-app && npm create vite@latest .
 *     mkdir -p todo-glass-app
 *     cd todo-glass-app && npm install
 *
 * `mkdir -p` is POSIX; the same model on Windows proposes `mkdir` with no flag, or `md`.
 * Both are wrong here for the same reason — there is no shell and `mkdir` is not on the
 * allow-list — but the model had nothing in its prompt saying so, and nothing saying
 * which OS it was on either. It was guessing at the platform *and* at the execution
 * model, and a guess that is wrong on both is refused three times before the step dies.
 *
 * The fix is not a better refusal message. It is that the model should never have been
 * guessing: the extension knows the platform exactly, at no cost, before the first token
 * is generated. So it says so, once, in the system prompt.
 *
 * ## Why this is also written to disk
 *
 * `.hirayacoder/environment.json` is not read back by the prompt path — the profile is
 * recomputed each session, because a workspace opened on a different machine must not
 * inherit the last machine's answer. The file is there so the *user* can see what the
 * agent was told, the same way `audit.log` shows what it did, and so a benchmark run
 * carries its platform with it. Every one of the eleven benchmark folders in this repo
 * had to have its OS reconstructed from the shape of the commands the model tried.
 *
 * @module core/environmentProfile
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const logger = require('../utils/logger');
const { platformName } = require('../utils/platform');

/** Where the profile is persisted, relative to the workspace root. */
const PROFILE_PATH = '.hirayacoder/environment.json';

/**
 * @typedef {object} EnvironmentProfile
 * @property {'win32' | 'darwin' | 'linux' | 'other'} platform
 * @property {string} osName          Human-readable, e.g. 'macOS'.
 * @property {string} osVersion       `os.release()`, as reported.
 * @property {string} arch
 * @property {'cmd' | 'sh'} commandStyle
 *   Which family a *user* would type these commands in. Not what HirayaCoder spawns —
 *   it spawns no shell at all — but the right answer to "what would this command look
 *   like here", which is what a model needs when it tells the user to run something.
 * @property {string} pathSeparator
 * @property {string} nodeVersion
 * @property {string} generatedAt     ISO timestamp of this detection.
 */

/**
 * The display name for a platform.
 *
 * @param {ReturnType<typeof platformName>} name
 * @returns {string}
 */
function osNameFor(name) {
  if (name === 'win32') return 'Windows';
  if (name === 'darwin') return 'macOS';
  if (name === 'linux') return 'Linux';
  return 'an unrecognised Unix-like system';
}

/**
 * Detect the machine this session is running on.
 *
 * Pure inspection of `os` and `process` — no spawning, no filesystem probing, nothing
 * that could fail or take a measurable amount of time. This runs on every session start
 * and must stay free.
 *
 * @param {object} [overrides] For tests.
 * @param {string} [overrides.platform]
 * @param {string} [overrides.release]
 * @param {string} [overrides.arch]
 * @returns {EnvironmentProfile}
 */
function detect(overrides = {}) {
  const name = platformName(overrides.platform || os.platform());

  return {
    platform: name,
    osName: osNameFor(name),
    osVersion: overrides.release || os.release(),
    arch: overrides.arch || os.arch(),
    commandStyle: name === 'win32' ? 'cmd' : 'sh',
    pathSeparator: name === 'win32' ? '\\' : '/',
    nodeVersion: process.versions.node,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * The platform-specific half of the prompt block.
 *
 * Kept to the differences that actually changed a model's behaviour in the benchmark
 * runs. A longer list of trivia costs Tier B budget it does not have — at Medium
 * capacity a 1B model has roughly 1800 tokens for everything.
 *
 * @param {EnvironmentProfile} profile
 * @returns {string[]}
 */
function platformNotes(profile) {
  if (profile.platform === 'win32') {
    return [
      'This is Windows: paths a user types use backslashes, and there is no `mkdir -p`, ' +
        '`rm -rf`, `ls`, `cat`, `touch`, or `&&` available to you.',
      'When you tell the user a command to run themselves, write it for cmd/PowerShell, not bash.',
    ];
  }

  return [
    `This is ${profile.osName}: a user's own shell is POSIX, but you are not running in one — ` +
      '`mkdir -p`, `rm -rf`, `ls`, `cat`, `touch`, and `&&` are all unavailable to you here.',
    'When you tell the user a command to run themselves, write it for bash/zsh.',
  ];
}

/**
 * The block that goes into the system prompt.
 *
 * Two things at once, and both halves are load-bearing. The platform facts stop the
 * model guessing at the OS. The execution-model sentence stops it assuming that knowing
 * the OS means it has that OS's shell — which is the more expensive mistake, because a
 * model told "this is macOS" and nothing else proposes `mkdir -p` with *more*
 * confidence, not less.
 *
 * Written as statements of fact rather than rules. This is not a policy the model is
 * being asked to follow; it is the machine it is standing on.
 *
 * ## Why the mutating half is optional
 *
 * Plan mode does not have `write_file`, `create_folder`, or `run_script` — they are
 * absent from the schema, not merely refused, and that structural guarantee is what
 * Plan mode *is*. A block naming them would be the one place in a Plan prompt that
 * tells the model it can run commands, which is exactly the confusion the mode exists
 * to prevent. So the platform facts are carried everywhere the block is used, and the
 * lines about acting are carried only where acting is possible.
 *
 * @param {EnvironmentProfile} profile
 * @param {object} [opts]
 * @param {boolean} [opts.mutating]  Does this route actually offer the write tools?
 *   Defaults to true; `promptRouter` passes the route's own answer.
 * @returns {string}
 */
function render(profile, opts = {}) {
  const mutating = opts.mutating !== false;

  const lines = [
    'Environment — this is the machine you are running on right now. It is detected, not ' +
      'guessed, so never speculate about the operating system or ask the user what it is:',
    `- Operating system: ${profile.osName} (${profile.platform} ${profile.osVersion}, ${profile.arch})`,
    `- Node.js: v${profile.nodeVersion}`,
    ...platformNotes(profile).map((note) => `- ${note}`),
  ];

  if (mutating) {
    lines.push(
      '- run_script does not use a shell on any platform. One plain command per call, no ' +
        'operators, no chaining, no redirects. To run inside a subfolder pass it as "cwd" ' +
        '(`{"command": "npm install", "cwd": "todo-glass-app"}`) — never `cd`.',
      '- To make a folder use the create_folder tool, to list one use list_files, to read a ' +
        'file use read_file, and to write one use write_file. Those replace the shell ' +
        'utilities on every platform.'
    );
  } else {
    lines.push('- To list a folder use list_files, and to read a file use read_file.');
  }

  return lines.join('\n');
}

/**
 * Persist the profile for the user to read, best-effort.
 *
 * Failure is logged and swallowed. Nothing in the prompt path reads this file, so a
 * read-only workspace or a full disk must not be able to stop a session starting.
 *
 * @param {string} workspaceRoot
 * @param {EnvironmentProfile} [profile]
 * @returns {EnvironmentProfile} The profile, written or not.
 */
function persist(workspaceRoot, profile = detect()) {
  if (!workspaceRoot) return profile;

  const file = path.join(workspaceRoot, ...PROFILE_PATH.split('/'));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger.warn(`Could not write ${PROFILE_PATH}: ${/** @type {Error} */ (err).message}`);
  }

  return profile;
}

module.exports = { detect, render, persist, platformNotes, osNameFor, PROFILE_PATH };
