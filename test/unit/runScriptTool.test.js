'use strict';

/**
 * What the model is told when a command is refused.
 *
 * The refusal text is the only thing standing between a dead end and four wasted turns:
 * observed on `ornith:9b`, a refused `javac` was resent verbatim three more times until
 * the repeat guard ended the item.
 */

const assert = require('assert');

const runScript = require('../../app/agent/tools/runScript');
const { nextStepAfterRefusal } = runScript;

/** A gate that refuses with a given code, without touching the machine. */
function refusingContext(code, reason) {
  return {
    sessionId: '1',
    mode: 'agent',
    gate: {
      async requestScript() {
        return { allowed: false, decision: 'blocked', code, reason };
      },
    },
  };
}

describe('runScript refusals', () => {
  it('tells the model not to resend a command whose program is not allowed', async () => {
    const result = await runScript(
      { command: 'javac Main.java' },
      refusingContext('BINARY_NOT_ALLOWED', '"javac" is not in the allowed program list.')
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error, 'BINARY_NOT_ALLOWED');
    assert.match(result.observation, /do not retry it/i);
    // And it must say what to do instead, or the model has nowhere to go.
    assert.match(result.observation, /tell the user/i);
  });

  it('distinguishes "not installed" from "not allowed"', () => {
    assert.match(nextStepAfterRefusal('BINARY_NOT_FOUND'), /not installed/i);
    assert.match(nextStepAfterRefusal('BINARY_NOT_FOUND'), /what to install/i);
  });

  it('tells the model to drop the operators rather than rephrase around them', () => {
    assert.match(nextStepAfterRefusal('SHELL_METACHARACTER'), /one plain command/i);
  });

  it('states that a user refusal is a decision, not an obstacle', () => {
    const advice = nextStepAfterRefusal('USER_DENIED');
    assert.match(advice, /the user deciding/i);
    // The specific failure this guards: retrying, or achieving the same effect another
    // way — a model once tried `rm -rf` after a declined delete.
    assert.match(advice, /same effect another way/i);
  });

  it('says nothing extra when a retry might legitimately succeed', () => {
    // A command that failed on its own merits may well be worth another go with
    // different arguments; that is not a dead end.
    assert.strictEqual(nextStepAfterRefusal(undefined), '');
    assert.strictEqual(nextStepAfterRefusal('SOMETHING_ELSE'), '');
  });

  it('sends the model to the tool that does the job instead of to the user', async () => {
    // The live failure: three refused `mkdir -p src/main/java build` in a row, when
    // write_file would have made those folders on its own.
    const result = await runScript(
      { command: 'mkdir -p src/main/java build' },
      refusingContext('BINARY_NOT_ALLOWED', '"mkdir" is not in the allowed program list.')
    );

    assert.match(result.observation, /write_file creates any missing folders/i);
    assert.match(result.observation, /do not send it again/i);
    // Emphatically not the generic advice: handing this one back to the user would be
    // asking them to run a command the agent never needed.
    assert.doesNotMatch(result.observation, /tell the user which command/i);
  });

  it('names the read, list, and delete tools for their shell equivalents', () => {
    const { toolForRefusedCommand } = runScript;

    assert.match(toolForRefusedCommand('ls build/'), /list_files/);
    assert.match(toolForRefusedCommand('cat src/Main.java'), /read_file/);
    assert.match(toolForRefusedCommand('rm -rf src/obsolete.js'), /delete_file/);
    assert.match(toolForRefusedCommand('grep -r TODO .'), /search_workspace/);
  });

  it('matches on the bare program name, however it was written', () => {
    const { toolForRefusedCommand } = runScript;

    assert.match(toolForRefusedCommand('/bin/ls'), /list_files/);
    assert.match(toolForRefusedCommand('C:\\Windows\\System32\\where.exe'), /^$/);
    assert.match(toolForRefusedCommand('MKDIR build'), /write_file/);
  });

  it('falls back to the generic advice for a program no tool replaces', () => {
    const { toolForRefusedCommand } = runScript;

    assert.strictEqual(toolForRefusedCommand('docker compose up'), '');
    assert.match(nextStepAfterRefusal('BINARY_NOT_ALLOWED', 'docker compose up'), /tell the user which command/i);
  });

  it('sends a cd to the cwd argument, which is the thing that actually works', async () => {
    // The dead end behind most of the failed script runs in the v0.5.3 testing round:
    // the project was scaffolded into a subfolder, and the only way models knew to get
    // there was `cd todo-glass-app && npm run build` — refused as chaining, with no
    // alternative named, so they either retried it or gave up on building at all.
    const { toolForRefusedCommand } = runScript;

    assert.match(toolForRefusedCommand('cd todo-glass-app'), /"cwd"/);
    assert.match(nextStepAfterRefusal('SHELL_METACHARACTER'), /"cwd"/);
  });

  it('says how to correct a folder that does not exist, rather than only that it does not', () => {
    for (const code of ['CWD_NOT_FOUND', 'CWD_NOT_A_DIRECTORY']) {
      assert.match(nextStepAfterRefusal(code), /list_files/);
    }
  });

  it('still reports the gate\'s own reason first', async () => {
    const result = await runScript(
      { command: 'rm -rf .' },
      refusingContext('BINARY_NOT_ALLOWED', '"rm" is not in the allowed program list.')
    );
    assert.match(result.observation, /"rm" is not in the allowed program list/);
  });
});

