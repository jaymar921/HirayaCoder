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
 * `fix` may be a function of the match when the sentence has to name what the error
 * named. "Something is undefined" is not actionable to a 1B model; "`addTodo` is used
 * in that file but never defined or imported" is the same information with the one
 * detail that makes it a next move.
 *
 * @type {Array<{reason: string, pattern: RegExp, summary: string | ((m: RegExpExecArray) => string), fix: string | ((m: RegExpExecArray) => string), retryable?: boolean, fixFirst?: boolean}>}
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
  // Tailwind 4 moved its PostCSS plugin into `@tailwindcss/postcss`, and the config
  // every model writes from memory is the Tailwind 3 one. `npm install tailwindcss`
  // now gets v4, so this fires on essentially every Vite + Tailwind scaffold a model
  // produces. Caught live on `qwen3.5:4b`, where it left Vite serving 500s.
  {
    reason: 'TAILWIND_PLUGIN_MOVED',
    pattern: /tailwindcss` directly as a PostCSS plugin|install `?@tailwindcss\/postcss`?/i,
    summary: 'this Tailwind version keeps its PostCSS plugin in a separate package',
    fix:
      'Tailwind 4 split the PostCSS plugin out. Install `@tailwindcss/postcss`, then change postcss.config.js to ' +
      'use `"@tailwindcss/postcss": {}` in place of `tailwindcss: {}`. Then run the command again.',
    fixFirst: true,
  },
  // ── Undefined symbols ────────────────────────────────────────────────────────
  //
  // The single most common way code written by a small model fails at runtime, and
  // until 0.7.0 none of it matched a rule: the model got a stack trace, the generic
  // "the error points at a file" fallback, and no mention of the name that was
  // actually missing. It then rewrote the file from memory and produced the same
  // error, which is the loop these rules exist to break.
  //
  // Ordered after MODULE_SYSTEM, which claims the one `is not defined` that is really
  // a module-system mismatch (`module is not defined in ES module scope`) and has a
  // completely different fix.
  {
    reason: 'UNDEFINED_SYMBOL',
    pattern: /ReferenceError:\s*(\w+) is not defined/,
    summary: (m) => `${m[1]} is used but never defined`,
    fix: (m) =>
      `\`${m[1]}\` is used in that file but is never defined or imported there. Open the file the error names and ` +
      `either import \`${m[1]}\` from the file that exports it, or define it. If you meant a name that already ` +
      'exists, check the spelling matches exactly — it is case-sensitive. Then run the command again.',
    fixFirst: true,
  },
  {
    reason: 'UNDEFINED_SYMBOL',
    pattern: /NameError: name '([^']+)' is not defined/,
    summary: (m) => `${m[1]} is used but never defined`,
    fix: (m) =>
      `\`${m[1]}\` is used in that file but is never defined or imported there. Open the file the error names and ` +
      `either add the import for \`${m[1]}\`, or define it above where it is used. Then run the command again.`,
    fixFirst: true,
  },
  {
    reason: 'UNDEFINED_SYMBOL',
    // javac prints the location, then `symbol: variable foo` on a later line.
    pattern: /cannot find symbol[\s\S]{0,300}?symbol:\s*(?:variable|method|class)\s+(\w+)/,
    summary: (m) => `${m[1]} does not exist where it is used`,
    fix: (m) =>
      `javac cannot find \`${m[1]}\`. Either it is spelled differently where it is declared, or the class that ` +
      'declares it is not imported, or it was never written. Open the file and line the error names, check that ' +
      'name against where you defined it, and fix whichever side is wrong. Then compile again.',
    fixFirst: true,
  },
  {
    reason: 'UNDEFINED_PROPERTY',
    // Node ≥16 phrasing, then the older one. Both name the property being read.
    pattern: /Cannot read properties of (undefined|null) \(reading '([^']+)'\)|Cannot read property '([^']+)' of (undefined|null)/,
    summary: (m) => `something was ${m[1] || m[4]} when '${m[2] || m[3]}' was read from it`,
    fix: (m) => {
      const property = m[2] || m[3];
      const value = m[1] || m[4];
      return (
        `The value that \`${property}\` was read from is ${value} at that point — the property is fine, the thing ` +
        `holding it does not exist yet. Open the file and line the error names and work out why it is ${value}: a ` +
        'function that returned nothing, a prop or argument never passed in, state read before it was set, or an ' +
        `import that did not resolve. Fix the source of the ${value}, not the line that read it. Then run it again.`
      );
    },
    fixFirst: true,
  },
  {
    reason: 'UNDEFINED_PROPERTY',
    pattern: /AttributeError: '(\w+)' object has no attribute '([^']+)'/,
    summary: (m) => `a ${m[1]} has no attribute '${m[2]}'`,
    fix: (m) =>
      `\`${m[2]}\` was read from a \`${m[1]}\`, which does not have it.` +
      (m[1] === 'NoneType'
        ? ' NoneType means the value is None — something returned None where an object was expected, so fix whatever produced the None rather than the line that used it.'
        : ` Either the attribute is spelled differently on that class, or the object is not the type you expected. Open the file the error names and check what \`${m[1]}\` actually defines.`) +
      ' Then run it again.',
    fixFirst: true,
  },
  {
    reason: 'NOT_A_FUNCTION',
    pattern: /TypeError: ([\w.]+) is not a function/,
    summary: (m) => `${m[1]} is not a function`,
    fix: (m) =>
      `\`${m[1]}\` is being called, but what is there is not a function — commonly a wrong import shape ` +
      '(default vs named), a typo, or a value that is undefined. Open the file the error names, check how ' +
      `\`${m[1]}\` is imported against how the other file exports it, and fix whichever side is wrong. ` +
      'Then run the command again.',
    fixFirst: true,
  },
  {
    reason: 'NULL_DEREFERENCE',
    pattern: /NullPointerException/,
    summary: 'something was null when it was used',
    fix:
      'A value was null where an object was expected. Open the file and line named in the stack trace, find which ' +
      'reference is null there, and fix what should have set it — initialise the field, pass the argument, or ' +
      'check for null before using it. Then run it again.',
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
 * Folders whose files are nobody's to edit — a stack trace runs through them on the way
 * to the one file that matters.
 */
const NOT_YOURS = /(?:^|[/\\])(?:node_modules|dist|build|\.vite|\.next|out)[/\\]/i;

/**
 * A path with a source-file extension, as it appears anywhere in a line of output.
 *
 * Each repetition must consume a separator and at least one character after it, so no
 * two ways of splitting the same token exist — the same construction `completionCheck`
 * uses, and unambiguous for the same reason.
 */
/* eslint-disable-next-line security/detect-unsafe-regex -- unambiguous by construction */
const PATH_IN_OUTPUT = /[\w@.-]+(?:[/\\][\w@.-]+)*\.(?:jsx?|tsx?|mjs|cjs|css|s[ac]ss|html?|json|md|ya?ml|py|java|go|rs|rb|php|vue|svelte)\b/gi;

/**
 * The project file an unrecognised error points at, if it points at one.
 *
 * This is the answer to "what happens when the error is one nobody wrote a rule for".
 * A rule list only ever covers the failures somebody has already seen; every new
 * toolchain version invents another. But nearly every build error names the file it
 * choked on, and "open the file the error names and fix what it says" is a correct
 * instruction without anyone having to know what the error means.
 *
 * Files under `node_modules` and build output are skipped — a Tailwind stack trace runs
 * four frames deep through `node_modules/postcss` before it mentions `src/index.css`,
 * and only the last of those is the model's to edit.
 *
 * @param {string} text
 * @returns {string | null}
 */
function fileFromError(text) {
  for (const match of String(text).match(PATH_IN_OUTPUT) || []) {
    const candidate = match.replace(/^\.[/\\]/, '');
    if (NOT_YOURS.test(candidate)) continue;
    // A bare `package.json` in a line of npm chatter is not a location. A path with a
    // folder in it, or a config file at the root, is.
    if (!/[/\\]/.test(candidate) && !/\.config\.[cm]?[jt]s$/i.test(candidate)) continue;
    return candidate.replace(/\\/g, '/');
  }
  return null;
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
    // `exec` rather than `test` so a rule whose sentence names what the error named
    // has the capture groups to name it with. None of these patterns are global, so
    // there is no `lastIndex` to reset between calls.
    const match = rule.pattern.exec(text);
    if (match) {
      return {
        reason: rule.reason,
        summary: typeof rule.summary === 'function' ? rule.summary(match) : rule.summary,
        fix: typeof rule.fix === 'function' ? rule.fix(match) : rule.fix,
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

  const text = `${result.stderr || ''}\n${result.stdout || ''}`;

  if (result.timedOut) {
    // A server that printed `EADDRINUSE` and then sat there is not "a server doing what
    // servers do" — it is a broken start that happens to have no exit code, and saying
    // so is the difference between the model fixing the port and the model believing it
    // has a working dev server. Only definite failures outrank the timeout, though: a
    // retryable one is ignored here, because a command that already spent the entire
    // budget is not something to run a second time on the chance the network was flaky.
    const specific = matchRules(result);
    if (specific && !specific.retryable) return specific;

    // A server killed at the probe deadline while printing errors the whole time is the
    // case that got through: Vite kept running and served nothing but 500s. The probe
    // decides whether it started; this decides what to say once it has not.
    const brokenFile = fileFromError(text);
    if (brokenFile && isServerCommand(opts.command || '')) {
      return {
        reason: 'UNRECOGNISED',
        summary: `it kept running but was failing on ${brokenFile}`,
        fix:
          `It stayed up, but it was reporting errors the whole time — read them literally: they name ${brokenFile}. ` +
          `Open ${brokenFile}, change what the error says is wrong, and run the command again.`,
        retryable: false,
        fixFirst: true,
      };
    }

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

  // No rule knew this one. If the error names a file the model could open, that is
  // enough to act on without anyone having classified the failure first — see
  // `fileFromError`.
  const file = fileFromError(text);
  if (file) {
    return {
      reason: 'UNRECOGNISED',
      summary: `the command failed and the error points at ${file}`,
      fix:
        `This failure has not been seen before, so read the error above literally: it names ${file}. ` +
        `Open ${file}, change what the error says is wrong with it, and run the same command again. ` +
        'If the error asks for a package to be installed, install it first.',
      retryable: false,
      fixFirst: true,
    };
  }

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

module.exports = { diagnose, isServerCommand, fileFromError, RULES, SERVER_COMMAND };
