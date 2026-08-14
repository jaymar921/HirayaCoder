'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PathGuardError,
  resolvePath,
  resolveForMutation,
  assertRealPath,
  assertRealPathSync,
  isInside,
  matchProtectedPrefix,
} = require('../../app/security/pathGuard');

const ROOT = path.resolve('/workspace/project');

/**
 * @param {() => unknown} fn
 * @param {string} code
 */
function assertRejectedWith(fn, code) {
  assert.throws(fn, (err) => err instanceof PathGuardError && err.code === code, `expected ${code}`);
}

describe('pathGuard.resolvePath', () => {
  it('accepts an ordinary relative path', () => {
    const resolved = resolvePath(ROOT, 'app/core/ollamaClient.js', { platform: 'linux' });
    assert.strictEqual(resolved.relative, 'app/core/ollamaClient.js');
    assert.strictEqual(resolved.absolute, path.join(ROOT, 'app', 'core', 'ollamaClient.js'));
  });

  it('accepts an absolute path that lands inside the workspace', () => {
    const inside = path.join(ROOT, 'src', 'index.js');
    assert.strictEqual(resolvePath(ROOT, inside, { platform: 'linux' }).relative, 'src/index.js');
  });

  it('normalizes traversal that stays inside', () => {
    const resolved = resolvePath(ROOT, 'app/core/../utils/logger.js', { platform: 'linux' });
    assert.strictEqual(resolved.relative, 'app/utils/logger.js');
  });

  it('rejects traversal that escapes the workspace', () => {
    assertRejectedWith(() => resolvePath(ROOT, '../../etc/passwd', { platform: 'linux' }), 'OUTSIDE_WORKSPACE');
    assertRejectedWith(() => resolvePath(ROOT, 'app/../../secrets.txt', { platform: 'linux' }), 'OUTSIDE_WORKSPACE');
  });

  it('rejects an absolute path outside the workspace', () => {
    assertRejectedWith(() => resolvePath(ROOT, '/etc/passwd', { platform: 'linux' }), 'OUTSIDE_WORKSPACE');
  });

  it('rejects a sibling directory sharing the root prefix', () => {
    // The bug a naive startsWith() check would have: /workspace/project-evil
    // begins with /workspace/project.
    assertRejectedWith(() => resolvePath(ROOT, '../project-evil/x.js', { platform: 'linux' }), 'OUTSIDE_WORKSPACE');
  });

  it('rejects a NUL byte', () => {
    // 'safe.txt\0../../etc/passwd' passes a naive string check, then the OS
    // truncates at the NUL and opens something else.
    assertRejectedWith(() => resolvePath(ROOT, 'safe.txt\0../../etc/passwd', { platform: 'linux' }), 'NUL_BYTE');
  });

  it('rejects empty and non-string input', () => {
    assertRejectedWith(() => resolvePath(ROOT, '', { platform: 'linux' }), 'EMPTY_PATH');
    assertRejectedWith(() => resolvePath(ROOT, '   ', { platform: 'linux' }), 'EMPTY_PATH');
    assertRejectedWith(() => resolvePath(ROOT, /** @type {any} */ (null), { platform: 'linux' }), 'EMPTY_PATH');
  });

  it('refuses everything when no workspace is open', () => {
    assertRejectedWith(() => resolvePath('', 'a.js', { platform: 'linux' }), 'NO_WORKSPACE');
  });

  it('accepts forward slashes from the model on Windows', () => {
    const winRoot = 'C:\\workspace\\project';
    const resolved = resolvePath(winRoot, 'app/core/x.js', { platform: 'win32' });
    assert.strictEqual(resolved.relative, 'app/core/x.js');
  });

  it('rejects Windows reserved device names', () => {
    const winRoot = 'C:\\workspace\\project';
    assertRejectedWith(() => resolvePath(winRoot, 'CON', { platform: 'win32' }), 'RESERVED_NAME');
    assertRejectedWith(() => resolvePath(winRoot, 'src/nul.txt', { platform: 'win32' }), 'RESERVED_NAME');
    assertRejectedWith(() => resolvePath(winRoot, 'COM1.js', { platform: 'win32' }), 'RESERVED_NAME');
  });

  it('allows names that merely start like a reserved one', () => {
    const winRoot = 'C:\\workspace\\project';
    assert.doesNotThrow(() => resolvePath(winRoot, 'console.js', { platform: 'win32' }));
    assert.doesNotThrow(() => resolvePath(winRoot, 'auxiliary.ts', { platform: 'win32' }));
  });
});

