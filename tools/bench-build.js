'use strict';

/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection --
 * A developer benchmark script. Every path it touches is either a temp directory it
 * created itself or the results directory named on the command line, and the only
 * computed keys are language names and action names produced by this repo's own code. */

/**
 * The build-a-project benchmark.
 *
 * `bench-agent.js` measures whether a model can *edit* a project that already exists.
 * This measures whether it can *build* one that does not, which is a different and
 * harder question — it exercises the four things an agent has to get right in sequence,
 * and grades each of them separately:
 *
 *   1. **add files**    — write source files into a directory that does not exist yet
 *   2. **run scripts**  — compile and/or execute what it just wrote
 *   3. **read files**   — open its own output to find out why something failed
 *   4. **modify files** — change working code without breaking it
 *
 * The task is a TODO app, in whichever of Java, JavaScript, and Python the machine has
 * a toolchain for. Same app, same three phases, three languages — so a model that can
 * only really do JavaScript shows up as exactly that, rather than as a single blurred
 * score.
 *
 * ## Nothing is graded on the model's own say-so
 *
 * A model reporting "I created and tested the app" is the most common way these runs
 * lie, and `bench-agent.js` was written after exactly that. So every phase ends with
 * **the harness** compiling and running the program itself and checking its stdout for
 * a marker the task asked for. `passed` is that check. The model's summary is recorded
 * next to it and counts for nothing.
 *
 * ## Why the app has no menu
 *
 * The obvious TODO app reads commands from stdin, and benchmarking one means every run
 * hangs until the timeout. So the task asks for the same operations driven by a fixed
 * sequence in `main`, printing a total the harness can assert on. The interactive menu
 * is what a user wants; a program that terminates is what a benchmark needs.
 *
 * ## Results are one file per run
 *
 *   benchmarks/results/<machine>/<model>__<lang>__<timestamp>.json
 *
 * Machines A, B and C write into their own directories and never touch a shared file,
 * so three people can run this at the same time, push, and merge into `main` with no
 * conflict to resolve. See `benchmarks/README.md`.
 *
 * ## Usage
 *
 *   node tools/bench-build.js <model> --machine <A|B|C> [options]
 *
 *   node tools/bench-build.js gemma4:e2b --machine B
 *   node tools/bench-build.js qwen3.5:4b --machine A --lang javascript
 *   node tools/bench-build.js ornith:9b  --machine C --lang java,python --keep
 *
 *   --machine <A|B|C>   Required. Which machine this is; picks the results directory.
 *   --lang <list>       java, javascript, python, or all (default: every one installed).
 *   --tier <A|B>        Force a capability tier instead of letting discovery decide.
 *   --timeout <sec>     Per-script timeout, default 120.
 *   --out <dir>         Results root, default benchmarks/results.
 *   --keep              Leave the temp workspaces on disk for inspection.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.join(__dirname, '..', 'app');
const { createClient } = require(path.join(appRoot, 'core', 'ollamaClient'));
const { AgentSession } = require(path.join(appRoot, 'agent', 'agentSession'));
const { PermissionGate } = require(path.join(appRoot, 'security', 'permissionGate'));
const { PermissionModes } = require(path.join(appRoot, 'security', 'permissionModes'));
const { AuditLog } = require(path.join(appRoot, 'security', 'auditLog'));
const { MemoryStore } = require(path.join(appRoot, 'core', 'memoryStore'));
const { ContextTranslator } = require(path.join(appRoot, 'core', 'contextTranslator'));
const { classify } = require(path.join(appRoot, 'core', 'modelCapability'));
const { ModelDiscovery } = require(path.join(appRoot, 'core', 'modelDiscovery'));

/** Bumped when the JSON shape changes, so a later sweep can be told from an earlier one. */
const SCHEMA_VERSION = 1;

const ENDPOINT = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

// ---------------------------------------------------------------------------
// The task, in three languages
// ---------------------------------------------------------------------------

