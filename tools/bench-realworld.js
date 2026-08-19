'use strict';

/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection --
 * A developer benchmark script. Every path it touches is either a temp directory it
 * created itself or a directory named on the command line, and the only computed keys
 * are gate names and feature names defined in this file. */

/**
 * The real-world benchmark: one brief, one product, graded in a browser.
 *
 * `bench-build.js` asks whether a model can write a program that prints a line. This
 * asks the question a user actually has — **can it build the thing I asked for, with
 * every button working** — using the hardest realistic brief available: a React + Vite
 * + Tailwind TODO app, to a fixed folder structure, with add / edit / delete / toggle /
 * clear and a build that has to pass.
 *
 * Three things make it different from every other harness in this repo.
 *
 * **1. The brief is handed over verbatim, once.** `tools/prompts/todo-glass-app.md` is
 * the user's message, not a paraphrase and not a decomposition. Splitting it into steps
 * is HirayaCoder's job, and a benchmark that pre-split it would be measuring a harness
 * that does not ship.
 *
 * **2. There is an auto-user.** A real session is not one message — the 0.7.0 evaluation
 * took eleven, and every real fix in it came from the user pasting a build error back.
 * So after each turn the harness runs the gates itself and, if something is wrong,
 * writes the next message the way a user would: the actual `npm run build` output, or
 * the list of files that are still missing. Nothing is invented and nothing is hinted —
 * the messages contain only what the user could see from outside.
 *
 * **3. Nothing is graded on the model's account of itself.** Gates run on disk; the
 * feature score comes from `tools/lib/appProbe`, which serves the production bundle and
 * clicks every control in a headless Chromium. A model that reports "all features
 * verified working" over an app whose delete button is wired to nothing scores exactly
 * what that app is worth.
 *
 * ## Usage
 *
 *   node tools/bench-realworld.js <model> --machine <A|B|C> [options]
 *
 *   node tools/bench-realworld.js qwen3.5:2b --machine B
 *   node tools/bench-realworld.js llama3.2:1b --machine B --turns 8 --keep
 *
 *   --machine <A|B|C>   Required. Which machine this is; picks the results directory.
 *   --turns <n>         Auto-user turns after the brief, default 10.
 *   --budget <min>      Give up after this many minutes of wall clock, default 90.
 *   --tier <A|B>        Force a capability tier instead of letting discovery decide.
 *   --steps             Run with experimental step sessions on.
 *   --timeout <sec>     Per-script timeout, default 300 — `npm install` is slow.
 *   --workspace <dir>   Work here instead of a temp directory (implies --keep).
 *   --out <dir>         Results root, default benchmarks/results.
 *   --keep              Leave the workspace on disk for inspection.
 *   --notes "..."       Free text stored in the record — put the `ollama ps` split here.
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
const { FactStore } = require(path.join(appRoot, 'core', 'factStore'));
const { FileHistory } = require(path.join(appRoot, 'core', 'fileHistory'));
const { OutcomeLedger } = require(path.join(appRoot, 'core', 'outcomeLedger'));
const { ContextTranslator } = require(path.join(appRoot, 'core', 'contextTranslator'));
const { classify } = require(path.join(appRoot, 'core', 'modelCapability'));
const { ModelDiscovery } = require(path.join(appRoot, 'core', 'modelDiscovery'));
const environmentProfile = require(path.join(appRoot, 'core', 'environmentProfile'));

const { probeApp, FEATURES } = require('./lib/appProbe');
const { probeJavaService, JAVA_FEATURES } = require('./lib/javaProbe');
const { probePythonService, PYTHON_FEATURES } = require('./lib/pythonProbe');
const briefs = require('./lib/briefs');
const { parseArgs, slug } = require('./lib/args');

/** Bumped when the JSON shape changes, so a later sweep can be told from an earlier one. */
const SCHEMA_VERSION = 1;

const ENDPOINT = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';



// ---------------------------------------------------------------------------
// Running commands the harness needs for itself
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @param {string} cwd
 * @param {number} timeoutMs
 */
