'use strict';

/**
 * Cross-platform command execution — the single place HirayaCoder starts a process.
 *
 * The threat here is command injection via model output. A 1B model asked to run
 * the test suite will occasionally propose something creative, and the user in
 * auto-approve mode isn't reading it. The defense is layered:
 *
 *  1. **No shell, ever.** `spawn` with an argument array and `shell: false`. There
 *     is no string a model can emit that a shell will re-parse, because no shell
 *     parses anything.
 *  2. **Metacharacter rejection at tokenize time.** Because there's no shell, `;`
 *     `&&` `|` `>` `$(` `` ` `` wouldn't chain commands — they'd be passed through as
 *     literal argv entries, which is confusing rather than dangerous. They're
 *     rejected outright so the failure is loud instead of silently wrong.
 *  3. **Binary allow-list.** argv[0] must be a known-safe program. Extendable by the
 *     user, never by the model.
 *  4. **Always-confirm rules.** A handful of allow-listed *subcommands* publish code
 *     or reach the network (`git push`, `npm publish`). These force a confirmation
 *     even in auto-approve mode — auto-approve is about skipping clicks on routine
 *     local work, not about silently shipping the user's code somewhere.
 *
 * ## The Windows `.cmd` problem
 *
 * `npm`, `npx`, and `yarn` are batch shims on Windows. Node refuses to spawn `.cmd`
 * / `.bat` files without `shell: true` (CVE-2024-27980), and `shell: true` is exactly
 * what layer 1 exists to avoid. The resolution is to invoke `cmd.exe /d /s /c` with
 * the shim and its arguments as separate argv entries — Node applies its own
 * quoting, and every argument has already been screened for `cmd` metacharacters, so
 * there's nothing left for `cmd` to re-interpret.
 *
 * @module security/scriptRunner
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const logger = require('../utils/logger');
const { platformName, resolveShell } = require('../utils/platform');

/**
 * Programs the agent may run. Deliberately conservative: build tooling, package
 * managers, test runners, and Ollama itself. Anything that is primarily a way to
 * move or destroy files (`rm`, `curl`, `powershell`, `bash`) is absent, since those
 * would make the allow-list decorative.
 */
const DEFAULT_ALLOWED_BINARIES = [
  'node', 'npm', 'npx', 'yarn', 'pnpm',
  'ollama',
  'git',
  'python', 'python3', 'pip', 'pip3',
  'pytest', 'jest', 'mocha', 'vitest', 'ava',
  'tsc', 'eslint', 'prettier',
  'go', 'cargo', 'dotnet', 'mvn', 'gradle', 'make',
];

/**
 * Allow-listed programs whose *subcommands* still demand an explicit click, even
 * when auto-approve-scripts is on. Each rule is [binary, subcommand-matcher, why].
 *
 * @type {Array<{binary: string, match: (args: string[]) => boolean, reason: string}>}
 */
const ALWAYS_CONFIRM = [
  {
    binary: 'git',
    match: (args) => ['push', 'remote', 'clone', 'fetch', 'pull', 'submodule'].includes(args[0]),
    reason: 'this git command talks to a remote, which would send code off this machine',
  },
  {
    binary: 'npm',
    match: (args) => ['publish', 'login', 'adduser', 'token', 'config'].includes(args[0]),
    reason: 'this npm command publishes code or changes credentials',
  },
  {
    binary: 'yarn',
    match: (args) => ['publish', 'login'].includes(args[0]),
    reason: 'this yarn command publishes code or changes credentials',
  },
  {
    binary: 'pnpm',
    match: (args) => ['publish', 'login'].includes(args[0]),
    reason: 'this pnpm command publishes code or changes credentials',
  },
  {
    binary: 'ollama',
    match: (args) => ['pull', 'push', 'rm', 'cp'].includes(args[0]),
    reason: 'this downloads, uploads, or deletes a model',
  },
];

/**
 * Characters that would be operators in a shell. Rejected outside quotes so the
 * user gets a clear error rather than a literal `&&` argument.
 */
const SHELL_METACHARACTERS = new Set([';', '&', '|', '<', '>', '`', '$', '(', ')', '{', '}', '\n', '\r']);

/** Characters `cmd.exe` re-interprets, screened before any Windows shim invocation. */
const CMD_METACHARACTERS = /[&|<>^%\r\n]/;

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_OUTPUT_CHARS = 100000;

