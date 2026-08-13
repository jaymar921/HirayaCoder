'use strict';

/**
 * Why a command failed, and what — if anything — is worth doing about it.
 *
 * A non-zero exit code is not a diagnosis. Handed `exit code 1` and 400 tokens of
 * npm output, a small model does one of three things: resends the identical command,
 * announces the build succeeded, or gives up on a task it was two steps from
 * finishing. All three were observed across the v0.5.3 model round.
 *
 * So every failed run is classified into one named reason, and each reason carries the
 * one sentence a model can act on. The categories are the ones that actually came up:
 * a dependency that was never installed, a path that does not exist, code that does
 * not parse, a permission the process does not have, a toolchain that is not on this
 * machine, and the network being the network.
 *
 * ## What is retryable, and what is emphatically not
 *
 * Only two of these get an automatic second attempt: a network blip and a file lock.
 * Both are the same command being right and the world being briefly wrong, which is
 * the entire definition of worth retrying.
 *
 * Nothing else is. A missing dependency is not fixed by running the failing command
 * again — it is fixed by installing the dependency, which is the model's job and takes
 * a different command. This distinction is the whole point: the damage in the testing
 * round came *from* retries, not from their absence. `ornith:9b` resent a refused
 * `javac` three times; automatic retry of the same class of failure would have made
 * that four, silently, and burned the step budget for a task that had otherwise
 * succeeded. Retrying is a narrow tool for a narrow problem.
 *
 * @module agent/scriptDiagnosis
 */

/**
 * @typedef {object} Diagnosis
 * @property {string} reason     Machine-readable category, e.g. 'MISSING_DEPENDENCY'.
 * @property {string} summary    What went wrong, one clause, for logs and the ledger.
 * @property {string} fix        What to do next, addressed to the model.
 * @property {boolean} retryable Whether re-running the identical command could help.
 */

/**
 * Ordered because the first match wins, and the specific patterns have to come before
 * the general ones — "Cannot find module './routes'" is a missing *file*, while
 * "Cannot find module 'express'" is a missing *dependency*, and both are ENOENT-ish
 * once you squint. Each rule states the fix in the imperative, naming a concrete next
 * command wherever there is one.
 *
 * @type {Array<{reason: string, pattern: RegExp, summary: string, fix: string, retryable?: boolean}>}
 */
const RULES = [
  {
    reason: 'NETWORK',
    pattern: /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED .*registry|ETIMEDOUT)\b|network request to .* failed|getaddrinfo/i,
    summary: 'the network was unreachable',
    fix: 'This is the network, not the command. It has been retried once already. If it failed again, the machine is offline — say so and continue with whatever does not need the network.',
    retryable: true,
  },
  {
    reason: 'LOCKED',
    pattern: /\b(EBUSY|EPERM: operation not permitted, (rename|unlink))\b|resource busy or locked/i,
    summary: 'a file was locked by another process',
    fix: 'Another process is holding a file open. It has been retried once already. If it still fails, say which file is locked rather than trying a third time.',
    retryable: true,
  },
  {
    reason: 'MISSING_SCRIPT',
    pattern: /missing script:|npm ERR! Missing script|Unknown command|task .* not found/i,
    summary: 'the package script does not exist',
    fix: 'That script is not in package.json. Read package.json to see which scripts exist, and run one of those — do not invent a script name.',
  },
  {
    reason: 'NO_PACKAGE_JSON',
    pattern: /ENOENT.*package\.json|Could not read package\.json|no such file or directory, open '.*package\.json'/i,
    summary: 'there is no package.json where the command ran',
    fix: 'There is no package.json in that folder. If the project lives in a subfolder, set "cwd" to it. If it has not been created yet, create it before installing or building.',
  },
  {
    reason: 'MISSING_DEPENDENCY',
    pattern: /Cannot find module '[^.'/][^']*'|Cannot find package|ERR_MODULE_NOT_FOUND|Failed to resolve import|ModuleNotFoundError|is not recognized as an internal or external command.*\bnpx\b/i,
    summary: 'a package the code imports is not installed',
    fix: 'A package is imported but not installed. Run the install command for this project first (npm install), then run this again — do not resend it before installing.',
  },
  {
    reason: 'WRONG_PATH',
    pattern: /ENOENT|no such file or directory|cannot find the (file|path) specified|Could not resolve entry module/i,
    summary: 'a path in the command or the code does not exist',
    fix: 'Something the command referred to is not there. Use list_files to see what actually exists before naming that path again — do not guess a second path.',
  },
  {
    reason: 'SYNTAX_ERROR',
    pattern: /SyntaxError|Unexpected token|Parse failure|error TS\d+|\berror: expected\b|Unterminated|Transform failed/i,
    summary: 'the code does not parse',
    fix: 'The code you wrote does not parse. Read the file at the line named in the error and write the whole file back corrected — do not run the command again first.',
  },
  {
    reason: 'PERMISSION',
    pattern: /\b(EACCES|EPERM)\b|permission denied|Access is denied/i,
    summary: 'the process lacks permission',
    fix: 'This needs a permission the extension does not have and cannot grant itself. Tell the user what to run themselves, and carry on with the rest of the task.',
  },
  {
    reason: 'PORT_IN_USE',
    pattern: /\bEADDRINUSE\b|address already in use|Port \d+ is (already )?in use/i,
    summary: 'the port is already taken',
    fix: 'Something is already listening on that port — very likely the server you started earlier. You do not need a second one running to check your work.',
  },
  {
    reason: 'ENVIRONMENT',
    pattern: /is not recognized as an internal or external command|command not found|: not found\b|Unable to locate a Java Runtime|requires Node\.js version|Unsupported engine/i,
    summary: 'a required program is missing or the wrong version',
    fix: 'The toolchain this needs is not on this machine. Name what the user has to install, and continue with whatever you can do without it.',
  },
];

