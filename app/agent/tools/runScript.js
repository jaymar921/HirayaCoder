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
 * @returns {string} Text to append to the observation, or '' when a retry is sensible.
 */
function nextStepAfterRefusal(code) {
  switch (code) {
    case 'BINARY_NOT_ALLOWED':
      return (
        ' Sending it again will be refused identically — do not retry it. Either use one of the allowed ' +
        'programs, or stop and tell the user which command they should run themselves and why.'
      );
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
      observation: `\`${command}\` was not run: ${decision.reason}${nextStepAfterRefusal(decision.code)}`,
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
