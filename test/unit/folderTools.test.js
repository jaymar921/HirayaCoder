'use strict';

/**
 * `create_folder` and `delete_folder`, against a real temp workspace and a real
 * permission gate.
 *
 * The behaviour under test is mostly refusal, which is the point: before 0.4.0 a
 * folder could not be created except as a side effect of writing into it, and could
 * not be removed at all — `delete_file` refuses directories and the command redirect
 * sent `rmdir` to `delete_file`. A model that hit that dead end told the user the
 * folder had been deleted.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const createFolder = require('../../app/agent/tools/createFolder');
const deleteFolder = require('../../app/agent/tools/deleteFolder');
const deleteFile = require('../../app/agent/tools/deleteFile');
const { ChangeSet } = require('../../app/agent/agentSession');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');

describe('folder tools', () => {
  /** @type {string} */
  let root;
  /** @type {object[]} */
  let prompts;

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.autoEdit]
   * @param {boolean} [opts.answer] What the fake user clicks.
   * @param {boolean} [opts.alwaysConfirmDeletes]
   */
  function makeContext(opts = {}) {
    const modes = new PermissionModes({
      initial: { autoEdit: opts.autoEdit !== false, autoApproveScripts: false },
    });
    prompts = [];
    const gate = new PermissionGate({
      workspaceRoot: root,
      modes,
      confirm: async (request) => {
        prompts.push(request);
        return opts.answer !== false;
      },
      alwaysConfirmDeletes: opts.alwaysConfirmDeletes,
    });
    return { workspaceRoot: root, gate, mode: 'agent', sessionId: '1', changeSet: new ChangeSet() };
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-folder-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe('create_folder', () => {
    it('creates a nested folder that does not exist', async () => {
      const context = makeContext();
      const result = await createFolder({ path: 'src/main/java' }, context);

      assert.strictEqual(result.ok, true);
      assert.ok(fs.statSync(path.join(root, 'src', 'main', 'java')).isDirectory());
      assert.strictEqual(context.changeSet.list()[0].path, 'src/main/java/');
    });

    it('treats an existing folder as success without prompting', async () => {
      fs.mkdirSync(path.join(root, 'build'));
      const context = makeContext({ autoEdit: false });

      const result = await createFolder({ path: 'build' }, context);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.detail.unchanged, true);
      assert.strictEqual(prompts.length, 0, 'an existing folder costs no confirmation');
    });

    it('refuses when a file already occupies the path', async () => {
      fs.writeFileSync(path.join(root, 'build'), 'not a folder');
      const result = await createFolder({ path: 'build' }, makeContext());

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'NOT_A_DIRECTORY');
      assert.strictEqual(fs.readFileSync(path.join(root, 'build'), 'utf8'), 'not a folder');
    });

    it('is refused outside the workspace', async () => {
      const result = await createFolder({ path: '../escaped' }, makeContext());

      assert.strictEqual(result.ok, false);
      assert.ok(!fs.existsSync(path.join(root, '..', 'escaped')));
    });

    it('is refused inside a protected directory', async () => {
      const result = await createFolder({ path: '.git/hooks/extra' }, makeContext());

      assert.strictEqual(result.ok, false);
      assert.ok(!fs.existsSync(path.join(root, '.git', 'hooks', 'extra')));
    });
  });

  describe('delete_folder', () => {
    it('removes an empty folder', async () => {
      fs.mkdirSync(path.join(root, 'src', 'main', 'java'), { recursive: true });
      const context = makeContext();

      const result = await deleteFolder({ path: 'src/main/java' }, context);

      assert.strictEqual(result.ok, true);
      assert.ok(!fs.existsSync(path.join(root, 'src', 'main', 'java')));
      assert.ok(fs.existsSync(path.join(root, 'src', 'main')), 'only the named folder goes');
    });

    it('refuses a non-empty folder unless recursive is set, and says what would work', async () => {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'app.js'), 'x');
      const context = makeContext();

      const result = await deleteFolder({ path: 'src' }, context);

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'FOLDER_NOT_EMPTY');
      assert.match(result.observation, /recursive/);
      assert.ok(fs.existsSync(path.join(root, 'src', 'app.js')));
      assert.strictEqual(prompts.length, 0, 'refused before anyone is asked to confirm');
    });

    it('removes a non-empty folder when recursive is set', async () => {
      fs.mkdirSync(path.join(root, 'old', 'nested'), { recursive: true });
      fs.writeFileSync(path.join(root, 'old', 'a.js'), 'a');
      fs.writeFileSync(path.join(root, 'old', 'nested', 'b.js'), 'b');
      const context = makeContext();

      const result = await deleteFolder({ path: 'old', recursive: true }, context);

      assert.strictEqual(result.ok, true);
      assert.ok(!fs.existsSync(path.join(root, 'old')));
      assert.strictEqual(context.changeSet.list()[0].path, 'old/');
    });

    it('always confirms, even under Auto Edit with delete confirmation disabled', async () => {
      // Both settings that could waive a prompt are turned off here. Neither governs a
      // recursive delete: nothing can restore the subtree afterwards.
      fs.mkdirSync(path.join(root, 'old'));
      const context = makeContext({ autoEdit: true, alwaysConfirmDeletes: false });

      await deleteFolder({ path: 'old' }, context);

      assert.strictEqual(prompts.length, 1);
      assert.strictEqual(prompts[0].kind, 'delete');
      assert.strictEqual(prompts[0].risk, 'elevated');
    });

    it('leaves the folder alone when the user declines', async () => {
      fs.mkdirSync(path.join(root, 'old'));
      const result = await deleteFolder({ path: 'old' }, makeContext({ answer: false }));

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'USER_DENIED');
      assert.ok(fs.existsSync(path.join(root, 'old')));
    });

    it('tells the user to do it themselves past the size ceiling', async () => {
      const big = path.join(root, 'huge');
      fs.mkdirSync(big);
      for (let i = 0; i <= deleteFolder.MAX_RECURSIVE_ENTRIES + 5; i += 1) {
        fs.writeFileSync(path.join(big, `f${i}.txt`), 'x');
      }

      const result = await deleteFolder({ path: 'huge', recursive: true }, makeContext());

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'FOLDER_TOO_LARGE');
      assert.ok(fs.existsSync(path.join(big, 'f1.txt')));
      assert.strictEqual(prompts.length, 0, 'never even offered as a click');
    });

    it('refuses a file', async () => {
      fs.writeFileSync(path.join(root, 'app.js'), 'x');
      const result = await deleteFolder({ path: 'app.js' }, makeContext());

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'NOT_A_DIRECTORY');
      assert.ok(fs.existsSync(path.join(root, 'app.js')));
    });

    it('is a no-op success for a folder that is already gone', async () => {
      const result = await deleteFolder({ path: 'never-existed' }, makeContext());

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.detail.unchanged, true);
    });

    it('is refused inside a protected directory', async () => {
      fs.mkdirSync(path.join(root, '.hirayacoder', 'memory'), { recursive: true });
      const result = await deleteFolder({ path: '.hirayacoder/memory' }, makeContext());

      assert.strictEqual(result.ok, false);
      assert.ok(fs.existsSync(path.join(root, '.hirayacoder', 'memory')));
    });
  });

  describe('delete_file on a folder', () => {
    it('names the tool that does the job instead of stopping at a refusal', async () => {
      fs.mkdirSync(path.join(root, 'src'));
      const result = await deleteFile({ path: 'src' }, makeContext());

      assert.strictEqual(result.ok, false);
      assert.match(result.observation, /delete_folder/);
      assert.ok(fs.existsSync(path.join(root, 'src')));
    });
  });
});
