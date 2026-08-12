'use strict';

/**
 * The ledger's value is entirely in what it refuses to store and in it never being
 * able to break a session. Most of these assert one of those two things.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OutcomeLedger, summarize, emptyProfile } = require('../../app/core/outcomeLedger');

/** @param {object} [over] */
function step(over = {}) {
  return {
    model: 'llama3.2:1b',
    tier: 'B',
    thinking: 'medium',
    mode: 'agent',
    sessionId: '1',
    action: 'write_file',
    ok: true,
    ...over,
  };
}

describe('OutcomeLedger', () => {
  /** @type {string} */
  let root;
  /** @type {OutcomeLedger} */
  let ledger;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-ledger-'));
    ledger = new OutcomeLedger(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const file = () => path.join(root, '.hirayacoder', 'outcomes.jsonl');

  it('writes one JSON object per line at .hirayacoder/outcomes.jsonl', async () => {
    await ledger.recordStep(step({ ok: false, code: 'EXPORTS_REMOVED' }));
    await ledger.flush();

    const lines = fs.readFileSync(file(), 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 1);

    const record = JSON.parse(lines[0]);
    assert.strictEqual(record.kind, 'step');
    assert.strictEqual(record.model, 'llama3.2:1b');
    assert.strictEqual(record.code, 'EXPORTS_REMOVED');
    assert.strictEqual(record.ok, false);
    assert.ok(Date.parse(record.ts), 'has a parseable timestamp');
  });

  it('stores no workspace content, whatever a caller passes', async () => {
    // The whole privacy argument for this file is that it holds counts, not context.
    // A caller that grows a new field must not be able to start writing paths,
    // commands, or file contents into it by accident.
    await ledger.recordStep(
      /** @type {any} */ ({
        ...step(),
        path: 'src/secrets/config.js',
        command: 'npm publish --token abc',
        summary: 'I rewrote the auth module',
        code: 'MISSING_CONTENT',
      })
    );
    await ledger.flush();

    const raw = fs.readFileSync(file(), 'utf8');
    assert.ok(!raw.includes('src/secrets'), 'no path reached disk');
    assert.ok(!raw.includes('npm publish'), 'no command reached disk');
    assert.ok(!raw.includes('auth module'), 'no model prose reached disk');
    // `code` is a guard error code and is kept — it is the field the whole file exists for.
    assert.strictEqual(JSON.parse(raw.trim()).code, 'MISSING_CONTENT');
  });

  it('omits absent fields rather than writing nulls', async () => {
    await ledger.recordStep(step({ ok: true }));
    await ledger.flush();
    const record = JSON.parse(fs.readFileSync(file(), 'utf8').trim());
    assert.ok(!('code' in record), 'a successful step has no error code');
    assert.ok(!('decision' in record), 'nothing decided it');
  });

  it('bounds an oversized value instead of storing it whole', async () => {
    await ledger.recordStep(step({ code: 'X'.repeat(5000) }));
    await ledger.flush();
    const record = JSON.parse(fs.readFileSync(file(), 'utf8').trim());
    assert.ok(record.code.length < 200);
    assert.match(record.code, /\[truncated\]$/);
  });

  it('never interleaves concurrent records into corrupt JSON', async () => {
    // Several steps can land at once across two open chat tabs.
    const writes = [];
    for (let i = 0; i < 60; i += 1) writes.push(ledger.recordStep(step({ sessionId: String(i) })));
    await Promise.all(writes);
    await ledger.flush();

    const records = await ledger.read(200);
    assert.strictEqual(records.length, 60);
    assert.strictEqual(new Set(records.map((r) => r.sessionId)).size, 60);
  });

  it('skips corrupted lines instead of throwing, since the file is user-editable', async () => {
    await ledger.recordStep(step());
    await ledger.flush();
    fs.appendFileSync(file(), 'not json\n{"kind": "step",\n');
    await ledger.recordStep(step());
    await ledger.flush();

    assert.strictEqual((await ledger.read()).length, 2);
  });

  it('reports an empty profile for a model with no history', async () => {
    const profile = await ledger.profileFor('qwen3.5:2b');
    assert.strictEqual(profile.steps, 0);
    assert.strictEqual(profile.trips.size, 0);
  });

  it('never lets a ledger failure break the session it was recording', async () => {
    // Point the ledger at a path that cannot be created.
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'not a directory');
    const broken = new OutcomeLedger(path.join(root, 'src', 'app.js'));
    await assert.doesNotReject(() => broken.recordStep(step()));
  });

  it('returns an empty profile map rather than throwing when the file cannot be read', async () => {
    const unreadable = new OutcomeLedger(root);
    unreadable.read = async () => {
      throw new Error('EIO');
    };
    assert.strictEqual((await unreadable.profiles()).size, 0);
  });

  it('clears everything, including the rotated generation', async () => {
    // A learned setting that makes things worse must be as easy to discard as it was
    // to acquire.
    await ledger.recordStep(step());
    await ledger.flush();
    fs.writeFileSync(`${file()}.1`, '{"kind":"step","model":"old"}\n');

    await ledger.clear();

    assert.ok(!fs.existsSync(file()));
    assert.ok(!fs.existsSync(`${file()}.1`));
    assert.deepStrictEqual(await ledger.read(), []);
  });

  it('clears cleanly when there is nothing to clear', async () => {
    await assert.doesNotReject(() => ledger.clear());
  });

  it('rotates once it grows past its cap', async () => {
    const small = new OutcomeLedger(root, { maxBytes: 512 });
    for (let i = 0; i < 40; i += 1) await small.recordStep(step({ sessionId: String(i) }));
    await small.flush();
    assert.ok(fs.existsSync(`${file()}.1`), 'previous generation kept');
  });
});