/**
 * A gate that approves everything and returns canned results, one per attempt.
 *
 * @param {Array<object>} results
 */
function runningContext(results) {
  const runs = [];
  const attempts = [];
  return {
    runs,
    attempts,
    context: {
      sessionId: '1',
      mode: 'agent',
      scriptTimeoutMs: 120000,
      gate: {
        async requestScript(request) {
          runs.push(request);
          return { allowed: true, decision: 'auto-approved' };
        },
        async runScript(request) {
          attempts.push(request);
          const canned = results[Math.min(attempts.length - 1, results.length - 1)];
          return {
            ok: false,
            code: 1,
            stdout: '',
            stderr: '',
            timedOut: false,
            truncated: false,
            durationMs: 5,
            argv: [],
            ...canned,
          };
        },
      },
    },
  };
}

describe('failure reasons and the one retry', () => {
  it('names the reason and the fix, not just the exit code', async () => {
    const { context } = runningContext([{ stderr: "Error: Cannot find module 'react'" }]);
    const result = await runScript({ command: 'npm run build' }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.detail.reason, 'MISSING_DEPENDENCY');
    assert.match(result.observation, /npm install/);
  });

  it('tells a missing file from a missing package, though Node words them the same', async () => {
    // Live catch, `gemma3:1b`: it ran `node src/main.js` before writing main.js and was
    // told to run npm install for a file it had simply not created yet. A Windows
    // absolute path begins with a drive letter, which the first version of this rule
    // read as an ordinary package name.
    const cases = [
      ["Error: Cannot find module 'C:\\Users\\j\\app\\src\\main.js'", 'WRONG_PATH'],
      ["Error: Cannot find module './todo'", 'WRONG_PATH'],
      ['Failed to resolve import "./components/TodoItem.jsx" from "src/App.jsx"', 'WRONG_PATH'],
      ["Error: Cannot find module 'react'", 'MISSING_DEPENDENCY'],
      ["Error: Cannot find module '@vitejs/plugin-react'", 'MISSING_DEPENDENCY'],
    ];

    for (const [stderr, expected] of cases) {
      const { context } = runningContext([{ stderr }]);
      const result = await runScript({ command: 'node src/main.js' }, context);
      assert.strictEqual(result.detail.reason, expected, stderr);
    }
  });

  it('retries a network failure exactly once', async () => {
    const { context, runs } = runningContext([{ stderr: 'npm ERR! code ENOTFOUND' }]);
    const result = await runScript({ command: 'npm install' }, context);

    assert.strictEqual(result.detail.attempts, 2, 'should have tried twice');
    assert.strictEqual(runs.length, 1, 'the second attempt reuses the first approval');
    assert.match(result.observation, /run twice/i);
  });

  it('succeeds on the retry when the blip clears', async () => {
    const { context } = runningContext([{ stderr: 'npm ERR! code EAI_AGAIN' }, { ok: true, code: 0, stdout: 'added 42 packages' }]);
    const result = await runScript({ command: 'npm install' }, context);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.detail.attempts, 2);
  });

  it('never retries a failure the same command cannot survive', async () => {
    // The damage in the v0.5.3 round came from retries, not from their absence.
    for (const stderr of ['SyntaxError: Unexpected token }', 'npm ERR! missing script: buld', 'EACCES: permission denied']) {
      const { context } = runningContext([{ stderr }]);
      const result = await runScript({ command: 'npm run build' }, context);
      assert.strictEqual(result.detail.attempts, 1, `retried ${stderr}`);
    }
  });
});

