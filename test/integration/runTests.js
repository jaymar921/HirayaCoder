'use strict';

/**
 * Launcher for the integration suite.
 *
 * Downloads a real VS Code, opens it on a throwaway workspace, and runs the tests
 * inside the extension host. That is the whole point: the unit suite stubs `vscode`,
 * so nothing in it can tell you whether the extension actually activates, whether the
 * commands are really registered, or whether a webview panel can be created. Those are
 * the failures a user meets first.
 *
 * The workspace is a temp folder rather than a fixture in the repo, because the tests
 * write and delete files in it and a dirty working tree after a test run is its own
 * kind of bug.
 *
 * ## Why this does not call `runTests()`
 *
 * `@vscode/test-electron`'s own `runTests()` spawns VS Code like this on Windows
 * (`out/runTest.js`):
 *
 *     const shell = process.platform === 'win32';
 *     cp.spawn(shell ? `"${executable}"` : executable, args, { env, shell });
 *
 * The executable is quoted; the arguments are not. Under `shell: true` they are
 * concatenated rather than escaped, so any argument containing a space is split by the
 * shell. This repository lives at `F:\important stuff\...`, which turns
 * `--extensionDevelopmentPath=F:\important stuff\…` into two tokens and leaves VS Code
 * trying to run the workspace folder as its entry point:
 *
 *     Error: Cannot find module 'C:\Users\…\Temp\hiraya-int-2Vizuc'
 *
 * It is not exotic — `C:\Users\First Last\…` hits it too. So the download and the
 * path resolution are still `test-electron`'s job, and only the spawn is ours: an
 * argument array with `shell: false`, which is the same rule `security/scriptRunner.js`
 * follows and for the same reason.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

/** A small project for the agent to act on. Mirrors `tools/bench-agent.js`. */
function makeWorkspace() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-int-')));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'greet.js'),
    'function greet(name) {\n  return "Hello " + name;\n}\n\nmodule.exports = { greet };\n'
  );
  fs.writeFileSync(path.join(root, 'README.md'), '# Demo project\n\nA tiny greeting library.\n');
  return root;
}

/**
 * The environment for a child VS Code, with the parent's own instance scrubbed out.
 *
 * Running `npm run test:integration` from VS Code's integrated terminal inherits
 * `ELECTRON_RUN_AS_NODE=1`, which makes the downloaded `Code.exe` start as a plain
 * Node process. It then treats the first positional argument as a script and dies with
 *
 *     Error: Cannot find module 'C:\Users\…\Temp\hiraya-int-hYWhpP'
 *
 * — the workspace folder. The `VSCODE_*` variables alongside it (`VSCODE_PID`,
 * `VSCODE_IPC_HOOK`, `VSCODE_ESM_ENTRYPOINT`, `VSCODE_NLS_CONFIG`, …) all describe the
 * editor you launched from, and handing them to a second instance is meaningless at
 * best. The suite has to run identically from an integrated terminal, an external
 * shell, and CI, so they are removed rather than worked around.
 *
 * @returns {NodeJS.ProcessEnv}
 */
function childEnvironment(extra) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, ...extra };

  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_')) delete env[key];
  }

  return env;
}

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  const workspace = makeWorkspace();

  const executable = await downloadAndUnzipVSCode();

  // A dedicated profile directory keeps the run away from the developer's own VS Code
  // settings and extensions, and keeps successive runs reproducible.
  const profileDir = path.join(extensionDevelopmentPath, '.vscode-test', 'profile');

  const args = [
    workspace,
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    // HirayaCoder declares `untrustedWorkspaces.supported: false`, and the tests write
    // into the workspace, so the folder has to come up trusted.
    '--disable-workspace-trust',
    // Other installed extensions can register competing providers; the run should
    // measure this extension only.
    '--disable-extensions',
    `--user-data-dir=${path.join(profileDir, 'user-data')}`,
    `--extensions-dir=${path.join(profileDir, 'extensions')}`,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    `--extensionTestsPath=${extensionTestsPath}`,
  ];

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: 'inherit',
      shell: false,
      env: childEnvironment({
        HIRAYACODER_INTEGRATION: '1',
        HIRAYACODER_TEST_WORKSPACE: workspace,
      }),
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });

  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });

  if (exitCode !== 0) {
    console.error(`\nIntegration tests failed (exit code ${exitCode}).`);
    process.exit(exitCode);
  }
  console.log('\nIntegration tests passed.');
}

main().catch((err) => {
  console.error('Integration tests failed to run:', err);
  process.exit(1);
});
