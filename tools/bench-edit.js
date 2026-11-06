'use strict';

/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection --
 * A developer benchmark script. Every path it touches is a temp directory it created
 * itself or the results directory named on the command line, and the only computed keys
 * are suite and task names defined in tools/lib. */

/**
 * The edit benchmark: can a model change part of a file that already exists, without
 * breaking the rest of it?
 *
 * `bench-agent.js` edits a five-line file, which never tests the hard part. Real requests
 * are "change the tax rate" in a file of a hundred and fifty lines, and on the constrained
 * tier the only way to make that change used to be sending the whole file back inside one
 * JSON reply. This harness measures exactly that situation.
 *
 * Two suites, each a fixture file and four ordinary requests:
 *
 *   cart       src/cart.js, CommonJS, 164 lines. Used to develop the dictated edit.
 *   inventory  inventory.py, Python with classes, 85 lines. Written afterwards and **not
 *              tuned against**, so it says whether what worked on the cart generalises.
 *
 * Every task starts from a fresh copy of its fixture and runs through the real
 * `AgentSession` with auto-approve on. The grade comes from **running the file**, in a
 * child process, never from what the model said:
 *
 *   changed   the behaviour the task asked for is there
 *   intact    the file still loads and everything the task did not mention still behaves
 *             exactly as before
 *
 * A run that is `changed` but not `intact` damaged the file to make the change, which is
 * the outcome worth counting most.
 *
 * Usage:
 *
 *   node tools/bench-edit.js <model> --machine <A|B|C> [--suite cart|inventory] [--tasks a,b] [--repeat 2]
 *   node tools/bench-edit.js --selftest
 *
 * Results land in benchmarks/results/<machine>/edit-<suite>__<model>__<timestamp>.json.
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
const { parseArgs, slug } = require('./lib/args');

const cart = require('./lib/cartFixture');
const inventory = require('./lib/inventoryFixture');

/**
 * Each suite: the file, its contents, how to run a check against it, and what to break for
 * the grader's self-test.
 */
const SUITES = {
  cart: {
    file: 'src/cart.js',
    content: cart.CART_JS,
    runner: process.execPath,
    flag: '-e',
    prelude: cart.PRELUDE,
    loads: 'ok(typeof m === "object");',
    checks: cart.CHECKS,
    tasks: cart.TASKS,
    correct: cart.CORRECT,
    sabotage: (text) => text.replace('function formatMoney', 'function formatMoneyX'),
  },
  inventory: {
    file: 'inventory.py',
    content: inventory.INVENTORY_PY,
    runner: process.platform === 'win32' ? 'python' : 'python3',
    flag: '-c',
    prelude: inventory.PRELUDE,
    loads: 'ok(hasattr(m, "Inventory"))',
    checks: inventory.CHECKS,
    tasks: inventory.TASKS,
    correct: inventory.CORRECT,
    sabotage: (text) => text.replace('def format_price(amount):', 'def format_pricex(amount):'),
  },
};

/**
 * Run one check against the edited file in a child process, so a file that throws on load,
 * loops, or exits cannot take the harness with it.
 *
 * @param {object} suite
 * @param {string} file
 * @param {string} body
 * @returns {{pass: boolean, error?: string}}
 */
function runCheck(suite, file, body) {
  const run = spawnSync(suite.runner, [suite.flag, `${suite.prelude}\n${body}`, file], { encoding: 'utf8', timeout: 10000 });
  if (run.status === 0) return { pass: true };
  const message = String(run.stderr || run.error || '').split('\n').reverse().find((line) => /Error|assert/i.test(line)) || 'failed';
  return { pass: false, error: message.trim().slice(0, 160) };
}

/**
 * @param {object} suite
 * @param {string} root
 * @param {object} task
 */
function grade(suite, root, task) {
  const file = path.join(root, ...suite.file.split('/'));
  if (!fs.existsSync(file)) return { changed: false, intact: false, loads: false, regressions: ['file deleted'] };

  const loads = runCheck(suite, file, suite.loads);
  if (!loads.pass) return { changed: false, intact: false, loads: false, regressions: [loads.error] };

  const changed = runCheck(suite, file, task.target).pass;
  /** @type {string[]} */
  const broken = [];
  for (const [name, body] of Object.entries(suite.checks)) {
    if (task.replaces.includes(name)) continue;
    const result = runCheck(suite, file, body);
    if (!result.pass) broken.push(`${name}: ${result.error}`);
  }
  return { changed, intact: broken.length === 0, loads: true, regressions: broken };
}

/** @param {object} suite */
function makeWorkspace(suite) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-edit-')));
  const file = path.join(root, ...suite.file.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, suite.content);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
  return root;
}

/**
 * @param {object} options
 */
