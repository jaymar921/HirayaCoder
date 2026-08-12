'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AuditLog } = require('../../app/security/auditLog');

describe('AuditLog', () => {
  /** @type {string} */
  let root;
  /** @type {AuditLog} */
  let log;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-audit-'));
    log = new AuditLog(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('writes one JSON object per line under .hirayacoder/', async () => {
    await log.append({ action: 'write_file', decision: 'approved', path: 'src/app.js' });
    await log.flush();

    const raw = fs.readFileSync(path.join(root, '.hirayacoder', 'audit.log'), 'utf8');
    const lines = raw.trim().split('\n');
    assert.strictEqual(lines.length, 1);

    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.action, 'write_file');
    assert.strictEqual(entry.decision, 'approved');
    assert.strictEqual(entry.path, 'src/app.js');
    assert.ok(Date.parse(entry.ts), 'has a parseable timestamp');
  });

  it('creates the .hirayacoder directory on demand', async () => {
    await log.append({ action: 'read_file', decision: 'auto-approved' });
    await log.flush();
    assert.ok(fs.existsSync(path.join(root, '.hirayacoder')));
  });

  it('appends rather than overwriting', async () => {
    await log.append({ action: 'read_file', decision: 'auto-approved', path: 'a.js' });
    await log.append({ action: 'write_file', decision: 'approved', path: 'b.js' });
    await log.flush();
    assert.strictEqual((await log.read()).length, 2);
  });

  it('survives across instances, since the log outlives a session', async () => {
    await log.append({ action: 'read_file', decision: 'auto-approved' });
    await log.flush();

    const second = new AuditLog(root);
    await second.append({ action: 'write_file', decision: 'approved' });
    await second.flush();
    assert.strictEqual((await second.read()).length, 2);
  });

  it('never interleaves concurrent appends into corrupt JSON', async () => {
    // Several tools can act in one step; a torn line would break every later read.
    const writes = [];
    for (let i = 0; i < 60; i += 1) {
      writes.push(log.append({ action: 'write_file', decision: 'approved', path: `file-${i}.js` }));
    }
    await Promise.all(writes);
    await log.flush();

    const entries = await log.read(200);
    assert.strictEqual(entries.length, 60);
    const paths = new Set(entries.map((e) => e.path));
    assert.strictEqual(paths.size, 60, 'every entry landed intact');
  });

  it('redacts credentials out of logged commands', async () => {
    // Otherwise a token lands in plain text on disk and outlives the session.
    await log.append({
      action: 'run_script',
      decision: 'approved',
      command: `npm config set //registry.npmjs.org/:_authToken=npm_${'a'.repeat(36)}`,
    });
    await log.flush();

    const raw = fs.readFileSync(path.join(root, '.hirayacoder', 'audit.log'), 'utf8');
    assert.ok(!raw.includes('a'.repeat(36)), 'token must not reach disk');
    assert.ok(raw.includes('[REDACTED:NPM-TOKEN]'));
  });

  it('records the permission state in force at the time', async () => {
    await log.append({
      action: 'write_file',
      decision: 'auto-approved',
      path: 'a.js',
      permissions: { autoEdit: true, autoApproveScripts: false },
    });
    await log.flush();
    const [entry] = await log.read();
    assert.deepStrictEqual(entry.permissions, { autoEdit: true, autoApproveScripts: false });
  });

  it('bounds oversized fields instead of storing a whole file', async () => {
    await log.append({ action: 'write_file', decision: 'approved', reason: 'x'.repeat(50000) });
    await log.flush();
    const [entry] = await log.read();
    assert.ok(entry.reason.length < 3000);
    assert.match(entry.reason, /\[truncated\]$/);
  });

  it('skips corrupted lines on read instead of throwing', async () => {
    // The file is user-editable and treated as untrusted input.
    await log.append({ action: 'read_file', decision: 'auto-approved' });
    await log.flush();
    fs.appendFileSync(path.join(root, '.hirayacoder', 'audit.log'), 'not json at all\n{"partial":\n');
    await log.append({ action: 'write_file', decision: 'approved' });
    await log.flush();

    const entries = await log.read();
    assert.strictEqual(entries.length, 2);
  });

  it('returns an empty list when no log exists yet', async () => {
    assert.deepStrictEqual(await new AuditLog(root).read(), []);
  });

  it('honors the read limit, keeping the newest entries', async () => {
    for (let i = 0; i < 10; i += 1) {
      await log.append({ action: 'read_file', decision: 'auto-approved', path: `f${i}.js` });
    }
    await log.flush();
    const entries = await log.read(3);
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[2].path, 'f9.js');
  });

  it('rotates once the log grows past its cap', async () => {
    const small = new AuditLog(root, { maxBytes: 512 });
    for (let i = 0; i < 40; i += 1) {
      await small.append({ action: 'write_file', decision: 'approved', path: `file-${i}.js` });
    }
    await small.flush();
    assert.ok(fs.existsSync(path.join(root, '.hirayacoder', 'audit.log.1')), 'previous generation kept');
  });

  it('never lets a logging failure break the action being logged', async () => {
    // Point the log at a path that cannot be created.
    const broken = new AuditLog(path.join(root, 'src', 'app.js'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'not a directory');
    await assert.doesNotReject(() => broken.append({ action: 'write_file', decision: 'approved' }));
  });

  it('can be disabled', async () => {
    log.setEnabled(false);
    await log.append({ action: 'write_file', decision: 'approved' });
    await log.flush();
    assert.deepStrictEqual(await log.read(), []);
  });
});
