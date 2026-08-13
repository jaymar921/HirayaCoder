'use strict';

/**
 * The ledger's value is entirely in what it refuses to store and in it never being
 * able to break a session. Most of these assert one of those two things.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { OutcomeLedger, summarize, timings, emptyProfile } = require('../../app/core/outcomeLedger');

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

describe('OutcomeLedger timing and health', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-ledger-t-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('stores durations, which are numbers and so cost the privacy story nothing', async () => {
    const ledger = new OutcomeLedger(root);
    await ledger.recordSession({
      model: 'ornith:9b',
      tier: 'A',
      mode: 'agent',
      sessionId: '1',
      stopReason: 'done',
      steps: 4,
      changed: true,
      ms: 92000,
      modelMs: 88000,
    });
    await ledger.flush();

    const [record] = await ledger.read(10);
    assert.strictEqual(record.ms, 92000);
    assert.strictEqual(record.modelMs, 88000);
  });

  it('still refuses anything that is not on the allow-list', async () => {
    // The timing fields are an addition to the record shape, not an opening of it.
    const ledger = new OutcomeLedger(root);
    await ledger.recordSession({
      model: 'm',
      sessionId: '1',
      stopReason: 'done',
      steps: 1,
      changed: false,
      ms: 10,
      path: 'src/secret.js',
      command: 'curl http://evil',
      summary: 'the model said something',
    });
    await ledger.flush();

    const [record] = await ledger.read(10);
    assert.strictEqual(record.path, undefined);
    assert.strictEqual(record.command, undefined);
    assert.strictEqual(record.summary, undefined);
    assert.strictEqual(record.ms, 10);
  });

  it('keeps a fractional parameter count, since sub-1B is the interesting end', async () => {
    // `count()` truncates, which would have recorded every model this project exists
    // for as 0B and made the size comparison useless exactly where it matters.
    const ledger = new OutcomeLedger(root);
    await ledger.recordSession({ model: 'qwen3.5:0.5b', params: 0.5, sessionId: '1', stopReason: 'done', steps: 1, changed: false });
    await ledger.flush();

    const [record] = await ledger.read(10);
    assert.strictEqual(record.params, 0.5);
  });

  it('carries the parameter count onto the profile, so two models can be compared', () => {
    const profiles = summarize([
      { kind: 'session', model: 'a:1b', params: 1, stopReason: 'done', steps: 1 },
      { kind: 'step', model: 'a:1b', ok: true },
    ]);

    assert.strictEqual(profiles.get('a:1b').params, 1);
  });

  it('leaves the parameter count null when nothing reported one', () => {
    assert.strictEqual(summarize([{ kind: 'session', model: 'a', stopReason: 'done' }]).get('a').params, null);
  });

  it('writes a health transition with what it was before', async () => {
    const ledger = new OutcomeLedger(root);
    await ledger.recordHealth({ model: 'm', state: 'down', wasState: 'up', ms: 3000 });
    await ledger.flush();

    const [record] = await ledger.read(10);
    assert.strictEqual(record.kind, 'health');
    assert.strictEqual(record.state, 'down');
    assert.strictEqual(record.wasState, 'up');
  });

  it('averages over timed records only', () => {
    // Records written before timing existed carry no `ms`. Dividing by every session
    // would report the model as twice as fast as it is until they aged out.
    const profiles = summarize([
      { kind: 'session', model: 'm', ms: 100, modelMs: 90 },
      { kind: 'session', model: 'm', ms: 300, modelMs: 270 },
      { kind: 'session', model: 'm' },
    ]);
    const profile = profiles.get('m');

    assert.strictEqual(profile.sessions, 3);
    assert.strictEqual(profile.sessionsTimed, 2);
    assert.strictEqual(timings(profile).averageSessionMs, 200);
    assert.strictEqual(profile.slowestSessionMs, 300);
  });

  it('reports what share of the time went to the model', () => {
    const profiles = summarize([{ kind: 'session', model: 'm', ms: 1000, modelMs: 900 }]);
    assert.strictEqual(timings(profiles.get('m')).modelShare, 0.9);
  });

  it('reports no averages rather than zero when nothing was timed', () => {
    const t = timings(emptyProfile('m'));
    assert.strictEqual(t.averageSessionMs, null);
    assert.strictEqual(t.averageStepMs, null);
    assert.strictEqual(t.modelShare, null);
  });

  it('counts outages per state', () => {
    const profiles = summarize([
      { kind: 'health', model: 'm', state: 'down' },
      { kind: 'health', model: 'm', state: 'up' },
      { kind: 'health', model: 'm', state: 'down' },
    ]);

    assert.strictEqual(profiles.get('m').outages.get('down'), 2);
    assert.strictEqual(profiles.get('m').outages.get('up'), 1);
  });

  it('does not let a health record inflate the step or session counts', () => {
    const profiles = summarize([{ kind: 'health', model: 'm', state: 'down' }]);
    assert.strictEqual(profiles.get('m').steps, 0);
    assert.strictEqual(profiles.get('m').sessions, 0);
  });
});