async function runOne({ client, model, capability, suite, taskName, task }) {
  const root = makeWorkspace(suite);
  const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: false } });
  const auditLog = new AuditLog(root);
  const gate = new PermissionGate({ workspaceRoot: root, modes, auditLog, confirm: async () => false });
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
    scriptTimeoutMs: 60000,
  });

  /** @type {string[]} */
  const actions = [];
  /** What each edit tried to match, so a miss can be explained from the record alone. @type {object[]} */
  const edits = [];
  /** @type {string[]} */
  const refusals = [];
  let parseErrors = 0;
  /** @type {string[]} */
  const unparseable = [];
  const started = Date.now();
  let result;
  try {
    result = await session.run(task.prompt, {
      mode: 'agent',
      onEvent: (event) => {
        if (event.type === 'action') {
          actions.push(`${event.action.action} ${event.action.path || event.action.command || ''}`.trim());
          if (event.action.action === 'edit_file') {
            edits.push({
              find: String(event.action.find || '').slice(0, 160),
              replace: String(event.action.replace || '').slice(0, 160),
              placed: Boolean(event.action.lines),
            });
          }
        }
        if (event.type === 'observation' && !event.result.ok) refusals.push(event.result.error || 'failed');
        if (event.type === 'parse-error') {
          parseErrors += 1;
          unparseable.push(String(event.raw || '').slice(0, 200));
        }
      },
    });
  } catch (err) {
    result = { stopReason: 'crashed', summary: /** @type {Error} */ (err).message };
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  await memory.flush();
  const notes = await memory.readAll();
  const graded = grade(suite, root, task);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return {
    task: taskName,
    ...graded,
    stopReason: result.stopReason,
    seconds,
    actions,
    edits,
    refusals,
    parseErrors,
    unparseable,
    memory: notes,
    summary: String(result.summary || '').slice(0, 300),
  };
}

/**
 * Check the grader before any model is graded by it: the untouched fixture must grade as
 * unchanged and intact, a correct edit as changed and intact, a sabotaged one as damaged.
 */
function selfTest() {
  let failures = 0;
  for (const [suiteName, suite] of Object.entries(SUITES)) {
    for (const [name, task] of Object.entries(suite.tasks)) {
      for (const [label, content, expect] of [
        ['untouched', suite.content, { changed: false, intact: true }],
        ['correct', suite.correct[name](suite.content), { changed: true, intact: true }],
        ['sabotaged', suite.sabotage(suite.correct[name](suite.content)), { intact: false }],
      ]) {
        const root = makeWorkspace(suite);
        fs.writeFileSync(path.join(root, ...suite.file.split('/')), content);
        const graded = grade(suite, root, task);
        fs.rmSync(root, { recursive: true, force: true });
        const okChanged = expect.changed === undefined || graded.changed === expect.changed;
        const okIntact = graded.intact === expect.intact;
        if (!okChanged || !okIntact) failures += 1;
        console.log(
          `  ${suiteName.padEnd(9)} ${name.padEnd(12)} ${label.padEnd(10)} changed=${graded.changed} intact=${graded.intact} ${okChanged && okIntact ? 'ok' : 'WRONG'}${okChanged && okIntact ? '' : ` ${graded.regressions.join('; ')}`}`
        );
      }
    }
  }
  console.log(failures === 0 ? 'self-test passed' : `self-test FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

(async () => {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.selftest) selfTest();
  const model = positional[0];
  const machine = String(flags.machine || '').toUpperCase();
  const suiteName = String(flags.suite || 'cart');
  const suite = SUITES[suiteName];
  if (!model || !['A', 'B', 'C'].includes(machine) || !suite) {
    console.error(
      'Usage: node tools/bench-edit.js <model> --machine <A|B|C> [--suite cart|inventory] [--tasks a,b] [--repeat 2] [--tier A|B] [--label text]'
    );
    process.exit(2);
  }
  const taskNames = String(flags.tasks || Object.keys(suite.tasks).join(',')).split(',').filter((name) => suite.tasks[name]);
  const repeat = Math.max(1, Number(flags.repeat) || 1);

  const client = createClient({ endpoint: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434' });
  const discovered = await new ModelDiscovery(client).get(model, { force: true });
  if (!discovered) {
    console.error(`Model not installed: ${model}`);
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

  console.log(
    `bench-edit: ${model} (Tier ${capability.tier}, ${capability.numCtx} window) on machine ${machine}, suite ${suiteName}, ${taskNames.length} task(s) x ${repeat}`
  );
  const runs = [];
  for (let sample = 0; sample < repeat; sample += 1) {
    for (const taskName of taskNames) {
      const run = await runOne({ client, model, capability, suite, taskName, task: suite.tasks[taskName] });
      runs.push({ sample, ...run });
      const verdict = run.changed && run.intact ? 'PASS' : run.changed ? 'CHANGED, DAMAGED' : run.intact ? 'untouched' : 'DAMAGED';
      console.log(
        `  ${taskName.padEnd(12)} ${verdict.padEnd(17)} ${String(run.seconds).padStart(6)}s  ${run.stopReason}  [${run.actions.join(' | ')}]${run.refusals.length ? `  refused: ${run.refusals.join(',')}` : ''}`
      );
      if (run.regressions.length) console.log(`               broken: ${run.regressions.join('; ')}`);
    }
  }

  const summary = {
    runs: runs.length,
    passed: runs.filter((r) => r.changed && r.intact).length,
    changed: runs.filter((r) => r.changed).length,
    damaged: runs.filter((r) => !r.intact).length,
    meanSeconds: Math.round((runs.reduce((sum, r) => sum + r.seconds, 0) / runs.length) * 10) / 10,
  };
  console.log(`\n${summary.passed}/${summary.runs} passed, ${summary.changed} changed, ${summary.damaged} damaged, mean ${summary.meanSeconds}s`);

  const record = {
    harness: 'bench-edit',
    suite: suiteName,
    model,
    machine,
    tier: capability.tier,
    numCtx: capability.numCtx,
    params: discovered.paramsLabel,
    label: flags.label ? String(flags.label) : undefined,
    at: new Date().toISOString(),
    summary,
    runs,
  };
  const dir = path.join(flags.out ? String(flags.out) : path.join(__dirname, '..', 'benchmarks', 'results'), machine);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `edit-${suiteName}__${slug(model)}__${record.at.replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
})().catch((err) => {
  console.error('BENCHMARK FAILED:', err);
  process.exit(1);
});
