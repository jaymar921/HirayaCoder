'use strict';

/**
 * Run a single shell command.
 *
 * All of the danger lives one layer down, in `permissionGate` → `scriptRunner`:
 * allow-listed binaries, no shell interpretation, always-confirm rules for anything
 * that publishes or reaches the network. This tool's only job is to ask, run, and
 * turn the result into an observation a small model can act on.
 *
 * That last part matters more than it sounds. Handing a 1B model 4,000 lines of
 * webpack output is worse than useless — it buries the one line that says what
 * broke. So output is condensed with the tail favored, since errors surface at the
 * end.
 *
 * @module agent/tools/runScript
 */

const { truncateToTokens } = require('../../utils/tokenBudget');
const { redact } = require('../../security/secretsScanner');
const { diagnose, isServerCommand } = require('../scriptDiagnosis');
const { preflight } = require('../scriptPreflight');
const logger = require('../../utils/logger');

/** Per-stream budget for what goes back into the prompt. */
const OUTPUT_TOKENS = 400;

/**
 * How long a server is watched before it is stopped and called started.
 *
 * Long enough for a bundler to compile and for a port collision or a syntax error to
 * surface, short enough that being wrong about it costs seconds rather than the whole
 * two-minute script budget. Vite and CRA both print their startup banner well inside
 * this; anything that has not failed by now was going to keep running.
 */
const PROBE_MS = 20000;

/**
 * Did a server fall over during the probe, as opposed to simply staying up?
 *
 * Being killed at the probe deadline is the *expected* outcome, so the exit status
 * says nothing. What separates "started" from "broke" is whether it complained on the
 * way — a port collision, a config error, a module it could not resolve.
 *
 * @param {import('../../security/scriptRunner').RunResult} result
 * @returns {boolean}
 */
function looksLikeStartupFailure(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  return /\b(EADDRINUSE|ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|failed to load config|Transform failed)\b/i.test(
    text
  );
}

/**
 * Shell commands that have a HirayaCoder tool doing the same job.
 *
 * The allow-list will never contain these — `rm`, `mkdir`, and friends are precisely
 * the programs it exists to keep out, since a tool that can move or destroy files
 * without going through the permission gate makes the gate decorative. But "not in the
 * allowed program list" is only true, not useful: the model wanted a directory, and the
 * answer is that it already has one way to get it.
 *
 * Observed on `ornith:9b`, asked to build a Java project in `src/main/java`: it opened
 * with `mkdir -p src/main/java build`, was refused, and sent the identical line twice
 * more until the repeat guard ended the item — which the user then saw as a failed step
 * in a task that had otherwise succeeded. It never needed the directory at all.
 * `write_file` creates parent directories on the way to the file (`writeFile.js`,
 * `fs.mkdir` with `recursive: true`), so the very next step would have made
 * `src/main/java` by itself. Later in the same run it reached for `ls build/` to check
 * the compile output, where `list_files` was sitting unused.
 *
 * Each entry names the tool instead of the prohibition. Keyed on the bare binary name,
 * which is what the model typed; the arguments are irrelevant to the redirect.
 *
 * @type {Map<string, string>}
 */
const MKDIR_INSTEAD =
  'You usually do not need this at all: write_file creates any missing folders on the way to the file, so ' +
  'writing src/main/java/TodoApp.java makes src/main/java by itself. If you do need the empty folder on its ' +
  'own, use the create_folder tool.';