describe('pathGuard.isInside', () => {
  it('treats the root itself as inside', () => {
    assert.strictEqual(isInside(ROOT, ROOT, 'linux'), true);
  });

  it('is case-insensitive on Windows and macOS only', () => {
    assert.strictEqual(isInside('/a/b', '/A/B/c', 'darwin'), true);
    assert.strictEqual(isInside('/a/b', '/A/B/c', 'linux'), false);
  });
});

describe('pathGuard.resolveForMutation', () => {
  it('refuses to touch the workspace root itself', () => {
    assertRejectedWith(() => resolveForMutation(ROOT, '.', { platform: 'linux' }), 'IS_ROOT');
  });

  it('protects .git from writes and deletes', () => {
    assertRejectedWith(() => resolveForMutation(ROOT, '.git/config', { platform: 'linux' }), 'PROTECTED_PATH');
    assertRejectedWith(() => resolveForMutation(ROOT, '.git', { platform: 'linux' }), 'PROTECTED_PATH');
  });

  it("protects the agent's own memory and audit log", () => {
    // Without this the agent could rewrite its own audit trail or poison the
    // memory it will later read back as trusted context.
    assertRejectedWith(() => resolveForMutation(ROOT, '.hirayacoder/audit.log', { platform: 'linux' }), 'PROTECTED_PATH');
    assertRejectedWith(
      () => resolveForMutation(ROOT, '.hirayacoder/memory/session1.txt', { platform: 'linux' }),
      'PROTECTED_PATH'
    );
  });

  it('still allows reads of protected paths', () => {
    // Reading .git/HEAD is legitimately useful; only mutation is restricted.
    assert.doesNotThrow(() => resolvePath(ROOT, '.git/HEAD', { platform: 'linux' }));
  });

  it('honors a custom protected list', () => {
    assertRejectedWith(
      () => resolveForMutation(ROOT, 'vendor/lib.js', { platform: 'linux', protectedPrefixes: ['vendor'] }),
      'PROTECTED_PATH'
    );
  });

  it('allows an ordinary source file', () => {
    assert.doesNotThrow(() => resolveForMutation(ROOT, 'src/index.js', { platform: 'linux' }));
  });

  it('matches protected prefixes case-insensitively on Windows', () => {
    assert.strictEqual(matchProtectedPrefix('.GIT/config', undefined, 'win32'), '.git');
    assert.strictEqual(matchProtectedPrefix('.GIT/config', undefined, 'linux'), null);
  });

  it('does not treat a similarly-named sibling as protected', () => {
    assert.strictEqual(matchProtectedPrefix('.gitignore', undefined, 'linux'), null);
    assert.strictEqual(matchProtectedPrefix('.github/workflows/ci.yml', undefined, 'linux'), null);
  });
});

describe('pathGuard.assertRealPath', () => {
  /** @type {string} */
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-guard-'));
    fs.mkdirSync(path.join(tmp, 'workspace', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'workspace', 'src', 'app.js'), 'ok');
    fs.mkdirSync(path.join(tmp, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'outside', 'secret.txt'), 'top secret');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('accepts a real file inside the workspace', async () => {
    const root = path.join(tmp, 'workspace');
    const resolved = resolvePath(root, 'src/app.js');
    await assert.doesNotReject(() => assertRealPath(resolved));
  });

  it('accepts a file that does not exist yet by checking its parent', async () => {
    const root = path.join(tmp, 'workspace');
    const resolved = resolvePath(root, 'src/brand/new/file.js');
    await assert.doesNotReject(() => assertRealPath(resolved));
  });

  it('rejects a symlink escaping the workspace', async function () {
    const root = path.join(tmp, 'workspace');
    const linkPath = path.join(root, 'link.txt');
    try {
      fs.symlinkSync(path.join(tmp, 'outside', 'secret.txt'), linkPath);
    } catch (err) {
      // Windows needs elevation or developer mode for symlinks.
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') return this.skip();
      throw err;
    }

    // Lexically this path is spotless — only realpath resolution catches it.
    const resolved = resolvePath(root, 'link.txt');
    assert.strictEqual(resolved.relative, 'link.txt');
    await assert.rejects(
      () => assertRealPath(resolved),
      (err) => err instanceof PathGuardError && err.code === 'SYMLINK_ESCAPE'
    );
  });

  it('rejects a file created through a linked directory', async function () {
    const root = path.join(tmp, 'workspace');
    // Windows refuses unprivileged symlinks, but allows directory junctions — which
    // realpath resolves identically, so this case gets real coverage everywhere.
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'linked-dir'), linkType);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') return this.skip();
      throw err;
    }

    // The file doesn't exist, so the check falls back to its parent — which is the
    // symlink. This is the write-through-a-link case.
    const resolved = resolvePath(root, 'linked-dir/new-file.txt');
    await assert.rejects(
      () => assertRealPath(resolved),
      (err) => err instanceof PathGuardError && err.code === 'SYMLINK_ESCAPE'
    );
  });

  it('accepts a symlink that stays inside the workspace', async function () {
    const root = path.join(tmp, 'workspace');
    try {
      fs.symlinkSync(path.join(root, 'src', 'app.js'), path.join(root, 'alias.js'));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') return this.skip();
      throw err;
    }
    await assert.doesNotReject(() => assertRealPath(resolvePath(root, 'alias.js')));
  });
});