/** Raised for every refusal, with a machine-readable `code`. */
class ScriptRunnerError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ScriptRunnerError';
    this.code = code;
  }
}

/**
 * @typedef {object} ParsedCommand
 * @property {string} binary   argv[0], lowercased basename.
 * @property {string[]} args   Remaining argv entries.
 * @property {string[]} argv   Full argv.
 */

/**
 * Split a command string into argv, honoring quotes but refusing shell operators.
 *
 * @param {string} command
 * @returns {ParsedCommand}
 * @throws {ScriptRunnerError}
 */
function tokenize(command) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new ScriptRunnerError('EMPTY_COMMAND', 'No command was provided.');
  }
  if (command.includes('\0')) {
    throw new ScriptRunnerError('NUL_BYTE', 'Command contains a NUL byte and was refused.');
  }

  /** @type {string[]} */
  const argv = [];
  let current = '';
  let hasCurrent = false;
  /** @type {'"' | "'" | null} */
  let quote = null;

  for (let i = 0; i < command.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index into a string
    const char = command[i];

    if (quote) {
      if (char === quote) quote = null;
      else {
        current += char;
        hasCurrent = true;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasCurrent = true;
      continue;
    }

    if (char === '\\' && i + 1 < command.length && platformName() !== 'win32') {
      current += command[i + 1];
      hasCurrent = true;
      i += 1;
      continue;
    }

    if (SHELL_METACHARACTERS.has(char)) {
      throw new ScriptRunnerError(
        'SHELL_METACHARACTER',
        `Refused: "${char}" is a shell operator, and HirayaCoder never runs commands through a shell. ` +
          'Propose one command at a time instead of chaining or redirecting.'
      );
    }

    if (char === ' ' || char === '\t') {
      if (hasCurrent) {
        argv.push(current);
        current = '';
        hasCurrent = false;
      }
      continue;
    }

    current += char;
    hasCurrent = true;
  }

  if (quote) {
    throw new ScriptRunnerError('UNBALANCED_QUOTE', 'Command has an unterminated quote.');
  }
  if (hasCurrent) argv.push(current);
  if (argv.length === 0) {
    throw new ScriptRunnerError('EMPTY_COMMAND', 'No command was provided.');
  }

  const binary = path.basename(argv[0]).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  return { binary, args: argv.slice(1), argv };
}

/**
 * Validate a command against the allow-list.
 *
 * @param {string} command
 * @param {object} [opts]
 * @param {string[]} [opts.allowedBinaries]
 * @returns {ParsedCommand}
 * @throws {ScriptRunnerError}
 */
function validate(command, opts = {}) {
  const parsed = tokenize(command);
  const allowed = (opts.allowedBinaries || DEFAULT_ALLOWED_BINARIES).map((b) => b.toLowerCase());

  // A path-qualified argv[0] would sidestep the allow-list by name, so only the
  // basename is ever considered — and an absolute path to an unlisted binary
  // still fails, because its basename is what's checked.
  if (!allowed.includes(parsed.binary)) {
    throw new ScriptRunnerError(
      'BINARY_NOT_ALLOWED',
      `"${parsed.binary}" is not in the allowed program list. ` +
        `Allowed: ${allowed.slice(0, 8).join(', ')}${allowed.length > 8 ? ', …' : ''}. ` +
        'You can extend this list in HirayaCoder settings.'
    );
  }

  return parsed;
}

/**
 * Does this command require a confirmation click regardless of permission mode?
 *
 * @param {ParsedCommand} parsed
 * @returns {string | null} The reason, or null if auto-approval may apply.
 */
function requiresExplicitApproval(parsed) {
  for (const rule of ALWAYS_CONFIRM) {
    if (rule.binary === parsed.binary && rule.match(parsed.args)) return rule.reason;
  }
  return null;
}

/**
 * Locate a binary on PATH, honoring PATHEXT on Windows.
 *
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.platform]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {string | null} Absolute path, or null if not found.
 */
function resolveBinary(name, opts = {}) {
  const platform = opts.platform || os.platform();
  const env = opts.env || process.env;
  const isWin = platformName(platform) === 'win32';

  // An explicit path is used as-is; the allow-list already vetted its basename.
  if (name.includes('/') || name.includes(path.sep)) {
    // Existence probe only; the allow-list already vetted this binary's basename.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return fs.existsSync(name) ? path.resolve(name) : null;
  }

  const extensions = isWin
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const directories = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        // PATH search over directories from the environment, not from model output.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here; keep looking */
      }
    }
  }
  return null;
}