/**
 * One language's worth of benchmark.
 *
 * `phases` are handed to the model verbatim. `probe` decides whether this machine can
 * run the language at all, and `verify` is the harness's own check — it compiles and
 * runs whatever the model actually produced and reports what came out.
 *
 * The prompts name the exact output lines because the harness asserts on them. That is
 * a constraint on the *app*, not a hint about how to build it: nothing here says which
 * files to write, how to structure the data, or which tool to reach for.
 *
 * @typedef {object} LanguageSpec
 * @property {string} label
 * @property {() => string[]} probe      argv proving the toolchain exists. A thunk, so
 *                                     that resolving `python` vs `python3` happens on use.
 * @property {string} entry              Where the harness expects to start the program.
 * @property {{name: string, task: string, expect: RegExp[]}[]} phases
 * @property {(root: string) => {ok: boolean, stdout: string, stderr: string, reason: string}} verify
 */

/** Shared closing paragraph: the two things that make a run gradeable. */
const NO_INPUT =
  'The program must run from start to finish with no input at all — do not read from ' +
  'stdin, do not use a Scanner, input(), or readline. Print the lines exactly as named.';

/** @type {Record<string, LanguageSpec>} */
const LANGUAGES = {
  javascript: {
    label: 'JavaScript (Node)',
    probe: () => ['node', '--version'],
    entry: 'src/main.js',
    phases: [
      {
        name: 'create',
        task:
          'Create a TODO application in this empty project, using only Node.js core — no packages, no framework. ' +
          'src/todo.js must hold the TODO items in an in-memory array and export three functions: ' +
          'addTodo(text) which adds an item and returns it, removeTodo(id) which removes one, and ' +
          'updateTodo(id, text) which changes an item\'s text. ' +
          'src/main.js must require src/todo.js, add three TODOs, update the second one, remove the first, ' +
          'then print each remaining TODO on its own line, and finally print a last line reading ' +
          '"TOTAL: <n>" where <n> is how many TODOs are left. ' +
          NO_INPUT,
        expect: [/TOTAL:\s*2\b/],
      },
      {
        name: 'run',
        task:
          'Run the TODO application with `node src/main.js` and check its output. ' +
          'If it fails or the TOTAL line is wrong, read the files, fix the problem, and run it again ' +
          'until it works.',
        expect: [/TOTAL:\s*2\b/],
      },
      {
        name: 'modify',
        task:
          'Add a completeTodo(id) function to src/todo.js that marks a TODO as completed, and a ' +
          'countCompleted() function that returns how many are completed. ' +
          'In src/main.js, complete one of the remaining TODOs, and after the TOTAL line print one more ' +
          'line reading "DONE: <n>" using countCompleted(). Keep everything that already works.',
        expect: [/TOTAL:\s*2\b/, /DONE:\s*1\b/],
      },
    ],
    verify: (root) => runProgram(root, ['node', 'src/main.js'], ['src/main.js', 'main.js', 'index.js']),
  },

  python: {
    label: 'Python',
    probe: () => [pythonBinary(), '--version'],
    entry: 'main.py',
    phases: [
      {
        name: 'create',
        task:
          'Create a TODO application in this empty project, using only the Python standard library — ' +
          'no pip packages. ' +
          'todo.py must hold the TODO items in an in-memory list and define three functions: ' +
          'add_todo(text) which adds an item and returns it, remove_todo(id) which removes one, and ' +
          'update_todo(id, text) which changes an item\'s text. ' +
          'main.py must import todo.py, add three TODOs, update the second one, remove the first, ' +
          'then print each remaining TODO on its own line, and finally print a last line reading ' +
          '"TOTAL: <n>" where <n> is how many TODOs are left. ' +
          NO_INPUT,
        expect: [/TOTAL:\s*2\b/],
      },
      {
        name: 'run',
        task:
          'Run the TODO application with `python main.py` and check its output. ' +
          'If it fails or the TOTAL line is wrong, read the files, fix the problem, and run it again ' +
          'until it works.',
        expect: [/TOTAL:\s*2\b/],
      },
      {
        name: 'modify',
        task:
          'Add a complete_todo(id) function to todo.py that marks a TODO as completed, and a ' +
          'count_completed() function that returns how many are completed. ' +
          'In main.py, complete one of the remaining TODOs, and after the TOTAL line print one more ' +
          'line reading "DONE: <n>" using count_completed(). Keep everything that already works.',
        expect: [/TOTAL:\s*2\b/, /DONE:\s*1\b/],
      },
    ],
    verify: (root) => runProgram(root, [pythonBinary(), 'main.py'], ['main.py', 'app.py', 'src/main.py']),
  },

  java: {
    label: 'Java (javac + java)',
    probe: () => ['javac', '-version'],
    entry: 'src/main/java/TodoApp.java',
    phases: [
      {
        name: 'create',
        task:
          'Create a TODO application in this empty project using only core Java — no Maven, no Gradle, ' +
          'no frameworks. ' +
          'src/main/java/TodoManager.java must hold the TODO items in an ArrayList and provide three ' +
          'methods: addTodo(String text), removeTodo(int id), and updateTodo(int id, String text). ' +
          'src/main/java/TodoApp.java must have the main method: it adds three TODOs, updates the second, ' +
          'removes the first, prints each remaining TODO on its own line, and finally prints a last line ' +
          'reading "TOTAL: <n>" where <n> is how many TODOs are left. ' +
          NO_INPUT,
        expect: [/TOTAL:\s*2\b/],
      },
      {
        name: 'run',
        task:
          'Compile the application into a build folder with ' +
          '`javac -d build src/main/java/TodoManager.java src/main/java/TodoApp.java`, then run it with ' +
          '`java -cp build TodoApp` and check its output. If compilation fails or the TOTAL line is wrong, ' +
          'read the files, fix the problem, and compile and run again until it works.',
        expect: [/TOTAL:\s*2\b/],
      },
      {
        name: 'modify',
        task:
          'Add a completeTodo(int id) method to TodoManager that marks a TODO as completed, and a ' +
          'countCompleted() method that returns how many are completed. ' +
          'In TodoApp, complete one of the remaining TODOs, and after the TOTAL line print one more ' +
          'line reading "DONE: <n>" using countCompleted(). Keep everything that already works, then ' +
          'compile and run it again.',
        expect: [/TOTAL:\s*2\b/, /DONE:\s*1\b/],
      },
    ],
    verify: (root) => {
      // Compiled by the harness rather than trusted from the agent's own build folder:
      // a stale `.class` from an earlier phase would otherwise pass a phase whose source
      // never compiled. Every `.java` under src/main/java is compiled fresh into a
      // directory only this function writes to.
      const sources = findFiles(root, '.java');
      if (sources.length === 0) return { ok: false, stdout: '', stderr: '', reason: 'no .java files were written' };

      const out = path.join(root, '.bench-classes');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });

      const compiled = exec(root, ['javac', '-d', out, ...sources]);
      if (compiled.status !== 0) {
        return { ok: false, stdout: compiled.stdout, stderr: compiled.stderr, reason: 'javac failed' };
      }

      const mainClass = sources.map((f) => path.basename(f, '.java')).find((n) => /^TodoApp$/i.test(n))
        || sources.map((f) => path.basename(f, '.java')).find((n) => /app|main/i.test(n));
      if (!mainClass) return { ok: false, stdout: '', stderr: '', reason: 'no class looked like an entry point' };

      const ran = exec(root, ['java', '-cp', out, mainClass]);
      return {
        ok: ran.status === 0,
        stdout: ran.stdout,
        stderr: ran.stderr,
        reason: ran.status === 0 ? '' : `java exited ${ran.status}`,
      };
    },
  },
};

