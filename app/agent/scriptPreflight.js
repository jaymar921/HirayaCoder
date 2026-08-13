'use strict';

/**
 * Cheap checks that turn a doomed command into an answer instead of a failure.
 *
 * Everything here could be discovered by simply running the command — `npm run buld`
 * exits with "missing script" soon enough. The reason to check first is what the two
 * routes cost. Running it spends a confirmation click, a subprocess, up to two minutes,
 * and 400 tokens of npm output that a 3B model then has to interpret. Reading
 * `package.json` costs a stat and answers with the actual list of scripts, which is
 * both the diagnosis and the fix in one sentence.
 *
 * The bar for adding a check here: it must be decidable from the filesystem with
 * certainty, and being wrong must be impossible rather than unlikely. A guess that
 * blocks a command that would have worked is far worse than a failure that explains
 * itself — so `npm run build` is refused only when the script provably is not there,
 * never because it looks unusual.
 *
 * @module agent/scriptPreflight
 */

const fs = require('fs');
const path = require('path');

const pathGuard = require('../security/pathGuard');

/** Package managers whose `run` subcommand consults `package.json` scripts. */
const NODE_RUNNERS = new Set(['npm', 'yarn', 'pnpm']);

/**
 * The scripts npm defines whether or not `package.json` lists them.
 *
 * `npm test` on a package with no test script is a no-op that exits 0, not a missing
 * script, so it must not be refused here.
 */
const IMPLICIT_SCRIPTS = new Set(['test', 'start', 'install', 'stop', 'restart']);

/**
 * @typedef {object} PreflightRefusal
 * @property {string} code    Machine-readable, matching the runner's refusal codes.
 * @property {string} reason  What is wrong and what to do, addressed to the model.
 */

/**
 * Parse `npm run build` into its runner and script name.
 *
 * @param {string} command
 * @returns {{runner: string, script: string} | null}
 */
function parseRun(command) {
  const parts = String(command || '').trim().split(/\s+/);
  const runner = (parts[0] || '').split(/[/\\]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (!NODE_RUNNERS.has(runner)) return null;

  if (parts[1] === 'run' || parts[1] === 'run-script') {
    return parts[2] ? { runner, script: parts[2] } : null;
  }
  // `yarn build` is `yarn run build`. `npm build` is not — npm reserves the bare form.
  if (runner === 'yarn' && parts[1] && !parts[1].startsWith('-')) return { runner, script: parts[1] };
  return null;
}

/**
 * Read a package.json, or null if it is absent or unparseable.
 *
 * Unparseable counts as absent on purpose: this module exists to save a run, not to
 * become a second opinion on JSON validity. A broken manifest will produce a perfectly
 * clear error from npm itself.
 *
 * @param {string} directory
 * @returns {Record<string, any> | null}
 */
function readManifest(directory) {
  try {
    // The directory is confined by pathGuard before it reaches here.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check a command against the filesystem before anyone is asked to approve it.
 *
 * @param {object} params
 * @param {string} params.command
 * @param {string} [params.cwd]         Workspace-relative folder the command would run in.
 * @param {string} params.workspaceRoot
 * @returns {PreflightRefusal | null} null when there is no reason not to run it.
 */
function preflight({ command, cwd, workspaceRoot }) {
  const run = parseRun(command);
  if (!run || !workspaceRoot) return null;

  /** @type {string} */
  let directory;
  try {
    directory = cwd ? pathGuard.resolvePath(workspaceRoot, cwd).absolute : path.resolve(workspaceRoot);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (!fs.statSync(directory).isDirectory()) return null;
  } catch {
    // Not a usable folder — the gate refuses it with a better message than this module
    // could write, so say nothing.
    return null;
  }

  const manifest = readManifest(directory);
  if (!manifest) {
    const where = cwd ? `"${cwd}"` : 'the project root';
    return {
      code: 'NO_PACKAGE_JSON',
      reason:
        `there is no package.json in ${where}, so ${run.runner} has no scripts to run. ` +
        'Use list_files to find the folder that has one and set "cwd" to it, or create the project first.',
    };
  }

  const scripts = manifest.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  const available = Object.keys(scripts);
  if (!Object.prototype.hasOwnProperty.call(scripts, run.script) && !IMPLICIT_SCRIPTS.has(run.script)) {
    return {
      code: 'MISSING_SCRIPT',
      reason:
        `package.json has no "${run.script}" script. ` +
        (available.length
          ? `The scripts it does define are: ${available.join(', ')}. Run one of those.`
          : 'It defines no scripts at all, so there is nothing to run.'),
    };
  }

  // Only when the manifest actually declares dependencies. A package with none builds
  // perfectly well with no `node_modules`, and refusing that would be the exact kind of
  // confident wrongness this module is supposed to avoid.
  const declaresDependencies =
    Object.keys(manifest.dependencies || {}).length > 0 || Object.keys(manifest.devDependencies || {}).length > 0;
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (declaresDependencies && !fs.existsSync(path.join(directory, 'node_modules'))) {
    return {
      code: 'DEPENDENCIES_NOT_INSTALLED',
      reason:
        'this project\'s dependencies have never been installed — there is no node_modules folder. ' +
        `Run "npm install"${cwd ? ` with "cwd": "${cwd}"` : ''} first, then run this again.`,
    };
  }

  return null;
}

module.exports = { preflight, parseRun, NODE_RUNNERS, IMPLICIT_SCRIPTS };