describe('telling a command that finishes from one that does not', () => {
  const { isServerCommand } = require('../../app/agent/scriptDiagnosis');

  it('knows the commands that stay up', () => {
    for (const command of ['npm run dev', 'npm start', 'npm run preview', 'vite', 'nodemon server.js', 'npm test -- --watch']) {
      assert.ok(isServerCommand(command), `${command} should be treated as long-running`);
    }
  });

  it('leaves ordinary one-shot commands alone', () => {
    for (const command of ['npm run build', 'npm install', 'npm test', 'node index.js', 'git status', 'javac Main.java']) {
      assert.ok(!isServerCommand(command), `${command} should not be treated as long-running`);
    }
  });
});

describe('a build broken by the model\'s own config', () => {
  // Verbatim from a live `gemma4:e4b` run: `npm install` worked, every component was
  // written correctly, and then `npm run dev` died in 1.3s on a postcss.config.js that
  // used `module.exports` in a project `npm create vite` had marked "type": "module".
  const VITE_ESM_FAILURE =
    'VITE v5.4.21  ready in 2912 ms\n' +
    '[Failed to load PostCSS config: Failed to load PostCSS config (searchPath: F:/app): ' +
    '[ReferenceError] module is not defined in ES module scope\n' +
    "This file is being treated as an ES module because it has a '.js' file extension and " +
    'package.json contains "type": "module".\n' +
    '    at file:///F:/app/postcss.config.js:1:1]';

  it('names the module system, which matched no rule before', async () => {
    const { context } = runningContext([{ stderr: VITE_ESM_FAILURE, code: 1 }]);
    const result = await runScript({ command: 'npm run dev' }, context);

    assert.strictEqual(result.detail.reason, 'MODULE_SYSTEM');
    assert.match(result.observation, /export default|\.cjs/);
  });

  it('tells the loop this is the model\'s to fix, not to walk away from', async () => {
    const { context } = runningContext([{ stderr: VITE_ESM_FAILURE, code: 1 }]);
    const result = await runScript({ command: 'npm run dev' }, context);

    assert.strictEqual(result.detail.fixFirst, true);
    assert.match(result.observation, /run the command again/i);
  });

  it('calls a server that exited a failure, whatever it printed on the way out', async () => {
    // Vite says "ready in 2912 ms" and then dies, so the most recent line in the output
    // is the one that says it worked.
    const { context } = runningContext([{ stdout: 'VITE v5.4.21  ready in 2912 ms', stderr: 'something unrecognised', code: 1 }]);
    const result = await runScript({ command: 'npm run dev' }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.detail.reason, 'SERVER_EXITED');
    assert.match(result.observation, /exiting at all means it failed to start/i);
  });

  it('leaves an ordinary command with no recognisable error undiagnosed', async () => {
    // The fallback is about servers specifically. A build that fails in a way nothing
    // here understands must not be given an invented explanation.
    const { context } = runningContext([{ stderr: 'something unrecognised', code: 1 }]);
    const result = await runScript({ command: 'npm run build' }, context);

    assert.strictEqual(result.detail.reason, undefined);
  });
});