/**
 * @typedef {object} RunResult
 * @property {boolean} ok
 * @property {number | null} code
 * @property {string | null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} truncated
 * @property {number} durationMs
 * @property {string[]} argv
 */

/**
 * Execute a validated command.
 *
 * The caller is responsible for having obtained permission — this function does not
 * consult `permissionModes`. `permissionGate.js` is the only thing that should call
 * it. That separation is what keeps "did anyone approve this?" answerable in one
 * place rather than spread across every tool.
 *
 * @param {string} command
 * @param {object} options
 * @param {string} options.cwd Workspace root; the process never starts elsewhere.
 * @param {string[]} [options.allowedBinaries]
 * @param {number} [options.timeoutMs]
 * @param {(stream: 'stdout' | 'stderr', chunk: string) => void} [options.onOutput]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.platform] Override, for tests.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {Promise<RunResult>}
 */
async function run(command, options) {
  const platform = options.platform || os.platform();
  const parsed = validate(command, { allowedBinaries: options.allowedBinaries });
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const env = options.env || process.env;

  const resolvedBinary = resolveBinary(parsed.argv[0], { platform, env });
  if (!resolvedBinary) {
    throw new ScriptRunnerError(
      'BINARY_NOT_FOUND',
      `"${parsed.argv[0]}" is allowed but was not found on your PATH. Is it installed?`
    );
  }

  const isWin = platformName(platform) === 'win32';
  const isShim = isWin && /\.(cmd|bat)$/i.test(resolvedBinary);

  /** @type {string} */
  let file;
  /** @type {string[]} */
  let spawnArgs;

  if (isShim) {
    // Screen every argument before handing it to cmd.exe, which would otherwise
    // re-interpret these characters after Node's quoting.
    for (const arg of parsed.args) {
      if (CMD_METACHARACTERS.test(arg)) {
        throw new ScriptRunnerError(
          'CMD_METACHARACTER',
          `Refused: argument "${arg}" contains a character cmd.exe would re-interpret.`
        );
      }
    }
    const shell = resolveShell(platform, env);
    file = shell.command;
    spawnArgs = [...shell.args, resolvedBinary, ...parsed.args];
  } else {
    file = resolvedBinary;
    spawnArgs = parsed.args;
  }

  logger.info(`Running: ${parsed.argv.join(' ')} (cwd: ${options.cwd})`);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(file, spawnArgs, {
      cwd: options.cwd,
      // The whole point: no shell interpretation at any layer.
      shell: false,
      windowsHide: true,
      env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    /**
     * @param {'stdout' | 'stderr'} stream
     * @param {string} chunk
     */
    const collect = (stream, chunk) => {
      if (options.onOutput) options.onOutput(stream, chunk);
      if (stream === 'stdout') {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
        else truncated = true;
      } else if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
      else truncated = true;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, platform);
    }, timeoutMs);

    /** @param {() => void} action */
    const onAbort = () => {
      killTree(child.pid, platform);
    };
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ScriptRunnerError('SPAWN_FAILED', `Could not start "${parsed.binary}": ${err.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (truncated) {
        stdout += '\n…[output truncated by HirayaCoder]';
      }

      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
        argv: parsed.argv,
      });
    });
  });
}

/**
 * Terminate a process and its descendants.
 *
 * `child.kill()` on Windows leaves grandchildren running — `npm test` would die
 * while the actual test process kept going — so `taskkill /T` is used there.
 *
 * @param {number | undefined} pid
 * @param {string} platform
 */
function killTree(pid, platform) {
  if (!pid) return;
  try {
    if (platformName(platform) === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, shell: false });
    } else {
      process.kill(pid, 'SIGTERM');
      // Escalate if it ignores SIGTERM.
      setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000).unref();
    }
  } catch (err) {
    logger.warn(`Could not terminate process ${pid}: ${/** @type {Error} */ (err).message}`);
  }
}

module.exports = {
  run,
  validate,
  tokenize,
  resolveBinary,
  requiresExplicitApproval,
  killTree,
  ScriptRunnerError,
  DEFAULT_ALLOWED_BINARIES,
  ALWAYS_CONFIRM,
  SHELL_METACHARACTERS,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
};