function exec(argv, cwd, timeoutMs = 600000) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    windowsHide: true,
    // Node's own deprecation notices are not build output. They land on stderr, which
    // is what the auto-user pastes back, so without this every build failure message
    // opened with two lines about `shell: true` — spending a 0.8B model's context on a
    // warning about the harness rather than on the error it is being asked to fix.
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return {
    code: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    ok: result.status === 0,
  };
}

/** Escape sequences, matched without writing a control character into this file. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

/** Lines the Node runtime wrote about itself, which are not build output. */
const RUNTIME_NOISE = /^\(node:\d+\)|^\(Use `node --trace-|DeprecationWarning|ExperimentalWarning/;

/**
 * Strip everything that is noise rather than build output.
 *
 * ANSI colour, and any line the Node runtime wrote about itself. Both would otherwise
 * be pasted back to the model as if the build had said them, and the deprecation notice
 * about `shell: true` opened every build-failure message in the first sweep — two lines
 * of a 0.8B model's context spent on a warning about the harness.
 */
function plain(text) {
  return String(text)
    .replace(ANSI, '')
    .split('\n')
    .filter((line) => !RUNTIME_NOISE.test(line))
    .join('\n');
}

/** @param {string} root */
function findFiles(root, prefix = '', out = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) findFiles(root, relative, out);
    else out.push(relative);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

/**
 * What is true of the workspace right now, in the order a build has to get right.
 *
 * Each gate is independent and each is checked from disk. `install` and `build` are the
 * expensive ones, so they are skipped once a cheaper gate below them has already failed
 * — there is nothing to learn from running `npm run build` in a directory with no
 * `package.json`.
 *
 * @param {string} root
 * @param {number} scriptTimeoutMs
 */
function runGates(brief, root, scriptTimeoutMs) {
  if (brief.toolchain === 'maven') return runMavenGates(brief, root, scriptTimeoutMs);
  if (brief.toolchain === 'python') return runPythonGates(brief, root, scriptTimeoutMs);
  return runNodeGates(brief, root, scriptTimeoutMs);
}

/**
 * Which of `brief.requiredFiles` are not on disk.
 *
 * A presence check and nothing more. A file being there says nothing about what is in
 * it, which is the whole lesson of the 0.9.0 baseline: a project passed every
 * file-presence check with `App.jsx` holding Vite's counter demo.
 *
 * @param {import('./lib/briefs').Brief} brief
 * @param {string} appPath
 */
function structureGate(brief, appPath, scaffolded) {
  const missing = brief.requiredFiles.filter((relative) => !fs.existsSync(path.join(appPath, relative)));
  return {
    ok: scaffolded && missing.length === 0,
    detail: missing.length
      ? 'missing: ' + missing.join(', ')
      : 'all ' + brief.requiredFiles.length + ' required files present',
    missing,
  };
}

/**
 * @param {import('./lib/briefs').Brief} brief
 * @param {string} root
 * @param {number} scriptTimeoutMs
 */
function runNodeGates(brief, root, scriptTimeoutMs) {
  const appPath = path.join(root, brief.appDir);
  const gates = {};
  const budget = Math.max(scriptTimeoutMs, 600000);

  const scaffolded = fs.existsSync(path.join(appPath, 'package.json'));
  gates.scaffold = {
    ok: scaffolded,
    detail: scaffolded ? brief.appDir + '/package.json exists' : 'no ' + brief.appDir + '/package.json',
  };
  gates.structure = structureGate(brief, appPath, scaffolded);

  if (!scaffolded) {
    gates.install = { ok: false, detail: 'not attempted — nothing to install' };
    for (const extra of brief.extraGates || []) {
      gates[extra.join(' ')] = { ok: false, detail: 'not attempted — nothing to run', output: '' };
    }
    gates.build = { ok: false, detail: 'not attempted — nothing to build', output: '' };
    return gates;
  }

  const installed = fs.existsSync(path.join(appPath, 'node_modules'));
  const install = installed
    ? { ok: true, stdout: '', stderr: '', code: 0 }
    : exec(['npm', 'install'], appPath, budget);
  gates.install = {
    ok: install.ok,
    detail: installed ? 'node_modules already present' : install.ok ? 'npm install exited 0' : 'npm install failed',
    output: install.ok ? '' : plain(install.stderr || install.stdout).slice(-3000),
  };

  if (!gates.install.ok) {
    for (const extra of brief.extraGates || []) {
      gates[extra.join(' ')] = { ok: false, detail: 'not attempted — dependencies are not installed', output: '' };
    }
    gates.build = { ok: false, detail: 'not attempted — dependencies are not installed', output: '' };
    return gates;
  }

  // The brief's own extra checks — a test suite it asked for, most often. Run before
  // the build, in the order the brief lists them.
  for (const extra of brief.extraGates || []) {
    const outcome = exec(extra, appPath, budget);
    gates[extra.join(' ')] = {
      ok: outcome.ok,
      detail: outcome.ok ? extra.join(' ') + ' exited 0' : extra.join(' ') + ' failed',
      output: outcome.ok ? '' : plain(outcome.stderr || outcome.stdout).slice(-3000),
    };
  }

  // Remove the previous bundle first. A `dist/` left by an earlier turn passes the
  // probe for a build that has since started failing, which is the single worst lie a
  // benchmark can tell.
  fs.rmSync(path.join(appPath, 'dist'), { recursive: true, force: true });
  const build = exec(['npm', 'run', 'build'], appPath, budget);
  gates.build = {
    ok: build.ok && fs.existsSync(path.join(appPath, 'dist', 'index.html')),
    detail: build.ok ? 'npm run build exited 0' : 'npm run build failed',
    output: plain(build.ok ? build.stdout : build.stderr || build.stdout).slice(-4000),
  };

  return gates;
}

/**
 * Compile, test and package a Maven project.
 *
 * A missing toolchain is recorded as `skipped`, never as a failure — the convention
 * `bench-build.js` already sets. This machine not having Maven says nothing about the
 * model.
 *
 * @param {import('./lib/briefs').Brief} brief
 * @param {string} root
 * @param {number} scriptTimeoutMs
 */
function runMavenGates(brief, root, scriptTimeoutMs) {
  const appPath = path.join(root, brief.appDir);
  const gates = {};
  const budget = Math.max(scriptTimeoutMs, 900000);

  const scaffolded = fs.existsSync(path.join(appPath, 'pom.xml'));
  gates.scaffold = {
    ok: scaffolded,
    detail: scaffolded ? brief.appDir + '/pom.xml exists' : 'no ' + brief.appDir + '/pom.xml',
  };
  gates.structure = structureGate(brief, appPath, scaffolded);

  const haveMaven = exec(['mvn', '-v'], root, 60000).ok;
  if (!haveMaven) {
    const skipped = { ok: false, skipped: true, detail: 'maven is not installed on this machine', output: '' };
    gates.compile = { ...skipped };
    gates.test = { ...skipped };
    gates.build = { ...skipped };
    return gates;
  }

  if (!scaffolded) {
    const nothing = { ok: false, detail: 'not attempted — there is no pom.xml', output: '' };
    gates.compile = { ...nothing };
    gates.test = { ...nothing };
    gates.build = { ...nothing };
    return gates;
  }

  const compile = exec(['mvn', '-B', '-q', 'clean', 'compile'], appPath, budget);
  // A compile that produced no classes did not compile anything.
  //
  // Maven is perfectly happy to build a project with no sources: `qwen3.5:0.8b` wrote a
  // valid `pom.xml`, put every `.java` file somewhere else entirely, and this harness
  // reported compile, test **and** package as passing over an empty tree — which then
  // produced a jar. Three green gates and not one line of the model's code in them.
  // That is precisely the lie this benchmark exists to refuse, and it got through
  // because exit codes were being trusted where the artefact should have been checked.
  const classes = countFiles(path.join(appPath, 'target', 'classes'), '.class');
  gates.compile = {
    ok: compile.ok && classes > 0,
    detail: !compile.ok
      ? 'mvn clean compile failed'
      : classes > 0
        ? 'mvn clean compile produced ' + classes + ' class file(s)'
        : 'mvn clean compile exited 0 but compiled nothing — there are no sources under src/main/java',
    output: compile.ok ? '' : plain(compile.stdout || compile.stderr).slice(-4000),
  };
  if (!gates.compile.ok) {
    gates.test = { ok: false, detail: 'not attempted — it does not compile', output: '' };
    gates.build = { ok: false, detail: 'not attempted — it does not compile', output: '' };
    return gates;
  }

  const test = exec(['mvn', '-B', '-q', 'test'], appPath, budget);
  gates.test = {
    ok: test.ok,
    detail: test.ok ? 'mvn test exited 0' : 'mvn test failed',
    output: test.ok ? '' : plain(test.stdout || test.stderr).slice(-4000),
  };

  const built = exec(['mvn', '-B', '-q', '-DskipTests', 'package'], appPath, budget);
  const jar = findJar(path.join(appPath, 'target'));
  gates.build = {
    ok: built.ok && Boolean(jar),
    detail: !built.ok ? 'mvn package failed' : jar ? 'packaged ' + path.basename(jar) : 'mvn package produced no jar',
    output: built.ok ? '' : plain(built.stdout || built.stderr).slice(-4000),
  };

  return gates;
}

/**
 * Compile, test and import-check a stdlib-only Python project.
 *
 * There is no build step to gate on, so `build` here is the thing the brief actually
 * asks for in its place: that the entry point imports and the application object can be
 * constructed. That is the Python equivalent of "it links" — and it is the check that
 * catches the failure a compile pass cannot, a package with a missing `__init__.py` or
 * a module importing a name its sibling never defined.
 *
 * @param {import('./lib/briefs').Brief} brief
 * @param {string} root
 * @param {number} scriptTimeoutMs
 */
function runPythonGates(brief, root, scriptTimeoutMs) {
  const appPath = path.join(root, brief.appDir);
  const gates = {};
  const budget = Math.max(scriptTimeoutMs, 300000);
  const python = pythonBinary(root);

  const scaffolded = fs.existsSync(path.join(appPath, 'main.py'));
  gates.scaffold = {
    ok: scaffolded,
    detail: scaffolded ? brief.appDir + '/main.py exists' : 'no ' + brief.appDir + '/main.py',
  };
  gates.structure = structureGate(brief, appPath, scaffolded);

  if (!python) {
    const skipped = { ok: false, skipped: true, detail: 'python is not installed on this machine', output: '' };
    gates.compile = { ...skipped };
    gates.test = { ...skipped };
    gates.build = { ...skipped };
    return gates;
  }

  if (!scaffolded) {
    const nothing = { ok: false, detail: 'not attempted — there is no main.py', output: '' };
    gates.compile = { ...nothing };
    gates.test = { ...nothing };
    gates.build = { ...nothing };
    return gates;
  }

  // Byte-compile every module the project has. `compileall -q` reports syntax errors
  // and nothing else, which is exactly the first question: does this parse.
  const compile = exec([python, '-m', 'compileall', '-q', '.'], appPath, budget);
  gates.compile = {
    ok: compile.ok,
    detail: compile.ok ? 'python -m compileall exited 0' : 'python -m compileall found syntax errors',
    output: compile.ok ? '' : plain(compile.stdout || compile.stderr).slice(-4000),
  };
  if (!compile.ok) {
    gates.test = { ok: false, detail: 'not attempted — it does not compile', output: '' };
    gates.build = { ok: false, detail: 'not attempted — it does not compile', output: '' };
    return gates;
  }

  const test = exec([python, '-m', 'unittest', 'discover', '-s', 'tests'], appPath, budget);
  gates.test = {
    ok: test.ok,
    detail: test.ok ? 'python -m unittest discover exited 0' : 'python -m unittest discover failed',
    // unittest writes its report to stderr even when everything passes, so a failure
    // needs both streams to be readable.
    output: test.ok ? '' : plain([test.stdout, test.stderr].filter(Boolean).join('\n')).slice(-4000),
  };

  // Import the entry point without letting Tk open a window. `main.py` normally calls
  // `mainloop()` under an `if __name__ == "__main__"` guard, so importing it as a
  // module runs the definitions and not the loop — and a project that cannot even be
  // imported is one the brief's own step 3 would have caught.
  // Written to a file rather than passed with `-c`.
  //
  // `exec` runs through `cmd` on Windows, which mangled the one-liner into
  // `import` on its own — and the gate then reported *"main.py could not be
  // imported"* with a `SyntaxError` from the harness's own command. A gate that fails
  // for its own reasons is worse than no gate, because the message names the model's
  // file.
  const checkPath = path.join(appPath, '.hiraya-import-check.py');
  fs.writeFileSync(
    checkPath,
    [
      'import importlib.util',
      'spec = importlib.util.spec_from_file_location("pos_main", "main.py")',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'print("imported")',
    ].join('\n')
  );
  const imported = exec([python, '.hiraya-import-check.py'], appPath, budget);
  fs.rmSync(checkPath, { force: true });
  gates.build = {
    ok: imported.ok,
    detail: imported.ok ? 'main.py imports cleanly' : 'main.py could not be imported',
    output: imported.ok ? '' : plain(imported.stderr || imported.stdout).slice(-4000),
  };

  return gates;
}

/**
 * Whichever spelling of Python this machine has, or '' when it has none.
 *
 * Resolved on use rather than at load, and cached for the process: `bench-build.js`
 * learned the same lesson, that `python` and `python3` are both right somewhere.
 *
 * @param {string} cwd
 * @returns {string}
 */
let cachedPython = null;
function pythonBinary(cwd) {
  if (cachedPython !== null) return cachedPython;
  for (const candidate of ['python', 'python3', 'py']) {
    if (exec([candidate, '--version'], cwd, 60000).ok) {
      cachedPython = candidate;
      return cachedPython;
    }
  }
  cachedPython = '';
  return cachedPython;
}

/**
 * How many files with this extension a directory tree holds.
 *
 * @param {string} dir
 * @param {string} extension
 * @returns {number}
 */
function countFiles(dir, extension) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let found = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) found += countFiles(path.join(dir, entry.name), extension);
    else if (entry.name.endsWith(extension)) found += 1;
  }
  return found;
}

/**
 * The application jar in a Maven `target/`, ignoring the sources and javadoc ones.
 *
 * @param {string} targetDir
 * @returns {string}
 */
function findJar(targetDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(targetDir);
  } catch {
    return '';
  }
  const jar = entries
    .filter((name) => name.endsWith('.jar'))
    .filter((name) => !/-(?:sources|javadoc|tests)\.jar$/.test(name))
    .sort((a, b) => b.length - a.length)[0];
  return jar ? path.join(targetDir, jar) : '';
}

// ---------------------------------------------------------------------------
// The auto-user
// ---------------------------------------------------------------------------

/**
 * The next thing a user would say, given what is on disk.
 *
 * Deliberately unhelpful about *how*: a user pastes the error, they do not name the
 * remedy. Anything cleverer here would be the harness solving the task and then
 * congratulating the model for it.
 *
 * @param {Record<string, {ok: boolean, detail: string, output?: string, missing?: string[]}>} gates
 * @param {{ran: boolean, features: Record<string, {ok: boolean, detail: string}>}} [probe]
 * @returns {string | null}  null when there is nothing left to complain about.
 */
function nextUserMessage(brief, gates, probe) {
  const where = '`' + brief.appDir + '`';
  const manifest = { maven: 'pom.xml', python: 'main.py' }[brief.toolchain] || 'package.json';

  if (!gates.scaffold.ok) {
    return `I do not see the app. There is no \`${brief.appDir}/${manifest}\` in my workspace. Please create the project and its files.`;
  }

  // Every gate the brief defined, in the order it defined them, complaining about the
  // first one that is not passing. Skipped gates are not complaints — a machine without
  // Maven is not something the model can fix.
  for (const name of Object.keys(gates)) {
    const gate = gates[name];
    if (name === 'scaffold' || name === 'structure' || gate.ok || gate.skipped) continue;
    const output = String(gate.output || '').slice(-1800);
    if (!output) continue;
    return `\`${name}\` is failing in ${where}:\n\n\`\`\`\n${output}\n\`\`\`\n\nPlease fix it.`;
  }

  if (!gates.structure.ok) {
    return (
      'The build passes, but these files from the structure I asked for are missing: ' +
      (gates.structure.missing || []).join(', ') +
      '. Please add them and move the matching code into them.'
    );
  }

  if (probe && probe.ran) {
    const broken = Object.keys(probe.features).filter((name) => !probe.features[name].ok);
    if (broken.length) {
      const lines = broken.map((name) => '- ' + name + ': ' + probe.features[name].detail);
      const how =
        brief.toolchain === 'node'
          ? 'I opened the built app in a browser and tried it'
          : 'I ran the service layer and tried it';
      return (
        `${how}. These are not working:\n\n` +
        lines.join('\n') +
        '\n\nPlease fix them in the source and make sure the build still passes.'
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function runModel(options) {
  const { brief, model, capability, client, turns, budgetMs, scriptTimeoutMs, keep, workspace, stepSessions } = options;
  const features =
    { maven: JAVA_FEATURES, python: PYTHON_FEATURES }[brief.toolchain] || FEATURES;

  const root = workspace
    ? (fs.mkdirSync(workspace, { recursive: true }), fs.realpathSync(workspace))
    : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-real-')));

  const briefText = fs.readFileSync(path.join(__dirname, 'prompts', brief.promptFile), 'utf8');

  const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: true } });
  const auditLog = new AuditLog(root);
  /** @type {string[]} What the gate insisted on asking about, even with auto-approve on. */
  const confirmations = [];
  const gate = new PermissionGate({
    workspaceRoot: root,
    modes,
    auditLog,
    // Approved, and every one recorded.
    //
    // Auto-approve does not cover the always-confirm set — anything reaching the network
    // or publishing code — and the brief's very first instruction is
    // `npm create vite@latest`, which reaches the network. Declining unattended made the
    // task structurally impossible: the first run of this harness watched a model be
    // refused the scaffold command and then be blamed for there being no project. A user
    // sitting in front of the panel clicks Allow, so the benchmark does too, and the list
    // goes in the record where it can be read.
    confirm: async (request) => {
      confirmations.push(String((request && (request.command || request.path || request.title)) || 'unnamed'));
      return true;
    },
  });

  const memory = new MemoryStore(root, 1);
  const session = new AgentSession({
    client,
    model,
    capability,
    gate,
    workspaceRoot: root,
    memory,
    facts: new FactStore(root),
    history: new FileHistory(root),
    ledger: new OutcomeLedger(root),
    translator: new ContextTranslator({ client, memoryStore: memory, model }),
    environment: environmentProfile.detect(),
    thinkingCapacity: 'medium',
    sessionId: '1',
    scriptTimeoutMs,
    stepSessions: Boolean(stepSessions),
  });

  /** @type {Array<{role: string, text: string}>} */
  const conversation = [];
  const turnRecords = [];
  const startedAt = Date.now();
  let message = briefText;
  let finalGates = null;
  let finalProbe = null;

  for (let turn = 0; turn < turns + 1; turn += 1) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > budgetMs) {
      console.log(`\n  -- budget of ${(budgetMs / 60000).toFixed(0)} min spent after ${turn} turn(s); stopping.`);
      break;
    }

    console.log(`\n  == turn ${turn + 1}: ${turn === 0 ? 'the brief' : message.split('\n')[0].slice(0, 90)}`);
    /** @type {Record<string, number>} */
    const actions = {};
    /** @type {string[]} */
    const failures = [];
    /**
     * Files the request named that the run could not produce.
     *
     * Recorded separately from tool failures because it is a different fact: not "the
     * agent tried and the tool refused" but "the model was asked for this file and what
     * came back was not one". The first sweep dropped five of eleven files this way and
     * the log said nothing at all.
     *
     * @type {Array<{path: string, reason: string}>}
     */
    const missedFiles = [];
    let lastAction = '?';

    const turnStarted = Date.now();
    const outcome = await session.run(message, {
      mode: 'agent',
      conversation: conversation.slice(),
      onEvent: (event) => {
        if (event.type === 'action') {
          lastAction = event.action.action;
          actions[lastAction] = (actions[lastAction] || 0) + 1;
          const target = event.action.path || event.action.command || event.action.query || '';
          console.log(`     ${String(event.step).padStart(2)}. ${lastAction} ${String(target).slice(0, 70)}`);
        } else if (event.type === 'observation' && !event.result.ok) {
          const text = String(event.result.observation).split('\n')[0].slice(0, 120);
          failures.push(lastAction + ': ' + text);
          console.log(`         FAILED: ${text}`);
        } else if (event.type === 'dictation-failed') {
          missedFiles.push({ path: String(event.path), reason: String(event.reason).slice(0, 160) });
          console.log(`         NOT WRITTEN: ${event.path} — ${event.reason}`);
        }
      },
    });

    conversation.push({ role: 'user', text: message });
    conversation.push({ role: 'assistant', text: String(outcome.summary || '') });

    const gates = runGates(brief, root, scriptTimeoutMs);
    finalGates = gates;
    /** @type {any} */
    let probe = null;
    if (gates.build.ok) {
      if (brief.toolchain === 'maven') probe = await probeJavaService(path.join(root, brief.appDir));
      else if (brief.toolchain === 'python') probe = await probePythonService(path.join(root, brief.appDir));
      else probe = await probeApp(path.join(root, brief.appDir, 'dist'), { suite: brief.probe });
      finalProbe = probe;
    }

    const gateLine = Object.keys(gates)
      .map((name) => (gates[name].ok ? '+' : '-') + name)
      .join(' ');
    console.log(
      `     -> ${outcome.stopReason}, ${(outcome.steps || []).length} step(s), ${((Date.now() - turnStarted) / 1000).toFixed(0)}s` +
        `  [${gateLine}]${probe && probe.ran ? '  features ' + probe.passed + '/' + probe.total : ''}`
    );

    turnRecords.push({
      turn: turn + 1,
      userMessage: message.slice(0, 600),
      durationMs: Date.now() - turnStarted,
      claimed: { stopReason: outcome.stopReason, summary: String(outcome.summary || '').slice(0, 800) },
      actions,
      steps: (outcome.steps || []).length,
      failures: failures.slice(0, 12),
      missedFiles,
      commands: (outcome.changeSet && outcome.changeSet.commands ? outcome.changeSet.commands : []).map((c) => ({
        command: c.command,
        ok: c.ok,
      })),
      filesTouched: (outcome.changeSet && outcome.changeSet.list ? outcome.changeSet.list() : []).map((c) => ({
        path: c.path,
        kind: c.kind,
      })),
      gates: Object.fromEntries(Object.keys(gates).map((name) => [name, { ok: gates[name].ok, detail: gates[name].detail }])),
      features: probe && probe.ran ? Object.fromEntries(Object.keys(probe.features).map((n) => [n, probe.features[n].ok])) : null,
      featureScore: probe && probe.ran ? probe.passed : null,
    });

    const next = nextUserMessage(brief, gates, probe);
    if (!next) {
      console.log('\n  == everything the brief asked for is working. Stopping.');
      break;
    }
    message = next;
  }

  await auditLog.flush();
  const audit = await auditLog.read().catch(() => []);

  const result = {
    schemaVersion: SCHEMA_VERSION,
    benchmark: 'realworld-' + brief.id,
    brief: brief.id,
    briefLabel: brief.label,
    model,
    tier: capability.tier,
    params: capability.params,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    turnsUsed: turnRecords.length,
    turnsAllowed: turns + 1,
    stepSessions: Boolean(stepSessions),
    workspace: keep || workspace ? root : null,
    turns: turnRecords,
    gates: finalGates
      ? Object.fromEntries(Object.keys(finalGates).map((n) => [n, { ok: finalGates[n].ok, detail: finalGates[n].detail }]))
      : null,
    buildOutput: finalGates && finalGates.build ? String(finalGates.build.output || '').slice(-2000) : '',
    features: finalProbe && finalProbe.ran ? Object.fromEntries(features.map((n) => [n, finalProbe.features[n]])) : null,
    featureScore: finalProbe && finalProbe.ran ? finalProbe.passed : 0,
    featureTotal: features.length,
    consoleErrors: finalProbe ? finalProbe.consoleErrors : [],
    pageErrors: finalProbe ? finalProbe.pageErrors : [],
    // The single number this benchmark exists to produce: a working product, or not.
    delivered: Boolean(finalGates && finalGates.build.ok && finalProbe && finalProbe.ran && finalProbe.passed === features.length),
    filesInWorkspace: findFiles(root).sort().slice(0, 400),
    confirmations: confirmations.slice(0, 40),
    auditDecisions: audit.reduce((acc, event) => {
      acc[event.decision] = (acc[event.decision] || 0) + 1;
      return acc;
    }, {}),
    machine: {
      platform: process.platform,
      cpu: (os.cpus()[0] || {}).model || 'unknown',
      cores: os.cpus().length,
      totalMemGb: Math.round(os.totalmem() / 1024 / 1024 / 1024),
      node: process.version,
    },
  };

  if (!keep && !workspace) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.log('\n  workspace kept at ' + root);

  return result;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const model = positional[0];
  const brief = briefs.byId(String(flags.brief || 'todo'));
  const machine = String(flags.machine || process.env.HIRAYA_BENCH_MACHINE || '').toUpperCase();

  if (!model || !machine) {
    console.error('Usage: node tools/bench-realworld.js <model> --machine <A|B|C> [--brief todo|cms|pos] [--turns 10] [--keep]');
    process.exit(1);
  }

  if (!brief) {
    console.error('Unknown brief. Available: ' + briefs.BRIEFS.map((b) => b.id).join(', '));
    process.exit(1);
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

  console.log(`\nHirayaCoder real-world benchmark — ${model} (tier ${capability.tier}, ${capability.params}B)`);
  console.log(`Brief: tools/prompts/${brief.promptFile} — ${brief.label}`);

  const result = await runModel({
    brief,
    model,
    capability,
    client,
    turns: Number(flags.turns || 10),
    budgetMs: Number(flags.budget || 90) * 60000,
    scriptTimeoutMs: Number(flags.timeout || 300) * 1000,
    keep: Boolean(flags.keep),
    workspace: flags.workspace ? path.resolve(String(flags.workspace)) : null,
    stepSessions: Boolean(flags.steps),
  });
  result.machineId = machine;
  result.notes = flags.notes ? String(flags.notes) : '';

  const outRoot = path.resolve(String(flags.out || path.join(__dirname, '..', 'benchmarks', 'results')));
  const dir = path.join(outRoot, machine);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `realworld-${brief.id}__${slug(model)}__${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`
  );
  fs.writeFileSync(file, JSON.stringify(result, null, 2));

  console.log('\n' + '='.repeat(72));
  console.log(`${model} — ${result.delivered ? 'DELIVERED a working app' : 'did not deliver a working app'}`);
  if (result.gates) {
    for (const name of Object.keys(result.gates)) {
      console.log(`  ${result.gates[name].ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} ${result.gates[name].detail}`);
    }
  }
  if (result.features) {
    console.log(`  features ${result.featureScore}/${result.featureTotal}:`);
    for (const name of Object.keys(result.features)) {
      const feature = result.features[name];
      console.log(`    ${feature.ok ? 'ok  ' : 'FAIL'} ${name.padEnd(16)} ${feature.detail}`);
    }
  }
  console.log(`  ${result.turnsUsed} turn(s), ${(result.durationMs / 60000).toFixed(1)} min`);
  console.log(`\nWritten to ${path.relative(process.cwd(), file)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { runGates, nextUserMessage, findJar, SCHEMA_VERSION };
