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
 * @property {boolean} [fixFirst]
 *   The failure is in the model's own work and can be repaired by editing a file it
 *   wrote. The loop must not offer "try something else, or finish" for these — the only
 *   correct next move is to fix the file and run the same command again.
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
  // Ordered before MISSING_DEPENDENCY, because Node reports a missing *file* and a
  // missing *package* with the same four words. Caught on `gemma3:1b` in a live run: it
  // ran `node src/main.js` before writing main.js, Node said
  // `Cannot find module 'C:\…\src\main.js'`, and the model was told to run npm install
  // — for a file it simply had not written yet. A specifier with a separator in it is a
  // path the code named; only a bare word is a package.
  {
    reason: 'WRONG_PATH',
    pattern: /(?:Cannot find module|Failed to resolve import) ['"](?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])[^'"]*['"]/i,
    summary: 'the file the command named does not exist',
    fix: 'That file is not there — it has not been written yet, or it is somewhere else. Use list_files to see what exists, then write the missing file. Do not install anything.',
  },
  {
    reason: 'MISSING_DEPENDENCY',
    // A bare specifier: no slash, no backslash, no leading dot. `@scope/name` is the one
    // package form with a separator, so it is admitted explicitly. The optional scope
    // and the name cannot claim the same characters — only the scope may contain `/`,
    // and it must — so there is one way to split any match.
    // eslint-disable-next-line security/detect-unsafe-regex -- unambiguous by construction
    pattern: /Cannot find module '(?:@[\w.-]+\/)?[\w.-]+'|Cannot find package|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|is not recognized as an internal or external command.*\bnpx\b/i,
    summary: 'a package the code imports is not installed',
    fix: 'A package is imported but not installed. Run the install command for this project first (npm install), then run this again — do not resend it before installing.',
  },
  {
    reason: 'WRONG_PATH',
    pattern: /ENOENT|no such file or directory|cannot find the (file|path) specified|Could not resolve entry module|MODULE_NOT_FOUND/i,
    summary: 'a path in the command or the code does not exist',
    fix: 'Something the command referred to is not there. Use list_files to see what actually exists before naming that path again — do not guess a second path.',
  },
  // The single most common way a Vite + Tailwind scaffold fails, and it defeated
  // `gemma4:e4b` on a run where everything else had gone right: `npm create vite` writes
  // `"type": "module"` into package.json, the model writes `postcss.config.js` with
  // `module.exports`, and Node refuses to load it. Before this rule the output matched
  // nothing — a ReferenceError is not a SyntaxError — so the model was handed forty
  // lines of Vite stack trace with no sentence saying what to do, and it moved on and
  // reported the app finished.
  {
    reason: 'MODULE_SYSTEM',
    pattern: /(?:module|require|exports) is not defined in ES module scope|Cannot use import statement outside a module|Failed to load PostCSS config|failed to load config from/i,
    summary: 'a config file uses the wrong module system for this project',
    fix:
      'This project is ESM ("type": "module" in package.json), so a config file cannot use `module.exports` or `require`. ' +
      'Fix the file named in the error: either rewrite it with `export default { … }`, or write the same content to the ' +
      'same name ending in `.cjs` and delete the `.js` one. Then run the command again.',
    fixFirst: true,
  },
  {
    reason: 'SYNTAX_ERROR',
    pattern: /SyntaxError|Unexpected token|Parse failure|error TS\d+|\berror: expected\b|Unterminated|Transform failed/i,
    summary: 'the code does not parse',
    fix: 'The code you wrote does not parse. Read the file at the line named in the error and write the whole file back corrected — do not run the command again first.',
    fixFirst: true,
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
      return {
        reason: rule.reason,
        summary: rule.summary,
        fix: rule.fix,
        retryable: Boolean(rule.retryable),
        fixFirst: Boolean(rule.fixFirst),
      };
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

  const matched = matchRules(result);
  if (matched) return matched;

  // A server that exits is a server that failed, whatever it printed on the way out.
  // Vite announces "VITE v5.4.21 ready in 2912 ms" and *then* dies on a bad config, so
  // the most recent line in the output says it worked — which is exactly what a model
  // reads and believes. Observed on `gemma4:e4b`: it had installed, scaffolded and
  // written every component correctly, ran `npm run dev`, got an exit code and forty
  // lines of stack trace matching no rule, and reported the app finished.
  if (isServerCommand(opts.command || '')) {
    return {
      reason: 'SERVER_EXITED',
      summary: 'the server quit instead of staying up',
      fix:
        'That command starts a server, so exiting at all means it failed to start — anything it printed before ' +
        'dying does not count. Read the error above, open the file it names, fix that file, and run the command ' +
        'again. Do not move on to anything else until it stays up.',
      retryable: false,
      fixFirst: true,
    };
  }

  return null;
}

module.exports = { diagnose, isServerCommand, RULES, SERVER_COMMAND };