const TOOL_INSTEAD_OF = new Map([
  // 0.3.0 answered `mkdir` with "you do not need to create directories at all", which is
  // true and which models read three times before giving up anyway. It still leads with
  // the cheaper route, but there is now a tool behind the sentence instead of a puzzle.
  ['mkdir', MKDIR_INSTEAD],
  ['md', MKDIR_INSTEAD],
  ['ls', 'Use the list_files tool to see what is in a folder.'],
  ['dir', 'Use the list_files tool to see what is in a folder.'],
  ['tree', 'Use the list_files tool to see what is in a folder.'],
  ['cat', 'Use the read_file tool to read a file.'],
  ['head', 'Use the read_file tool to read a file.'],
  ['tail', 'Use the read_file tool to read a file.'],
  ['more', 'Use the read_file tool to read a file.'],
  ['type', 'Use the read_file tool to read a file.'],
  ['grep', 'Use the search_workspace tool to find text in the project.'],
  ['findstr', 'Use the search_workspace tool to find text in the project.'],
  ['rg', 'Use the search_workspace tool to find text in the project.'],
  ['ag', 'Use the search_workspace tool to find text in the project.'],
  ['find', 'Use the search_workspace tool to find text, or list_files to see what exists.'],
  ['rm', 'Use the delete_file tool to remove a file, or the delete_folder tool to remove a folder.'],
  ['del', 'Use the delete_file tool to remove a file.'],
  // Pointed at delete_file until 0.4.0, which refuses directories — so the redirect sent
  // the model to a tool that could only say no. Observed live: after that refusal the
  // model told the user the folder "has been removed from the workspace", and it had not.
  ['rmdir', 'Use the delete_folder tool to remove a folder.'],
  ['rd', 'Use the delete_folder tool to remove a folder.'],
  ['unlink', 'Use the delete_file tool to remove a file.'],
  ['touch', 'Use write_file to create the file, with its full contents.'],
  ['echo', 'Use write_file to put content in a file. There is nothing to print to.'],
  ['cp', 'Use read_file to get the contents, then write_file to save them at the new path.'],
  ['copy', 'Use read_file to get the contents, then write_file to save them at the new path.'],
  ['mv', 'Use read_file, then write_file at the new path, then delete_file on the old one.'],
  ['move', 'Use read_file, then write_file at the new path, then delete_file on the old one.'],
  ['sed', 'Use read_file to get the file, then write_file with the complete corrected contents.'],
  ['awk', 'Use read_file to get the file, then write_file with the complete corrected contents.'],
  ['pwd', 'Commands run at the workspace root unless you set run_script\'s "cwd", so there is nothing to check.'],
  [
    'cd',
    'A command cannot change directory. To run inside a subfolder, keep the command itself plain and pass the ' +
      'folder as run_script\'s "cwd" instead — {"command": "npm install", "cwd": "todo-glass-app"}.',
  ],
]);

/**
 * The tool that does what a refused command was reaching for, if there is one.
 *
 * @param {string} command
 * @returns {string} The redirect, or '' when nothing here covers it.
 */
function toolForRefusedCommand(command) {
  const first = String(command || '').trim().split(/\s+/)[0] || '';
  const binary = first.split(/[/\\]/).pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return TOOL_INSTEAD_OF.get(binary) || '';
}

/**
 * What to do about a refusal the same command can never survive.
 *
 * The refusal messages were already informative — "not in the allowed program list",
 * with the list — and models retried the identical command anyway. Observed on
 * `ornith:9b`, asked to compile some Java: `javac …` was refused, and it sent the exact
 * same line three more times until the repeat guard ended the item. The user got
 * "stopped: repeating" instead of "you need a JDK, here is the command to run".
 *
 * Saying the reason is not the same as saying what to do instead. Each of these is a
 * dead end for *this* command, so each says so outright and names the way forward. It
 * is the same lesson as the declined-delete hint: a refusal is a decision to work
 * within, not an obstacle to route around.
 *
 * @param {string | undefined} code
 * @param {string} [command] The refused command, used to name the tool that replaces it.
 * @returns {string} Text to append to the observation, or '' when a retry is sensible.
 */
function nextStepAfterRefusal(code, command) {
  switch (code) {
    case 'BINARY_NOT_ALLOWED': {
      // A tool that already does the job outranks the generic advice below. "Tell the
      // user which command to run themselves" is the wrong answer for `mkdir`, where
      // the agent was one step away from doing it correctly on its own.
      const redirect = toolForRefusedCommand(command);
      if (redirect) {
        return ` Do not send it again — it will be refused identically. ${redirect}`;
      }
      return (
        ' Sending it again will be refused identically — do not retry it. Either use one of the allowed ' +
        'programs, or stop and tell the user which command they should run themselves and why.'
      );
    }
    case 'BINARY_NOT_FOUND':
      return (
        ' It is allowed but not installed on this machine, so no retry will find it. Tell the user what ' +
        'to install, and continue with whatever you can do without it.'
      );
    case 'SHELL_METACHARACTER':
      return (
        ' Do not resend this line. Propose one plain command, with no operators, redirects, or chaining. ' +
        'If you were chaining `cd folder && …`, drop the `cd` and pass the folder as "cwd" instead.'
      );
    case 'CWD_NOT_FOUND':
    case 'CWD_NOT_A_DIRECTORY':
      return (
        ' Check what actually exists with list_files before choosing "cwd" — the path is relative to the ' +
        'workspace root, so it is "todo-glass-app", never "./todo-glass-app/src/.." or an absolute path.'
      );
    case 'USER_DENIED':
      return (
        ' That was the user deciding, not an error to work around. Do not retry it and do not achieve the ' +
        'same effect another way. Carry on with the rest of the task.'
      );
    default:
      return '';
  }
}

