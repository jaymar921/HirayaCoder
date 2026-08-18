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
const { parseArgs, slug } = require('./lib/args');

/** Bumped when the JSON shape changes, so a later sweep can be told from an earlier one. */
const SCHEMA_VERSION = 1;

const ENDPOINT = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

/** Where the brief expects the project to end up. Every gate is relative to this. */
const APP_DIR = 'todo-glass-app';

/** The files section 3 of the brief names. Present-or-not, nothing about their contents. */
const REQUIRED_FILES = [
  'index.html',
  'package.json',
  'vite.config.js',
  'src/main.jsx',
  'src/App.jsx',
  'src/index.css',
  'src/hooks/useTodos.js',
  'src/components/TodoInput.jsx',
  'src/components/TodoItem.jsx',
  'src/components/TodoList.jsx',
  'src/components/TodoStats.jsx',
  'src/components/ClearButton.jsx',
  'README.md',
];

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
function runGates(root, scriptTimeoutMs) {
  const appPath = path.join(root, APP_DIR);
  const gates = {};

  const scaffolded = fs.existsSync(path.join(appPath, 'package.json'));
  gates.scaffold = { ok: scaffolded, detail: scaffolded ? APP_DIR + '/package.json exists' : 'no ' + APP_DIR + '/package.json' };

  const missing = REQUIRED_FILES.filter((relative) => !fs.existsSync(path.join(appPath, relative)));
  gates.structure = {
    ok: scaffolded && missing.length === 0,
    detail: missing.length ? 'missing: ' + missing.join(', ') : 'all ' + REQUIRED_FILES.length + ' required files present',
    missing,
  };

  if (!scaffolded) {
    gates.install = { ok: false, detail: 'not attempted — nothing to install' };
    gates.build = { ok: false, detail: 'not attempted — nothing to build', output: '' };
    return gates;
  }

  const installed = fs.existsSync(path.join(appPath, 'node_modules'));
  const install = installed
    ? { ok: true, stdout: '', stderr: '', code: 0 }
    : exec(['npm', 'install'], appPath, Math.max(scriptTimeoutMs, 600000));
  gates.install = {
    ok: install.ok,
    detail: installed ? 'node_modules already present' : install.ok ? 'npm install exited 0' : 'npm install failed',
    output: install.ok ? '' : plain(install.stderr || install.stdout).slice(-3000),
  };

  if (!gates.install.ok) {
    gates.build = { ok: false, detail: 'not attempted — dependencies are not installed', output: '' };
    return gates;
  }

  // Remove the previous bundle first. A `dist/` left by an earlier turn passes the
  // probe for a build that has since started failing, which is the single worst lie a
  // benchmark can tell.
  fs.rmSync(path.join(appPath, 'dist'), { recursive: true, force: true });
  const build = exec(['npm', 'run', 'build'], appPath, Math.max(scriptTimeoutMs, 600000));
  gates.build = {
    ok: build.ok && fs.existsSync(path.join(appPath, 'dist', 'index.html')),
    detail: build.ok ? 'npm run build exited 0' : 'npm run build failed',
    output: plain(build.ok ? build.stdout : build.stderr || build.stdout).slice(-4000),
  };

  return gates;
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
function nextUserMessage(gates, probe) {
  if (!gates.scaffold.ok) {
    return (
      'I do not see the app. There is no `' +
      APP_DIR +
      '/package.json` in my workspace. Please create the project and its files.'
    );
  }
  if (!gates.install.ok) {
    return 'Dependencies are not installed. `npm install` in `' + APP_DIR + '` fails with:\n\n```\n' + String(gates.install.output || '').slice(-1500) + '\n```';
  }
  if (!gates.build.ok) {
    return 'The build fails. I ran `npm run build` in `' + APP_DIR + '` and got:\n\n```\n' + String(gates.build.output || '').slice(-1800) + '\n```\n\nPlease fix it.';
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
      return (
        'I opened the built app in a browser and tried it. These are not working:\n\n' +
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
  const { model, capability, client, turns, budgetMs, scriptTimeoutMs, keep, workspace, stepSessions } = options;

  const root = workspace
    ? (fs.mkdirSync(workspace, { recursive: true }), fs.realpathSync(workspace))
    : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-real-')));

  const brief = fs.readFileSync(path.join(__dirname, 'prompts', 'todo-glass-app.md'), 'utf8');

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
  let message = brief;
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
        }
      },
    });

    conversation.push({ role: 'user', text: message });
    conversation.push({ role: 'assistant', text: String(outcome.summary || '') });

    const gates = runGates(root, scriptTimeoutMs);
    finalGates = gates;
    /** @type {any} */
    let probe = null;
    if (gates.build.ok) {
      probe = await probeApp(path.join(root, APP_DIR, 'dist'));
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

    const next = nextUserMessage(gates, probe);
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
    benchmark: 'realworld-todo-glass-app',
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
    features: finalProbe && finalProbe.ran ? Object.fromEntries(FEATURES.map((n) => [n, finalProbe.features[n]])) : null,
    featureScore: finalProbe && finalProbe.ran ? finalProbe.passed : 0,
    featureTotal: FEATURES.length,
    consoleErrors: finalProbe ? finalProbe.consoleErrors : [],
    pageErrors: finalProbe ? finalProbe.pageErrors : [],
    // The single number this benchmark exists to produce: a working product, or not.
    delivered: Boolean(finalGates && finalGates.build.ok && finalProbe && finalProbe.ran && finalProbe.passed === FEATURES.length),
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
  const machine = String(flags.machine || process.env.HIRAYA_BENCH_MACHINE || '').toUpperCase();

  if (!model || !machine) {
    console.error('Usage: node tools/bench-realworld.js <model> --machine <A|B|C> [--turns 10] [--keep]');
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
  console.log(`Brief: tools/prompts/todo-glass-app.md — React + Vite + Tailwind TODO app`);

  const result = await runModel({
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
  const file = path.join(dir, `realworld__${slug(model)}__${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
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
    for (const name of FEATURES) {
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

module.exports = { runGates, nextUserMessage, REQUIRED_FILES, APP_DIR, SCHEMA_VERSION };
