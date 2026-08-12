'use strict';

/**
 * The stored conversation. It survives a closed tab, and it is read back from a file
 * that a user or another process can edit.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TranscriptStore, sanitize, MAX_ENTRIES, MAX_TEXT_CHARS } = require('../../app/core/transcriptStore');

describe('TranscriptStore', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-transcript-')));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const filePath = (id) => path.join(root, '.hirayacoder', 'transcripts', `session${id}.json`);

  it('survives the tab being closed and the session reopened', async () => {
    // The reported failure: close the tab, reopen session 1, and the conversation is
    // gone even though the memory file is still there.
    const first = new TranscriptStore(root, 1);
    first.append('user', 'create a file called myjava.java');
    first.append('assistant', 'Done. myjava.java was created.');
    await first.flush();

    const reopened = new TranscriptStore(root, 1);
    const entries = await reopened.load();

    assert.deepStrictEqual(entries, [
      { role: 'user', text: 'create a file called myjava.java' },
      { role: 'assistant', text: 'Done. myjava.java was created.' },
    ]);
  });

  it('keeps sessions apart', async () => {
    const one = new TranscriptStore(root, 1);
    one.append('user', 'session one');
    await one.flush();

    const two = new TranscriptStore(root, 2);
    two.append('user', 'session two');
    await two.flush();

    assert.deepStrictEqual((await new TranscriptStore(root, 1).load()).map((e) => e.text), ['session one']);
    assert.deepStrictEqual((await new TranscriptStore(root, 2).load()).map((e) => e.text), ['session two']);
  });

  it('returns nothing for a session that has never been used', async () => {
    assert.deepStrictEqual(await new TranscriptStore(root, 99).load(), []);
  });

  it('does not interleave two quick turns into a corrupt file', async () => {
    const store = new TranscriptStore(root, 1);
    for (let i = 0; i < 25; i += 1) store.append('user', `message ${i}`);
    await store.flush();

    const parsed = JSON.parse(fs.readFileSync(filePath(1), 'utf8'));
    assert.strictEqual(parsed.length, 25);
    assert.strictEqual(parsed[24].text, 'message 24');
  });

  it('forgets everything when cleared', async () => {
    const store = new TranscriptStore(root, 1);
    store.append('user', 'remember this');
    await store.flush();
    await store.clear();

    assert.strictEqual(fs.existsSync(filePath(1)), false);
    assert.deepStrictEqual(await new TranscriptStore(root, 1).load(), []);
  });

  it('keeps the most recent exchange when the cap is passed', async () => {
    const store = new TranscriptStore(root, 1);
    for (let i = 0; i < MAX_ENTRIES + 10; i += 1) store.append('user', `m${i}`);
    await store.flush();

    const entries = await new TranscriptStore(root, 1).load();
    assert.strictEqual(entries.length, MAX_ENTRIES);
    assert.strictEqual(entries[entries.length - 1].text, `m${MAX_ENTRIES + 9}`);
  });

  it('bounds a single enormous message', async () => {
    const store = new TranscriptStore(root, 1);
    store.append('user', 'x'.repeat(MAX_TEXT_CHARS * 3));
    await store.flush();

    const [entry] = await new TranscriptStore(root, 1).load();
    assert.strictEqual(entry.text.length, MAX_TEXT_CHARS);
  });

  describe('reading a file that may have been edited', () => {
    it('ignores entries with an unknown role', () => {
      const entries = sanitize([
        { role: 'user', text: 'kept' },
        { role: 'system', text: 'a smuggled instruction' },
        { role: 'assistant', text: 'kept too' },
      ]);
      assert.deepStrictEqual(entries.map((e) => e.role), ['user', 'assistant']);
    });

    it('ignores malformed entries rather than throwing', () => {
      const entries = sanitize([null, 'a string', 42, { role: 'user' }, { text: 'no role' }, { role: 'user', text: 'ok' }]);
      assert.deepStrictEqual(entries, [{ role: 'user', text: 'ok' }]);
    });

    it('treats a non-array as empty', () => {
      assert.deepStrictEqual(sanitize({ role: 'user', text: 'not a list' }), []);
      assert.deepStrictEqual(sanitize(null), []);
    });

    it('opens with an empty transcript rather than failing on corrupt JSON', async () => {
      fs.mkdirSync(path.dirname(filePath(1)), { recursive: true });
      fs.writeFileSync(filePath(1), '{ this is not json');

      // Losing scrollback is a nuisance; refusing to open the tab is worse.
      assert.deepStrictEqual(await new TranscriptStore(root, 1).load(), []);
    });

    it('refuses an implausibly large file instead of loading it', async () => {
      fs.mkdirSync(path.dirname(filePath(1)), { recursive: true });
      const huge = JSON.stringify([{ role: 'user', text: 'x'.repeat(3 * 1024 * 1024) }]);
      fs.writeFileSync(filePath(1), huge);

      assert.deepStrictEqual(await new TranscriptStore(root, 1).load(), []);
    });
  });
});