/**
 * Turn a completed run into an observation.
 *
 * @param {string} command
 * @param {import('../../security/scriptRunner').RunResult} result
 * @param {number} budget
 * @param {string} [cwd] Workspace-relative folder it ran in, when not the root.
 * @param {object} [extra]
 * @param {import('../scriptDiagnosis').Diagnosis | null} [extra.diagnosis]
 * @param {number} [extra.attempts]
 * @returns {string}
 */
function describeRun(command, result, budget, cwd, extra = {}) {
  const parts = [];
  // Named on every line so the model does not lose track of which project it is in
  // across a run that touches both the root and a scaffolded subfolder.
  const where = cwd ? ` in \`${cwd}\`` : '';

  if (result.timedOut) {
    parts.push(`\`${command}\`${where} was still running after the time limit and was stopped.`);
  } else {
    parts.push(`\`${command}\`${where} finished with exit code ${result.code}.`);
  }

  // stderr first: when something fails, that is where the reason is.
  const stderr = redact(result.stderr || '').trim();
  const stdout = redact(result.stdout || '').trim();

  if (stderr) {
    parts.push(`Error output:\n${truncateToTokens(stderr, budget, { keep: 'tail' }).text}`);
  }
  if (stdout) {
    parts.push(`Output:\n${truncateToTokens(stdout, budget, { keep: 'tail' }).text}`);
  }
  if (!stderr && !stdout) {
    parts.push('It produced no output.');
  }

  // Last, so it is the final thing in the model's context before it decides — and
  // phrased as an instruction rather than an observation, because a small model reading
  // 400 tokens of stack trace needs to be told which sentence was the actionable one.
  if (extra.diagnosis) {
    const retried = extra.attempts > 1 ? ' It was run twice, with the same result.' : '';
    parts.push(`What went wrong: ${extra.diagnosis.summary}.${retried} ${extra.diagnosis.fix}`);
  }

  return parts.join('\n');
}

/**
 * Report a server that was started, watched, and stopped.
 *
 * @param {string} command
 * @param {import('../../security/scriptRunner').RunResult} result
 * @param {number} budget
 * @param {string} [cwd]
 * @returns {string}
 */
