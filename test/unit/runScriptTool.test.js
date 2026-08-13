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
