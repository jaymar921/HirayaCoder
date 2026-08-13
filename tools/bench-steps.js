'use strict';

/* eslint-disable security/detect-non-literal-fs-filename, no-console --
 * A developer benchmark script. Every path it touches is inside a temp directory it
 * created itself, and its whole output is a console report. */

/**
 * The step-sessions benchmark: does the wiring step ever happen?
 *
 * `bench-agent.js` asks whether a model can edit a project, and `bench-build.js`
 * whether it can create one. Neither reproduces the failure that motivated step
 * sessions, which needs a project that *already exists* and a multi-item request whose
 * last item has to import what the earlier items wrote.
 *
 * That is the shape of the React + Vite + Tailwind evaluation: five models, five
 * sessions, and in every one of them `App.jsx` ended the run still holding Vite's
 * scaffolded counter demo. Components were written; nothing was ever wired to anything.
 *
 * So this fixture is a scaffolded Vite app, and the grade is one question the harness
 * answers itself: **is `App.jsx` different, and does it import what the run built?**
 * The model's summary is printed and counts for nothing, for the reason the rest of
 * this project keeps repeating — a model reporting success having written nothing is
 * the most common failure these runs find.
 *
 * Usage:
 *
 *   node tools/bench-steps.js <model> [steps|nosteps] [--keep]
 *
 *   node tools/bench-steps.js qwen3.5:4b steps
 *   node tools/bench-steps.js qwen3.5:4b nosteps      # the v0.4.0 behaviour, to compare
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

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
const importGraph = require(path.join(appRoot, 'core', 'importGraph'));

const MODEL = process.argv[2] || 'qwen3.5:4b';
const STEP_SESSIONS = process.argv[3] !== 'nosteps';
const KEEP = process.argv.includes('--keep');

/** The Vite React scaffold, as `npm create vite` leaves it. */
const SCAFFOLD = {
  'package.json': JSON.stringify(
    { name: 'todo-app', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build' } },
    null,
    2
  ),
  'index.html': '<!doctype html>\n<html>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n',
  'src/main.jsx': "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\n\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  'src/App.jsx':
    "import { useState } from 'react';\nimport './App.css';\n\n" +
    'export default function App() {\n' +
    '  const [count, setCount] = useState(0);\n' +
    '  return (\n' +
    '    <div className="card">\n' +
    '      <button onClick={() => setCount((c) => c + 1)}>count is {count}</button>\n' +
    '    </div>\n' +
    '  );\n' +
    '}\n',
  'src/App.css': '.card {\n  padding: 2em;\n}\n',
  'src/index.css': ':root {\n  font-family: sans-serif;\n}\n',
};

const TASK = `Turn this scaffolded Vite app into a working TODO app.

1. Create src/hooks/useTodos.js — a hook holding the todo array in state, with addTodo,
   removeTodo and toggleTodo.
2. Create src/components/TodoInput.jsx — a form that calls addTodo on submit.
3. Create src/components/TodoList.jsx — renders the todos with a delete button each.
4. Rewrite src/App.jsx so it uses the useTodos hook and renders TodoInput and TodoList.
   It must not be the counter demo any more.

Use React function components and hooks only. No backend.`;

function writeScaffold(root) {
  for (const [relative, content] of Object.entries(SCAFFOLD)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
}

/**
 * What the run actually produced, judged from the filesystem.
 *
 * ## Naming an import is not the same as having one
 *
 * The first version of this checked that `App.jsx` mentioned `useTodos` on an import
 * line, and that is too weak by exactly the margin that matters. A model that writes
 * `import { useTodos } from '../hooks/useTodos'` from inside `src/App.jsx` has named
 * the right thing and pointed at nothing — the app does not build, and the check passes.
 *
 * So the specifiers are resolved against the workspace with the same `importGraph` the
 * agent uses, and `wired` counts only the ones that reach a real file. `named` is kept
 * beside it, because the difference between the two is itself the interesting result:
 * it separates "did not attempt the wiring" from "attempted it and got the path wrong".
 *
 * @param {string} root
 * @returns {Promise<{appChanged: boolean, named: string[], wired: string[], broken: string[], created: string[], stillCounter: boolean}>}
 */
async function grade(root) {
  const appPath = path.join(root, 'src', 'App.jsx');
  const app = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';

  const created = [];
  for (const relative of ['src/hooks/useTodos.js', 'src/components/TodoInput.jsx', 'src/components/TodoList.jsx']) {
    if (fs.existsSync(path.join(root, relative))) created.push(relative);
  }

  const named = ['useTodos', 'TodoInput', 'TodoList'].filter((name) =>
    new RegExp(`import[^\\n]*\\b${name}\\b`).test(app)
  );

  const resolved = await importGraph.resolveImports({ content: app, path: 'src/App.jsx', workspaceRoot: root });
  const wired = named.filter((name) => resolved.some((target) => target.includes(name)));

  return {
    appChanged: app !== SCAFFOLD['src/App.jsx'],
    named,
    wired,
    broken: named.filter((name) => !wired.includes(name)),
    created,
    stillCounter: /count is \{count\}/.test(app),
  };
}

(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-steps-bench-')));
  writeScaffold(root);

  // `timeoutMs`, not `requestTimeoutMs` — the latter is the *setting* name, and passing
  // it here is silently ignored, leaving the 300s default. Rewriting App.jsx with four
  // imports is a long single generation on CPU: it timed out at 300s on `qwen3.5:4b`
  // mid-run, and the step only survived because the retry caught it.
  const client = createClient({ endpoint: 'http://127.0.0.1:11434', timeoutMs: 900000 });

  const discovered = await new ModelDiscovery(client).get(MODEL, { force: true });
  if (!discovered) {
    console.error(`Model not installed: ${MODEL}. Try: ollama pull ${MODEL}`);
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
    {}
  );
  const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: false } });

  console.log(`model      ${MODEL} (tier ${capability.tier}, todo lists ${capability.canPlanTodos})`);
  console.log(`steps      ${STEP_SESSIONS ? 'ON' : 'OFF (v0.4.0 behaviour)'}`);
  console.log(`workspace  ${root}\n`);

  const session = new AgentSession({
    client,
    model: MODEL,
    capability,
    gate: new PermissionGate({
      workspaceRoot: root,
      modes,
      auditLog: new AuditLog(root),
      confirm: async () => true,
    }),
    workspaceRoot: root,
    memory: new MemoryStore(root, 1),
    translator: new ContextTranslator({ client, model: MODEL, memory: new MemoryStore(root, 1) }),
    thinkingCapacity: 'medium',
    sessionId: '1',
    stepSessions: STEP_SESSIONS,
  });

  const startedAt = Date.now();
  const result = await session.run(TASK, {
    mode: 'agent',
    onEvent: (event) => {
      if (event.type === 'todo') console.log(`plan       ${event.items.length} item(s)\n${event.items.map((t, i) => `           ${i + 1}. ${t}`).join('\n')}\n`);
      if (event.type === 'todo-item') console.log(`\n--- step ${event.index}/${event.total}: ${event.text}`);
      if (event.type === 'todo-item-retry') console.log(`    RETRY: ${event.reason}`);
      if (event.type === 'action') console.log(`    ${event.step}. ${event.action.action} ${event.action.path || event.action.command || event.action.query || ''}`);
      if (event.type === 'todo-item-done') console.log(`    => ${event.status}`);
    },
  });

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const graded = await grade(root);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`stopReason      ${result.stopReason}   steps ${result.steps.length}   ${seconds}s`);
  console.log(`files created   ${graded.created.length ? graded.created.join(', ') : '(none)'}`);
  console.log(`App.jsx changed ${graded.appChanged ? 'YES' : 'NO'}`);
  console.log(`App.jsx names   ${graded.named.length ? graded.named.join(', ') : '(nothing it built)'}`);
  console.log(`  of those, resolving to a real file: ${graded.wired.length ? graded.wired.join(', ') : '(none)'}`);
  if (graded.broken.length > 0) console.log(`  BROKEN import path(s): ${graded.broken.join(', ')}`);
  console.log(`still counter   ${graded.stillCounter ? 'YES — the benchmark failure' : 'no'}`);
  console.log(`${'='.repeat(72)}`);

  // The App.jsx import lines, verbatim. A wrong relative path is the one failure this
  // report cannot convey in a boolean, and it is cheap to just show.
  const appFile = path.join(root, 'src', 'App.jsx');
  if (fs.existsSync(appFile)) {
    const lines = fs.readFileSync(appFile, 'utf8').split('\n').filter((line) => /^\s*import\b/.test(line));
    if (lines.length > 0) console.log(`\nApp.jsx imports, verbatim:\n${lines.join('\n')}`);
  }
  console.log(`\nThe model's own account (graded on nothing):\n${result.summary}\n`);

  if (KEEP) console.log(`kept ${root}`);
  else fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