/** @type {string | null} */
let cachedPython = null;

/**
 * Windows ships `python`; most Linux distributions only have `python3`. Resolved once,
 * because this is called while the language table is being built and again per phase.
 */
function pythonBinary() {
  if (cachedPython === null) cachedPython = probeOk(['python3', '--version']) ? 'python3' : 'python';
  return cachedPython;
}

// ---------------------------------------------------------------------------
// Harness-side execution
// ---------------------------------------------------------------------------

/**
 * Run a command with no shell involved.
 *
 * @param {string} cwd
 * @param {string[]} argv
 * @returns {{status: number | null, stdout: string, stderr: string}}
 */
function exec(cwd, argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    shell: false,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  return {
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
  };
}

/** @param {string[]} argv */
function probeOk(argv) {
  try {
    return exec(process.cwd(), argv).status === 0;
  } catch {
    return false;
  }
}

/**
 * Start an interpreted program, tolerating the model having named its entry file
 * something other than what the task asked for.
 *
 * @param {string} root
 * @param {string[]} argv    The preferred invocation.
 * @param {string[]} candidates  Entry files to look for, in order.
 * @returns {{ok: boolean, stdout: string, stderr: string, reason: string}}
 */
function runProgram(root, argv, candidates) {
  const entry = candidates.find((c) => fs.existsSync(path.join(root, ...c.split('/'))));
  if (!entry) return { ok: false, stdout: '', stderr: '', reason: `no entry point (looked for ${candidates.join(', ')})` };

  const ran = exec(root, [argv[0], entry]);
  return {
    ok: ran.status === 0,
    stdout: ran.stdout,
    stderr: ran.stderr,
    reason: ran.status === 0 ? '' : `${argv[0]} exited ${ran.status}`,
  };
}

