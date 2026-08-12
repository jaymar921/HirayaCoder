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
      // The reason is deliberately actionable: "not in the allowed program list"
      // teaches the model to propose something else rather than retry verbatim.
      observation: `\`${command}\` was not run: ${decision.reason}`,
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
