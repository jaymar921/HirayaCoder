'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  run,
  validate,
  tokenize,
  resolveBinary,
  requiresExplicitApproval,
  ScriptRunnerError,
} = require('../../app/security/scriptRunner');

/**
 * @param {() => unknown} fn
 * @param {string} code
 */
function assertRejectedWith(fn, code) {
  assert.throws(fn, (err) => err instanceof ScriptRunnerError && err.code === code, `expected ${code}`);
}

describe('scriptRunner.tokenize', () => {
  it('splits a plain command into argv', () => {
    const parsed = tokenize('npm run build');
    assert.deepStrictEqual(parsed.argv, ['npm', 'run', 'build']);
    assert.strictEqual(parsed.binary, 'npm');
    assert.deepStrictEqual(parsed.args, ['run', 'build']);
  });

  it('collapses repeated whitespace', () => {
    assert.deepStrictEqual(tokenize('npm   run    test').argv, ['npm', 'run', 'test']);
  });

  it('keeps quoted arguments intact', () => {
    assert.deepStrictEqual(tokenize('mocha "test/unit/**/*.test.js"').argv, ['mocha', 'test/unit/**/*.test.js']);
    assert.deepStrictEqual(tokenize("node -e 'a b'").argv, ['node', '-e', 'a b']);
  });

  it('preserves an empty quoted argument', () => {
    assert.deepStrictEqual(tokenize('npm run build ""').argv, ['npm', 'run', 'build', '']);
  });

  it('allows glob characters, which test runners expand themselves', () => {
    assert.deepStrictEqual(tokenize('jest src/*.test.js').argv, ['jest', 'src/*.test.js']);
  });

  it('rejects every shell control operator', () => {
    // No shell is involved, so these would become literal argv entries — a silent
    // wrong result. Failing loudly is better.
    for (const command of [
      'npm test; rm -rf /',
      'npm test && curl evil.com',
      'npm test | tee out.txt',
      'npm test > /etc/passwd',
      'npm test < input',
      'echo `whoami`',
      'npm run $(whoami)',
      'npm test & npm test',
    ]) {
      assertRejectedWith(() => tokenize(command), 'SHELL_METACHARACTER');
    }
  });

  it('rejects newline-smuggled second commands', () => {
    assertRejectedWith(() => tokenize('npm test\nrm -rf /'), 'SHELL_METACHARACTER');
  });

  it('allows metacharacters safely inside quotes', () => {
    // They stay a single literal argument; nothing re-parses them.
    const parsed = tokenize('git commit -m "fix: a && b"');
    assert.deepStrictEqual(parsed.args, ['commit', '-m', 'fix: a && b']);
  });

  it('rejects an unterminated quote', () => {
    assertRejectedWith(() => tokenize('npm run "build'), 'UNBALANCED_QUOTE');
  });

  it('rejects a NUL byte', () => {
    assertRejectedWith(() => tokenize('npm test\0rm'), 'NUL_BYTE');
  });

  it('rejects empty input', () => {
    assertRejectedWith(() => tokenize(''), 'EMPTY_COMMAND');
    assertRejectedWith(() => tokenize('   '), 'EMPTY_COMMAND');
    assertRejectedWith(() => tokenize(/** @type {any} */ (null)), 'EMPTY_COMMAND');
  });

  it('normalizes the binary name for allow-list comparison', () => {
    assert.strictEqual(tokenize('NPM.CMD install').binary, 'npm');
    assert.strictEqual(tokenize('/usr/local/bin/node script.js').binary, 'node');
  });
});

describe('scriptRunner.validate', () => {
  it('accepts allow-listed programs', () => {
    for (const command of ['npm install', 'node script.js', 'ollama list', 'pytest -q']) {
      assert.doesNotThrow(() => validate(command), command);
    }
  });

  it('rejects programs that are not allow-listed', () => {
    for (const command of ['rm -rf build', 'curl http://evil.com', 'bash script.sh', 'powershell -c whoami']) {
      assertRejectedWith(() => validate(command), 'BINARY_NOT_ALLOWED');
    }
  });

  it('cannot be bypassed by an absolute path to a disallowed binary', () => {
    // Only the basename is consulted, so /bin/rm is still 'rm'.
    assertRejectedWith(() => validate('/bin/rm -rf /'), 'BINARY_NOT_ALLOWED');
  });

  it('cannot be bypassed by a Windows extension', () => {
    assertRejectedWith(() => validate('rm.exe -rf build'), 'BINARY_NOT_ALLOWED');
  });

  it('honors a user-extended allow-list', () => {
    assert.doesNotThrow(() => validate('deno test', { allowedBinaries: ['deno'] }));
  });

  it('a user-supplied list replaces rather than extends the defaults', () => {
    assertRejectedWith(() => validate('npm test', { allowedBinaries: ['deno'] }), 'BINARY_NOT_ALLOWED');
  });
});