/**
 * Every file below a root, skipping dotfiles and build output.
 *
 * Hand-rolled rather than `fs.readdirSync(root, { recursive: true })`, whose
 * `withFileTypes` entries only carry the parent directory from Node 18.17 / 20.12 —
 * and this repo supports Node 18.
 *
 * @param {string} root
 * @param {string} [extension] Restrict to one extension, e.g. '.java'.
 * @returns {string[]} Paths relative to `root`, forward-slashed.
 */
function findFiles(root, extension) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // `build` is the agent's own compile output, and `.bench-classes` is this
      // harness's — neither is something the model wrote.
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'build') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!extension || entry.name.endsWith(extension)) {
        found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

// ---------------------------------------------------------------------------
// One phase
// ---------------------------------------------------------------------------

/**
 * Run one phase and record what the model did, separately from what it says it did.
 *
 * @param {object} options
 * @param {AgentSession} options.session
 * @param {{name: string, task: string, expect: RegExp[]}} options.phase
 * @param {LanguageSpec} options.spec
 * @param {string} options.root
 * @param {boolean} options.quiet
 * @returns {Promise<object>}
 */
async function runPhase({ session, phase, spec, root, quiet }) {
  /** @type {Record<string, number>} */
  const actionCounts = {};
  /**
   * Attempts and successes are counted separately, because they answer different
   * questions and the difference is easy to lose. A model that calls `read_file` four
   * times on a file that does not exist has attempted four reads and read nothing; a
   * capability table built on the attempt count would credit it with "reads files".
   *
   * @type {Record<string, number>}
   */
  const okCounts = {};
  /** @type {Array<{action: string, target: string, observation: string}>} */
  const failures = [];
  /** @type {Array<{command: string, reason: string}>} */
  const refusedCommands = [];
  /** @type {string | null} */
  let lastAction = null;
  /** @type {string} */
  let lastTarget = '';

  const started = Date.now();
  const result = await session.run(phase.task, {
    mode: 'agent',
    onEvent: (event) => {
      if (event.type === 'action') {
        const action = event.action;
        lastAction = action.action;
        lastTarget = action.path || action.command || action.query || '';
        actionCounts[lastAction] = (actionCounts[lastAction] || 0) + 1;
        if (!quiet) console.log(`    ${String(event.step).padStart(2)}. ${lastAction} ${lastTarget}`);
      } else if (event.type === 'observation' && event.result.ok) {
        okCounts[lastAction || '?'] = (okCounts[lastAction || '?'] || 0) + 1;
      } else if (event.type === 'observation') {
        const observation = String(event.result.observation);
        failures.push({ action: lastAction || '?', target: lastTarget, observation: observation.slice(0, 400) });
        // A command the gate never started is a different failure from one that ran and
        // exited non-zero, and the difference is the whole point of tracking it: a run
        // full of refused `mkdir` calls is a model fighting the tool surface, not a
        // model that cannot code.
        if (lastAction === 'run_script' && / was not run: /.test(observation)) {
          refusedCommands.push({ command: lastTarget, reason: observation.split(' was not run: ')[1].slice(0, 240) });
        }
        if (!quiet) console.log(`        FAILED: ${observation.split('\n')[0].slice(0, 100)}`);
      }
    },
  });

  const durationMs = Date.now() - started;
  const verified = spec.verify(root);
  const stdout = verified.stdout || '';
  const missing = phase.expect.filter((pattern) => !pattern.test(stdout)).map(String);

  return {
    name: phase.name,
    durationMs,
    // The model's account of itself. Recorded, never trusted.
    claimed: { stopReason: result.stopReason, summary: String(result.summary || '').slice(0, 1200) },
    actions: actionCounts,
    actionsSucceeded: okCounts,
    steps: Object.values(actionCounts).reduce((a, b) => a + b, 0),
    failures,
    refusedCommands,
    // The agent's own commands, which is how "can it run scripts" is answered.
    commands: (result.changeSet?.commands || []).map((c) => ({ command: c.command, exitCode: c.exitCode, ok: c.ok })),
    filesTouched: (result.changeSet?.list() || []).map((c) => ({ path: c.path, kind: c.kind })),
    verification: {
      ran: verified.ok,
      reason: verified.reason,
      stdout: stdout.slice(-1500),
      stderr: String(verified.stderr || '').slice(-1500),
      missingExpectations: missing,
    },
    passed: verified.ok && missing.length === 0,
  };
}

// ---------------------------------------------------------------------------
// One language
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.language
 * @param {LanguageSpec} options.spec
 * @param {string} options.model
 * @param {object} options.capability
 * @param {import('../app/core/ollamaClient').OllamaClient} options.client
 * @param {number} options.scriptTimeoutMs
 * @param {boolean} options.keep
 * @returns {Promise<object>}
 */
async function runLanguage({ language, spec, model, capability, client, scriptTimeoutMs, keep }) {
  // Deliberately empty. "Create the folder structure" is the step that has historically
  // gone wrong, and it only shows up when there is no structure to begin with.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `hiraya-build-${language}-`)));

  const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: true } });
  const auditLog = new AuditLog(root);
  const gate = new PermissionGate({
    workspaceRoot: root,
    modes,
    auditLog,
    // Nothing should reach this: auto-apply is on, and the task asks for nothing that
    // forces a confirmation. If it does fire, declining keeps the run unattended and
    // the audit log records what asked.
    confirm: async () => false,
  });

  const memory = new MemoryStore(root, 1);
  const session = new AgentSession({
    client,
    model,
    capability,
    gate,
    workspaceRoot: root,
    memory,
    translator: new ContextTranslator({ client, memoryStore: memory, model }),
    thinkingCapacity: 'medium',
    sessionId: '1',
    scriptTimeoutMs,
  });

  console.log(`\n=== ${spec.label} ===`);
  const phases = [];
  for (const phase of spec.phases) {
    console.log(`\n  -- phase: ${phase.name}`);
    // Sequential by design: each phase works on what the previous one left behind.
    const outcome = await runPhase({ session, phase, spec, root, quiet: false });
    phases.push(outcome);
    console.log(
      `  -- ${phase.name}: ${outcome.passed ? 'PASS' : 'FAIL'} in ${(outcome.durationMs / 1000).toFixed(1)}s` +
        `${outcome.passed ? '' : ` (${outcome.verification.reason || 'output did not match'})`}`
    );
  }

  await auditLog.flush();
  const audit = await auditLog.read().catch(() => []);

  const files = findFiles(root);

  const result = {
    language,
    label: spec.label,
    workspace: keep ? root : null,
    phases,
    // Two different questions, kept apart on purpose.
    //
    // The first four are *did the tool work in this model's hands* — writes that landed,
    // reads that returned a file, a command that exited 0, an existing file edited rather
    // than replaced. A model can score all four and still produce a program that does not
    // run, which is exactly what makes them worth separating from the last two: those are
    // the harness's own verdict on whether the result was correct.
    //
    // A row with `addFiles: true` and `builtWorkingApp: false` is the interesting one —
    // the agent loop is fine and the model cannot code. The opposite never happens.
    capabilities: {
      addFiles: phases.some((p) => (p.actionsSucceeded.write_file || 0) > 0),
      readFiles: phases.some((p) => (p.actionsSucceeded.read_file || 0) > 0),
      runScripts: phases.some((p) => p.commands.some((c) => c.ok)),
      modifyFiles: phases.some((p) => p.filesTouched.some((f) => f.kind === 'edit')),
      builtWorkingApp: phases[0]?.passed === true,
      modifiedWithoutBreaking: phases[2]?.passed === true,
    },
    filesInWorkspace: files.sort(),
    auditDecisions: audit.reduce((acc, event) => {
      acc[event.decision] = (acc[event.decision] || 0) + 1;
      return acc;
    }, /** @type {Record<string, number>} */ ({})),
    passedPhases: phases.filter((p) => p.passed).length,
    totalPhases: phases.length,
    durationMs: phases.reduce((sum, p) => sum + p.durationMs, 0),
  };

  if (keep) console.log(`  workspace kept at ${root}`);
  else fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** @param {string[]} argv */