describe('outcomeLedger.summarize', () => {
  it('counts guard trips per model, not across models', () => {
    const profiles = summarize([
      { kind: 'step', model: 'a', ok: false, code: 'EXPORTS_REMOVED' },
      { kind: 'step', model: 'a', ok: false, code: 'EXPORTS_REMOVED' },
      { kind: 'step', model: 'b', ok: false, code: 'EXPORTS_REMOVED' },
      { kind: 'step', model: 'a', ok: true },
    ]);

    assert.strictEqual(profiles.get('a').trips.get('EXPORTS_REMOVED'), 2);
    assert.strictEqual(profiles.get('b').trips.get('EXPORTS_REMOVED'), 1);
    assert.strictEqual(profiles.get('a').steps, 3);
    assert.strictEqual(profiles.get('a').failures, 2);
  });

  it('counts stop reasons and whether a session changed anything', () => {
    const profiles = summarize([
      { kind: 'session', model: 'a', stopReason: 'repeating', steps: 4, changed: false },
      { kind: 'session', model: 'a', stopReason: 'repeating', steps: 6, changed: true },
      { kind: 'session', model: 'a', stopReason: 'done', steps: 3, changed: true },
    ]);

    const profile = profiles.get('a');
    assert.strictEqual(profile.sessions, 3);
    assert.strictEqual(profile.stops.get('repeating'), 2);
    assert.strictEqual(profile.stops.get('done'), 1);
    assert.strictEqual(profile.sessionsThatChanged, 2);
  });

  it('counts a declined action without counting it as a guard trip', () => {
    // A refusal by the user is a decision, not a mistake the model can be corrected
    // out of. It is worth showing the user; it must not become evidence for a hint.
    const profile = summarize([
      { kind: 'step', model: 'a', ok: false, code: 'USER_DENIED', decision: 'declined' },
    ]).get('a');

    assert.strictEqual(profile.declined, 1);
    assert.strictEqual(profile.trips.get('USER_DENIED'), 1, 'still visible in the profile');
  });

  it('ignores records it does not understand rather than guessing', () => {
    // The file outlives any one version of the extension.
    const profiles = summarize([
      null,
      'nonsense',
      { kind: 'step' },
      { kind: 'future-kind', model: 'a' },
      { model: 'a' },
      { kind: 'step', model: 'a', ok: true },
    ]);

    assert.strictEqual(profiles.size, 1);
    assert.strictEqual(profiles.get('a').steps, 1);
  });

  it('cannot be tricked into returning a prototype member as a profile', () => {
    const profiles = summarize([{ kind: 'step', model: 'constructor', ok: true }]);
    assert.strictEqual(profiles.get('constructor').steps, 1);
    assert.strictEqual(profiles.get('toString'), undefined);
  });

  it('starts every counter at zero', () => {
    const profile = emptyProfile('a');
    assert.strictEqual(profile.steps, 0);
    assert.strictEqual(profile.sessions, 0);
    assert.strictEqual(profile.declined, 0);
  });
});