function describeServerProbe(command, result, budget, cwd) {
  const where = cwd ? ` in \`${cwd}\`` : '';
  const output = redact(`${result.stdout || ''}\n${result.stderr || ''}`).trim();
  const seconds = Math.round(result.durationMs / 1000);

  return [
    `\`${command}\`${where} started and was still running after ${seconds}s with no startup errors, ` +
      'so it works. It has been stopped — a server that keeps running would hold the session open ' +
      'forever, and there is no browser here to look at it.',
    output ? `Output:\n${truncateToTokens(output, budget, { keep: 'head' }).text}` : '',
    'Do not run it again. If you need to verify the project builds, build it.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * @param {{command: string, cwd?: string}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function runScript(args, context) {
  const command = String(args.command || '').trim();
  if (!command) {
    return { ok: false, observation: 'run_script needs a "command" to run.' };
  }

  const cwd = String(args.cwd || '').trim();

  // Before the user is asked anything: a command that provably cannot work is answered
  // from the filesystem instead of costing a click, a subprocess, and a page of npm
  // output for a 3B model to interpret.
  const blocked = preflight({ command, cwd, workspaceRoot: context.workspaceRoot });
  if (blocked) {
    logger.info(`run_script pre-flight refused "${command}": ${blocked.code}`);
    return {
      ok: false,
      observation: `\`${command}\` was not run: ${blocked.reason}`,
      error: blocked.code,
      detail: { command, cwd: cwd || undefined, reason: blocked.code, attempts: 0 },
    };
  }

  const server = isServerCommand(command);
  const request = {
    command,
    cwd,
    sessionId: context.sessionId,
    mode: context.mode,
    // A server is given a short probe rather than the full budget. See PROBE_MS.
    timeoutMs: server ? Math.min(PROBE_MS, context.scriptTimeoutMs || PROBE_MS) : context.scriptTimeoutMs,
  };
  const decision = await context.gate.requestScript(request);

  if (!decision.allowed) {
    return {
      ok: false,
      observation: `\`${command}\` was not run: ${decision.reason}${nextStepAfterRefusal(decision.code, command)}`,
      error: decision.code,
    };
  }

  /** @type {import('../../security/scriptRunner').RunResult} */
  let result;
  /** @type {import('../scriptDiagnosis').Diagnosis | null} */
  let diagnosis = null;
  let attempts = 0;

  // One retry, and only for a diagnosis that says the command was right and the world
  // was briefly wrong. Not re-asking the user is deliberate: they approved this exact
  // command seconds ago, and a second confirmation dialog for the same string is how a
  // network blip turns into an abandoned task. It is audited as a separate run either
  // way, and the observation says the retry happened.
  for (;;) {
    attempts += 1;
    try {
      result = await context.gate.runScript({ ...request, signal: context.signal }, decision);
    } catch (err) {
      // The code travels with the result. `BINARY_NOT_FOUND` is raised here rather than
      // at validation — the allow-list vets the name, and only `scriptRunner.run` looks
      // for the program on PATH — so without this it was the one refusal reason that
      // reached the loop as prose and nothing else. `factStore` reads it to record that
      // the toolchain is absent, which is the fact worth keeping from a failed run.
      const code = /** @type {Error & {code?: string}} */ (err).code;
      logger.warn(`run_script could not start "${command}": ${code || 'unknown'}`);
      return {
        ok: false,
        observation: `\`${command}\` could not be started: ${/** @type {Error} */ (err).message}${nextStepAfterRefusal(code, command)}`,
        error: code,
      };
    }

    diagnosis = result.ok ? null : diagnose(result, { command });
    logger.info(
      `run_script "${command}"${cwd ? ` in ${cwd}` : ''} attempt ${attempts}: ` +
        `exit ${result.timedOut ? 'timeout' : result.code} in ${result.durationMs}ms` +
        `${diagnosis ? ` — ${diagnosis.reason}: ${diagnosis.summary}` : ''}`
    );

    if (!diagnosis || !diagnosis.retryable || attempts > 1 || context.signal?.aborted) break;
    logger.info(`run_script retrying "${command}" once: ${diagnosis.summary}`);
  }

  const budget = context.maxObservationTokens
    ? Math.min(OUTPUT_TOKENS, Math.floor(context.maxObservationTokens / 2))
    : OUTPUT_TOKENS;

  // A server that was still up when the probe ended is a server that started. Reporting
  // that as a timeout failure is what sent models back to `npm run dev` a second and a
  // third time, each costing the full budget, on a task they had already completed.
  const startedCleanly = server && result.timedOut && !looksLikeStartupFailure(result);

  if (context.changeSet) {
    context.changeSet.recordCommand({
      command,
      cwd: cwd || undefined,
      exitCode: result.code,
      ok: result.ok || startedCleanly,
    });
  }

  return {
    ok: result.ok || startedCleanly,
    observation: startedCleanly
      ? describeServerProbe(command, result, budget, cwd)
      : describeRun(command, result, budget, cwd, { diagnosis, attempts }),
    detail: {
      command,
      cwd: cwd || undefined,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      attempts,
      reason: diagnosis ? diagnosis.reason : undefined,
    },
  };
};

module.exports.describeRun = describeRun;
module.exports.describeServerProbe = describeServerProbe;
module.exports.looksLikeStartupFailure = looksLikeStartupFailure;
module.exports.PROBE_MS = PROBE_MS;
module.exports.nextStepAfterRefusal = nextStepAfterRefusal;
module.exports.toolForRefusedCommand = toolForRefusedCommand;
module.exports.TOOL_INSTEAD_OF = TOOL_INSTEAD_OF;
