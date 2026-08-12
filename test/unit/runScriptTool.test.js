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

  it('still reports the gate\'s own reason first', async () => {
    const result = await runScript(
      { command: 'rm -rf .' },
      refusingContext('BINARY_NOT_ALLOWED', '"rm" is not in the allowed program list.')
    );
    assert.match(result.observation, /"rm" is not in the allowed program list/);
  });
});

describe('the allow-list', () => {
  const { DEFAULT_ALLOWED_BINARIES } = require('../../app/security/scriptRunner');

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