/**
 * Commands that are meant never to exit.
 *
 * `npm run dev` succeeding looks exactly like `npm run dev` hanging: the process is
 * alive and printing nothing new. Given a task that says "confirm npm run dev starts
 * without errors", every model in the v0.5.3 round did precisely that, and every one
 * of them spent the full two-minute timeout on it and read the kill as a failure.
 *
 * Matched on the whole command rather than the binary, because `npm run build` and
 * `npm run dev` are the same binary with opposite lifetimes.
 */
const SERVER_COMMAND = /\b(dev|start|serve|preview|watch)\b|\b(vite|nodemon|http-server|live-server)\b|--watch\b/;

/**
 * Does this command start something that stays up until it is killed?
 *
 * @param {string} command
 * @returns {boolean}
 */
function isServerCommand(command) {
  const text = String(command || '').toLowerCase();
  // `npm run start:build` is a build; `npm test -- --watch` genuinely is a watcher.
  if (/\brun\s+build\b|\bbuild\b(?!.*--watch)/.test(text) && !/--watch/.test(text)) return false;
  return SERVER_COMMAND.test(text);
}

/**
 * The first rule whose pattern appears in either stream.
 *
 * @param {{stdout?: string, stderr?: string}} result
 * @returns {Diagnosis | null}
 */
function matchRules(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (!text.trim()) return null;

  for (const rule of RULES) {
    if (rule.pattern.test(text)) {
      return { reason: rule.reason, summary: rule.summary, fix: rule.fix, retryable: Boolean(rule.retryable) };
    }
  }
  return null;
}

/**
 * Classify a failed run.
 *
 * Both streams are searched, and stderr first: a build tool that writes its errors to
 * stdout is common enough that reading only stderr misses them, but when both have
 * something to say the error stream is the one that means it.
 *
 * @param {{stdout?: string, stderr?: string, timedOut?: boolean, code?: number | null}} result
 * @param {object} [opts]
 * @param {string} [opts.command] Used only to tell a hung server from a hung build.
 * @returns {Diagnosis | null} null when the failure says nothing recognizable.
 */
function diagnose(result, opts = {}) {
  if (!result) return null;

  if (result.timedOut) {
    // A server that printed `EADDRINUSE` and then sat there is not "a server doing what
    // servers do" — it is a broken start that happens to have no exit code, and saying
    // so is the difference between the model fixing the port and the model believing it
    // has a working dev server. Only definite failures outrank the timeout, though: a
    // retryable one is ignored here, because a command that already spent the entire
    // budget is not something to run a second time on the chance the network was flaky.
    const specific = matchRules(result);
    if (specific && !specific.retryable) return specific;

    return isServerCommand(opts.command || '')
      ? {
          reason: 'SERVER_STILL_RUNNING',
          summary: 'the command was a server and did not exit',
          fix: 'That command starts a server and never returns on its own. It does not need running again — build the project to check it compiles.',
          retryable: false,
        }
      : {
          reason: 'TIMEOUT',
          summary: 'the command hit the time limit',
          fix: 'It was still going at the time limit and was stopped. Running it again would take just as long — either it needs more time than the agent has, or it is waiting for something that will not arrive.',
          retryable: false,
        };
  }

  return matchRules(result);
}

module.exports = { diagnose, isServerCommand, RULES, SERVER_COMMAND };
