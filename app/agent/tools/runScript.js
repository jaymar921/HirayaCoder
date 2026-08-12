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

/** Per-stream budget for what goes back into the prompt. */
const OUTPUT_TOKENS = 400;

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
const TOOL_INSTEAD_OF = new Map([
  // Not "use another tool" but "you do not need this step" — the distinction matters,
  // because a model told to find another way to make a directory will find one.
  ['mkdir', 'You do not need to create directories at all: write_file creates any missing folders on the way to the file. Skip this step and write the file you wanted to put there.'],
  ['md', 'You do not need to create directories at all: write_file creates any missing folders on the way to the file. Skip this step and write the file you wanted to put there.'],
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
  ['rm', 'Use the delete_file tool to remove a file.'],
  ['del', 'Use the delete_file tool to remove a file.'],
  ['rmdir', 'Use the delete_file tool to remove a file.'],
  ['unlink', 'Use the delete_file tool to remove a file.'],
  ['touch', 'Use write_file to create the file, with its full contents.'],
  ['echo', 'Use write_file to put content in a file. There is nothing to print to.'],
  ['cp', 'Use read_file to get the contents, then write_file to save them at the new path.'],
  ['copy', 'Use read_file to get the contents, then write_file to save them at the new path.'],
  ['mv', 'Use read_file, then write_file at the new path, then delete_file on the old one.'],
  ['move', 'Use read_file, then write_file at the new path, then delete_file on the old one.'],
  ['sed', 'Use read_file to get the file, then write_file with the complete corrected contents.'],
  ['awk', 'Use read_file to get the file, then write_file with the complete corrected contents.'],
  ['pwd', 'Commands already run at the workspace root, so there is nothing to check.'],
  ['cd', 'Commands already run at the workspace root, and it cannot be changed. Use workspace-relative paths in the command itself.'],
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
      return ' Do not resend this line. Propose one plain command, with no operators, redirects, or chaining.';
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
 * @returns {string}
 */
function describeRun(command, result, budget) {
  const parts = [];

  if (result.timedOut) {
    parts.push(`\`${command}\` was still running after the time limit and was stopped.`);
  } else {
    parts.push(`\`${command}\` finished with exit code ${result.code}.`);
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

  return parts.join('\n');
}

/**
 * @param {{command: string}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function runScript(args, context) {
  const command = String(args.command || '').trim();
  if (!command) {
    return { ok: false, observation: 'run_script needs a "command" to run.' };
  }

  const request = { command, sessionId: context.sessionId, mode: context.mode, timeoutMs: context.scriptTimeoutMs };
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
  try {
    result = await context.gate.runScript({ ...request, signal: context.signal }, decision);
  } catch (err) {
    return {
      ok: false,
      observation: `\`${command}\` could not be started: ${/** @type {Error} */ (err).message}`,
    };
  }

  const budget = context.maxObservationTokens
    ? Math.min(OUTPUT_TOKENS, Math.floor(context.maxObservationTokens / 2))
    : OUTPUT_TOKENS;

  if (context.changeSet) {
    context.changeSet.recordCommand({ command, exitCode: result.code, ok: result.ok });
  }

  return {
    ok: result.ok,
    observation: describeRun(command, result, budget),
    detail: {
      command,
      exitCode: result.code,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    },
  };
};

module.exports.describeRun = describeRun;
module.exports.nextStepAfterRefusal = nextStepAfterRefusal;
module.exports.toolForRefusedCommand = toolForRefusedCommand;
module.exports.TOOL_INSTEAD_OF = TOOL_INSTEAD_OF;