function parseArgs(argv) {
  const positional = [];
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else {
      flags[name] = next;
      i += 1;
    }
  }
  return { positional, flags };
}

/** Filename-safe, and stable enough to sort by. */
function slug(text) {
  return String(text).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const model = positional[0];
  const machine = String(flags.machine || process.env.HIRAYA_BENCH_MACHINE || '').toUpperCase();

  if (!model || !machine) {
    console.error('Usage: node tools/bench-build.js <model> --machine <A|B|C> [--lang java,javascript,python]');
    console.error('       --machine identifies this device and picks the results directory, so that');
    console.error('       three machines can run this at the same time without a merge conflict.');
    process.exit(2);
  }
  if (!/^[A-Z]$/.test(machine)) {
    console.error(`--machine must be a single letter such as A, B, or C. Got: ${machine}`);
    process.exit(2);
  }

  const requested = String(flags.lang || 'all').toLowerCase();
  const wanted = requested === 'all' ? Object.keys(LANGUAGES) : requested.split(',').map((s) => s.trim());
  for (const name of wanted) {
    if (!LANGUAGES[name]) {
      console.error(`Unknown language "${name}". Known: ${Object.keys(LANGUAGES).join(', ')}`);
      process.exit(2);
    }
  }

  const client = createClient({ endpoint: ENDPOINT });
  const discovered = await new ModelDiscovery(client).get(model, { force: true });
  if (!discovered) {
    console.error(`Model not installed: ${model}`);
    console.error(`Try: ollama pull ${model}`);
    process.exit(1);
  }

  const capability = classify(
    {
      name: discovered.name,
      params: discovered.params,
      supportsTools: discovered.supportsTools,
      supportsThinking: discovered.supportsThinking,
      contextLength: discovered.contextLength,
    },
    flags.tier ? { tierOverrides: { [model]: String(flags.tier) } } : {}
  );

  // A missing toolchain is recorded as "skipped", never as a failure. Machine A not
  // having a JDK says nothing about the model, and a compiled report that conflated the
  // two would be worse than one with a gap in it.
  /** @type {Record<string, string>} */
  const skipped = {};
  const runnable = wanted.filter((name) => {
    const probe = LANGUAGES[name].probe();
    if (probeOk(probe)) return true;
    skipped[name] = `${probe[0]} is not installed on this machine`;
    return false;
  });

  const scriptTimeoutMs = Number(flags.timeout || 120) * 1000;
  const startedAt = new Date();

  console.log(`Endpoint:   ${ENDPOINT}`);
  console.log(`Machine:    ${machine}`);
  console.log(`Model:      ${model} → Tier ${capability.tier} (${capability.strategy})`);
  console.log(`Params:     ${discovered.paramsLabel}`);
  console.log(`Languages:  ${runnable.join(', ') || '(none)'}`);
  for (const [name, why] of Object.entries(skipped)) console.log(`  skipped ${name}: ${why}`);

  const results = [];
  for (const language of runnable) {
    // One model, one Ollama, one language at a time — running these concurrently would
    // measure contention rather than the model.
    results.push(
      await runLanguage({
        language,
        spec: LANGUAGES[language],
        model,
        capability,
        client,
        scriptTimeoutMs,
        keep: Boolean(flags.keep),
      })
    );
  }

  const cpu = os.cpus()[0] || { model: 'unknown' };
  const record = {
    schemaVersion: SCHEMA_VERSION,
    benchmark: 'build-todo-app',
    machine,
    model,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    tier: capability.tier,
    strategy: capability.strategy,
    canPlanTodos: capability.canPlanTodos,
    modelInfo: {
      params: discovered.paramsLabel,
      supportsTools: discovered.supportsTools,
      supportsThinking: discovered.supportsThinking,
      contextLength: discovered.contextLength,
    },
    host: {
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpu: cpu.model,
      cores: os.cpus().length,
      totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      node: process.version,
    },
    // Left for the operator: `ollama ps` reports the CPU/GPU split while a model is
    // resident, and nothing in Node can read it afterwards.
    notes: String(flags.notes || ''),
    skipped,
    results,
    summary: {
      languagesRun: results.length,
      phasesPassed: results.reduce((sum, r) => sum + r.passedPhases, 0),
      phasesTotal: results.reduce((sum, r) => sum + r.totalPhases, 0),
      // Which languages each capability held up in, so a model that only really does
      // JavaScript is legible at a glance rather than averaged into a single number.
      capabilities: Object.fromEntries(
        ['addFiles', 'readFiles', 'runScripts', 'modifyFiles', 'builtWorkingApp', 'modifiedWithoutBreaking'].map(
          (name) => [name, results.filter((r) => r.capabilities[name]).map((r) => r.language)]
        )
      ),
      durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
    },
  };

  const outRoot = flags.out ? String(flags.out) : path.join(__dirname, '..', 'benchmarks', 'results');
  const dir = path.join(outRoot, machine);
  fs.mkdirSync(dir, { recursive: true });
  // One file per run, never appended to a shared one — this is what keeps three machines
  // from conflicting when their branches meet in `main`.
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${slug(model)}__${slug(requested)}__${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  console.log('\n=== Summary ===');
  for (const result of results) {
    const phases = result.phases.map((p) => `${p.name}:${p.passed ? 'pass' : 'FAIL'}`).join('  ');
    console.log(`  ${result.language.padEnd(11)} ${phases}   (${(result.durationMs / 1000).toFixed(1)}s)`);
  }
  console.log(`  phases passed: ${record.summary.phasesPassed}/${record.summary.phasesTotal}`);
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
  console.log('Commit that file as-is. Do not edit results by hand.');
}

// The grading half of this file is unit-tested — a benchmark that scores runs wrongly is
// worse than no benchmark, since it produces numbers that look authoritative. Requiring
// the module must therefore not start a sweep.
if (require.main === module) {
  main().catch((err) => {
    console.error('BENCHMARK FAILED:', err);
    process.exit(1);
  });
}

module.exports = { LANGUAGES, findFiles, parseArgs, runProgram, slug, exec, SCHEMA_VERSION };