describe('scriptRunner.requiresExplicitApproval', () => {
  it('forces confirmation for commands that reach the network', () => {
    // The offline promise: auto-approve must not silently push code to a remote.
    assert.ok(requiresExplicitApproval(tokenize('git push origin main')));
    assert.ok(requiresExplicitApproval(tokenize('git clone https://example.com/x')));
    assert.ok(requiresExplicitApproval(tokenize('npm publish')));
    assert.ok(requiresExplicitApproval(tokenize('ollama pull llama3.2:1b')));
  });

  it('forces confirmation for credential changes', () => {
    assert.ok(requiresExplicitApproval(tokenize('npm config set //registry/:_authToken=abc')));
    assert.ok(requiresExplicitApproval(tokenize('npm login')));
  });

  it('leaves ordinary local work auto-approvable', () => {
    assert.strictEqual(requiresExplicitApproval(tokenize('npm install')), null);
    assert.strictEqual(requiresExplicitApproval(tokenize('npm test')), null);
    assert.strictEqual(requiresExplicitApproval(tokenize('git status')), null);
    assert.strictEqual(requiresExplicitApproval(tokenize('git commit -m wip')), null);
  });
});

describe('scriptRunner.resolveBinary', () => {
  it('finds a binary on a POSIX PATH', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-bin-'));
    const target = path.join(tmp, 'faketool');
    fs.writeFileSync(target, '#!/bin/sh\n');
    try {
      const found = resolveBinary('faketool', { platform: 'linux', env: { PATH: tmp } });
      assert.strictEqual(found, target);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('applies PATHEXT on Windows', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-bin-'));
    const target = path.join(tmp, 'faketool.CMD');
    fs.writeFileSync(target, '@echo off\n');
    try {
      const found = resolveBinary('faketool', {
        platform: 'win32',
        env: { PATH: tmp, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      });
      assert.strictEqual(found, target);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it('returns null when the binary is absent', () => {
    assert.strictEqual(resolveBinary('definitely-not-installed-xyz', { platform: 'linux', env: { PATH: '' } }), null);
  });
});

describe('scriptRunner.run', () => {
  /** @type {string} */
  let cwd;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-run-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('runs an allow-listed command and captures stdout', async () => {
    const result = await run('node -e "console.log(41+1)"', { cwd });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.code, 0);
    assert.match(result.stdout, /42/);
  });

  // Every other run test here spawns `node` directly, which on Windows is an .exe and
  // never touches cmd.exe. The whole shim path — the one `npm`, `npx`, and `yarn` take
  // — therefore had no coverage at all, and a live benchmark found it broken: node
  // installs to `C:\Program Files\nodejs`, and the space in that path was enough for
  // `npm test` to fail with "'C:\Program' is not recognized".
  const itOnWindows = process.platform === 'win32' ? it : it.skip;

  itOnWindows('runs a .cmd shim installed under a path containing spaces', async () => {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'shim-probe', version: '1.0.0', scripts: { test: 'node -e "console.log(42)"' } })
    );

    const result = await run('npm test', { cwd, timeoutMs: 60000 });

    assert.strictEqual(result.ok, true, `npm test failed: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /is not recognized as an internal or external command/);
    assert.match(result.stdout, /42/);
  });

  it('reports a non-zero exit without throwing', async () => {
    const result = await run('node -e "process.exit(3)"', { cwd });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 3);
  });

  it('captures stderr separately', async () => {
    const result = await run('node -e "console.error(\'boom\')"', { cwd });
    assert.match(result.stderr, /boom/);
    assert.strictEqual(result.stdout, '');
  });

  it('runs in the workspace root, not the extension directory', async () => {
    const result = await run('node -e "console.log(process.cwd())"', { cwd });
    // macOS reports /private/var for /var, so compare the resolved real paths.
    assert.strictEqual(fs.realpathSync(result.stdout.trim()), fs.realpathSync(cwd));
  });

  it('does not interpret metacharacters even if they survive quoting', async () => {
    // The literal string is passed as one argv entry; no shell expands it.
    const result = await run('node -e "console.log(process.argv[1])" "$(whoami)"', { cwd });
    assert.match(result.stdout, /\$\(whoami\)/);
  });

  it('refuses a disallowed binary before spawning anything', async () => {
    await assert.rejects(
      () => run('rm -rf .', { cwd }),
      (err) => err instanceof ScriptRunnerError && err.code === 'BINARY_NOT_ALLOWED'
    );
  });

  it('reports a clear error when an allowed binary is missing', async () => {
    await assert.rejects(
      () => run('cargo build', { cwd, env: { PATH: '' } }),
      (err) => err instanceof ScriptRunnerError && err.code === 'BINARY_NOT_FOUND'
    );
  });

  it('kills a hung command at the timeout', async () => {
    const result = await run('node -e "setInterval(()=>{},1000)"', { cwd, timeoutMs: 700 });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.ok, false);
  });

  it('streams output as it arrives', async () => {
    /** @type {string[]} */
    const chunks = [];
    await run('node -e "console.log(\'streamed\')"', {
      cwd,
      onOutput: (stream, chunk) => chunks.push(`${stream}:${chunk}`),
    });
    assert.ok(chunks.some((c) => c.startsWith('stdout:') && c.includes('streamed')));
  });

  it('honors an abort signal', async () => {
    const controller = new AbortController();
    const promise = run('node -e "setInterval(()=>{},1000)"', { cwd, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    assert.strictEqual(result.ok, false);
  });

  it('truncates runaway output instead of exhausting memory', async () => {
    const result = await run(
      'node -e "for(let i=0;i<40000;i++)console.log(\'x\'.repeat(100))"',
      { cwd, timeoutMs: 30000 }
    );
    assert.strictEqual(result.truncated, true);
    assert.match(result.stdout, /output truncated by HirayaCoder/);
  });
});