describe('a server that stays up while serving nothing but errors', () => {
  // Verbatim shape from a live `qwen3.5:4b` run. Vite started, announced itself, and
  // then failed every request — and the probe called it a working dev server, because
  // the failure list it checked named EADDRINUSE and missing modules and nothing else.
  const VITE_SERVING_500S = [
    '  VITE v8.2.1  ready in 906 ms',
    '  ➜  Local:   http://localhost:5173/',
    "10:12:33 PM [vite] Internal server error: [postcss] It looks like you're trying to use `tailwindcss` " +
      'directly as a PostCSS plugin. The PostCSS plugin has moved to a separate package, so to continue using ' +
      'Tailwind CSS with PostCSS you\'ll need to install `@tailwindcss/postcss` and update your PostCSS configuration.',
    '  File: F:/app/todo-glass-app/src/index.css:undefined:NaN',
    '      at mt (F:\\app\\todo-glass-app\\node_modules\\tailwindcss\\dist\\lib.js:38:1643)',
  ].join('\n');

  it('is not reported as a server that started', async () => {
    const { context } = runningContext([{ stdout: VITE_SERVING_500S, timedOut: true, code: null }]);
    const result = await runScript({ command: 'npm run dev' }, context);

    assert.strictEqual(result.ok, false, 'a broken app was reported as working');
    assert.strictEqual(result.detail.reason, 'TAILWIND_PLUGIN_MOVED');
    assert.match(result.observation, /@tailwindcss\/postcss/);
  });

  it('still calls a genuinely clean start a success', async () => {
    const { context } = runningContext([
      { stdout: '  VITE v5.4.21  ready in 300 ms\n  ➜  Local:   http://localhost:5173/', timedOut: true, code: null },
    ]);
    const result = await runScript({ command: 'npm run dev' }, context);

    assert.strictEqual(result.ok, true);
  });

  it('does not treat a build reporting zero errors as a failure', async () => {
    const { context } = runningContext([
      { stdout: 'webpack compiled with 0 errors\n  ➜  ready', timedOut: true, code: null },
    ]);
    const result = await runScript({ command: 'npm run dev' }, context);

    assert.strictEqual(result.ok, true);
  });
});

describe('an error nobody wrote a rule for', () => {
  it('sends the model to the file the error names', async () => {
    // The honest answer to "can it handle an error we have never seen": no rule list
    // covers a toolchain that has not shipped yet, but nearly every build error names
    // the file it choked on, and that is enough to act on.
    const { context } = runningContext([
      { stderr: 'FooPlugin: unrecoverable widget mismatch\n    at src/hooks/useTodos.js:12:3', code: 1 },
    ]);
    const result = await runScript({ command: 'npm run build' }, context);

    assert.strictEqual(result.detail.reason, 'UNRECOGNISED');
    assert.strictEqual(result.detail.fixFirst, true);
    assert.match(result.observation, /src\/hooks\/useTodos\.js/);
  });

  it('skips the frames that run through node_modules on the way', async () => {
    const { context } = runningContext([
      {
        stderr:
          'Error: something new\n    at x (node_modules/postcss/lib/lazy-result.js:367:16)\n' +
          '    at y (src/index.css:2:1)',
        code: 1,
      },
    ]);
    const result = await runScript({ command: 'npm run build' }, context);

    assert.match(result.observation, /src\/index\.css/);
    assert.doesNotMatch(result.observation.split('What went wrong')[1] || '', /node_modules/);
  });

  it('says nothing rather than inventing a file when the error names none', async () => {
    const { context } = runningContext([{ stderr: 'it broke', code: 1 }]);
    const result = await runScript({ command: 'npm run build' }, context);

    assert.strictEqual(result.detail.reason, undefined);
  });
});