// The sync twin exists for `core/workspaceBootstrap`, which runs on a synchronous
// activation path. These tests exist to keep the two from drifting: a difference in
// verdict between them is the bug worth catching, so each case asserts both.
describe('pathGuard.assertRealPathSync', () => {
  /** @type {string} */
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-guard-sync-'));
    fs.mkdirSync(path.join(tmp, 'workspace', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'workspace', 'src', 'app.js'), 'ok');
    fs.mkdirSync(path.join(tmp, 'outside'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'outside', 'secret.txt'), 'top secret');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('accepts a real file inside the workspace, like its async twin', async () => {
    const root = path.join(tmp, 'workspace');
    assert.doesNotThrow(() => assertRealPathSync(resolvePath(root, 'src/app.js')));
    await assert.doesNotReject(() => assertRealPath(resolvePath(root, 'src/app.js')));
  });

  it('accepts a file that does not exist yet by checking its parent', async () => {
    const root = path.join(tmp, 'workspace');
    assert.doesNotThrow(() => assertRealPathSync(resolvePath(root, 'src/brand/new/file.js')));
    await assert.doesNotReject(() => assertRealPath(resolvePath(root, 'src/brand/new/file.js')));
  });

  it('rejects a .gitignore that is a symlink pointing outside the workspace', async function () {
    const root = path.join(tmp, 'workspace');
    try {
      fs.symlinkSync(path.join(tmp, 'outside', 'secret.txt'), path.join(root, '.gitignore'));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') return this.skip();
      throw err;
    }

    // This is the exact shape SAST-0.6.1 §2 described: lexically spotless, and only
    // realpath resolution sees that appending to it writes outside the workspace.
    const resolved = resolvePath(root, '.gitignore');
    assert.throws(
      () => assertRealPathSync(resolved),
      (err) => err instanceof PathGuardError && err.code === 'SYMLINK_ESCAPE'
    );
    await assert.rejects(
      () => assertRealPath(resolved),
      (err) => err instanceof PathGuardError && err.code === 'SYMLINK_ESCAPE'
    );
  });

  it('rejects a file created through a linked directory', async () => {
    const root = path.join(tmp, 'workspace');
    // Junctions work unprivileged on Windows and realpath resolves them identically,
    // so this case gets real coverage on every platform rather than skipping.
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, '.hirayacoder'), linkType);

    const resolved = resolvePath(root, '.hirayacoder/environment.json');
    assert.throws(
      () => assertRealPathSync(resolved),
      (err) => err instanceof PathGuardError && err.code === 'SYMLINK_ESCAPE'
    );
    await assert.rejects(
      () => assertRealPath(resolved),
      (err) => err instanceof PathGuardError && err.code === 'SYMLINK_ESCAPE'
    );
  });

  it('accepts a symlink that stays inside the workspace', function () {
    const root = path.join(tmp, 'workspace');
    try {
      fs.symlinkSync(path.join(root, 'src', 'app.js'), path.join(root, 'alias.js'));
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') return this.skip();
      throw err;
    }
    assert.doesNotThrow(() => assertRealPathSync(resolvePath(root, 'alias.js')));
  });
});
