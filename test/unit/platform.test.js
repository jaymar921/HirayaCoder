'use strict';

const assert = require('assert');
const path = require('path');

const {
  platformName,
  isWindows,
  resolveShell,
  detectEol,
  toLf,
  applyEol,
  toPosixPath,
  fromPosixPath,
  pathsEqual,
} = require('../../app/utils/platform');

describe('platform.resolveShell', () => {
  it('selects cmd.exe on Windows with an argument array', () => {
    const shell = resolveShell('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
    assert.strictEqual(shell.command, 'C:\\Windows\\system32\\cmd.exe');
    assert.deepStrictEqual(shell.args, ['/d', '/s', '/c']);
    assert.strictEqual(shell.windows, true);
  });

  it('falls back to a bare cmd.exe when ComSpec is unset', () => {
    assert.strictEqual(resolveShell('win32', {}).command, 'cmd.exe');
  });

  it('selects /bin/sh on macOS and Linux', () => {
    for (const os of ['darwin', 'linux']) {
      const shell = resolveShell(os, {});
      assert.strictEqual(shell.command, '/bin/sh', os);
      assert.deepStrictEqual(shell.args, ['-c'], os);
      assert.strictEqual(shell.windows, false, os);
    }
  });

  it('prefers the user bash when SHELL points at one', () => {
    assert.strictEqual(resolveShell('linux', { SHELL: '/usr/bin/bash' }).command, '/usr/bin/bash');
  });

  it('ignores a non-bash SHELL rather than trusting an exotic one', () => {
    // fish/zsh don't all accept `-c` with identical semantics; sh always does.
    assert.strictEqual(resolveShell('linux', { SHELL: '/usr/bin/fish' }).command, '/bin/sh');
  });

  it('never returns a shell spec that invites string interpolation', () => {
    for (const os of ['win32', 'darwin', 'linux']) {
      const shell = resolveShell(os, {});
      assert.ok(Array.isArray(shell.args), `${os} args must be an array`);
      assert.ok(
        shell.args.every((a) => typeof a === 'string' && !a.includes('${')),
        `${os} args must be literal flags`
      );
    }
  });
});

describe('platform.platformName / isWindows', () => {
  it('normalizes the three supported families', () => {
    assert.strictEqual(platformName('win32'), 'win32');
    assert.strictEqual(platformName('darwin'), 'darwin');
    assert.strictEqual(platformName('linux'), 'linux');
    assert.strictEqual(platformName('aix'), 'other');
  });

  it('identifies Windows', () => {
    assert.strictEqual(isWindows('win32'), true);
    assert.strictEqual(isWindows('linux'), false);
  });
});

describe('platform line endings', () => {
  it('detects the dominant convention', () => {
    assert.strictEqual(detectEol('a\r\nb\r\nc'), '\r\n');
    assert.strictEqual(detectEol('a\nb\nc'), '\n');
  });

  it('does not count CR in CRLF as a bare LF', () => {
    assert.strictEqual(detectEol('a\r\nb\r\nc\nd'), '\r\n', 'two CRLF beat one LF');
  });

  it('normalizes to LF for internal processing', () => {
    assert.strictEqual(toLf('a\r\nb'), 'a\nb');
  });

  it('round-trips a CRLF file without corrupting it', () => {
    // The failure this guards: writing a CRLF file back as LF turns a one-line edit
    // into a whole-file diff.
    const original = 'line1\r\nline2\r\nline3';
    const eol = detectEol(original);
    assert.strictEqual(applyEol(toLf(original), eol), original);
  });

  it('does not double-convert already-CRLF text', () => {
    assert.strictEqual(applyEol('a\r\nb', '\r\n'), 'a\r\nb');
  });
});

describe('platform path helpers', () => {
  it('renders paths in a stable forward-slash form for prompts and logs', () => {
    const native = path.join('app', 'core', 'ollamaClient.js');
    assert.strictEqual(toPosixPath(native), 'app/core/ollamaClient.js');
  });

  it('round-trips a model-supplied path back to native form', () => {
    const native = path.join('app', 'core', 'ollamaClient.js');
    assert.strictEqual(fromPosixPath('app/core/ollamaClient.js'), native);
  });

  it('compares case-insensitively on Windows and macOS', () => {
    assert.strictEqual(pathsEqual('App/Core', 'app/core', 'win32'), true);
    assert.strictEqual(pathsEqual('App/Core', 'app/core', 'darwin'), true);
    assert.strictEqual(pathsEqual('App/Core', 'app/core', 'linux'), false);
  });

  it('normalizes before comparing', () => {
    assert.strictEqual(pathsEqual('app/core/../core', 'app/core', 'linux'), true);
  });
});