describe('a command that never exits', () => {
  it('calls a dev server that stayed up a success', async () => {
    // Every model in the v0.5.3 round burned its full two-minute script budget here and
    // then read the kill as a failed step.
    const { context } = runningContext([
      { timedOut: true, code: null, stdout: 'VITE v5.0.0 ready in 300 ms' },
    ]);
    const result = await runScript({ command: 'npm run dev' }, context);

    assert.strictEqual(result.ok, true);
    assert.match(result.observation, /still running.*no startup errors/is);
    assert.match(result.observation, /do not run it again/i);
  });

  it('probes it briefly instead of spending the whole script budget', async () => {
    const { context, runs } = runningContext([{ timedOut: true, code: null }]);
    await runScript({ command: 'npm run dev' }, context);

    assert.strictEqual(runs[0].timeoutMs, runScript.PROBE_MS);
  });

  it('still fails a server that fell over on startup', async () => {
    const { context } = runningContext([
      { timedOut: true, code: null, stderr: 'Error: listen EADDRINUSE: address already in use :::5173' },
    ]);
    const result = await runScript({ command: 'npm run dev' }, context);

    assert.strictEqual(result.ok, false);
    assert.match(result.observation, /already listening on that port/i);
  });

  it('gives a build the full budget, since it is meant to finish', async () => {
    const { context, runs } = runningContext([{ ok: true, code: 0 }]);
    await runScript({ command: 'npm run build' }, context);

    assert.strictEqual(runs[0].timeoutMs, 120000);
  });
});

describe('what the model is told about a run', () => {
  const { describeRun } = runScript;
  const ok = { ok: true, code: 0, stdout: 'built in 1.2s', stderr: '', timedOut: false, durationMs: 12, argv: [] };

  it('names the folder, so a later step builds in the same place', () => {
    assert.match(describeRun('npm run build', ok, 400, 'todo-glass-app'), /in `todo-glass-app`/);
  });

  it('says nothing about a folder for a command that ran at the root', () => {
    assert.match(describeRun('npm run build', ok, 400), /^`npm run build` finished/);
  });
});

describe('the allow-list', () => {
  const { DEFAULT_ALLOWED_BINARIES } = require('../../app/security/scriptRunner');

  it('is documented in full, so the README cannot drift out of date', () => {
    // The README's Requirements section tells users which toolchains to install for
    // `run_script` to be able to do anything. A binary added here and not there is a
    // capability nobody knows they have; one removed here and left there is advice to
    // install something that will still be refused.
    const fs = require('fs');
    const path = require('path');
    const readme = fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8');

    const undocumented = DEFAULT_ALLOWED_BINARIES.filter((binary) => !readme.includes(`\`${binary}\``));
    assert.deepStrictEqual(undocumented, [], `not listed in README.md: ${undocumented.join(', ')}`);
  });

  it('permits the plain Java toolchain, since it already permits Maven and Gradle', () => {
    // Both `mvn` and `gradle` compile and run arbitrary Java. Refusing `javac`/`java`
    // blocked the simple case while allowing the far more capable one.
    for (const binary of ['java', 'javac', 'mvn', 'gradle']) {
      assert.ok(DEFAULT_ALLOWED_BINARIES.includes(binary), `${binary} should be allowed`);
    }
  });

  it('still refuses the programs that exist mainly to move or destroy files', () => {
    for (const binary of ['rm', 'del', 'curl', 'wget', 'bash', 'sh', 'powershell', 'cmd']) {
      assert.ok(!DEFAULT_ALLOWED_BINARIES.includes(binary), `${binary} must not be allowed`);
    }
  });
});
