'use strict';

/**
 * edit_file: change part of a file without retyping the rest. The guarantees worth
 * pinning are the ones that keep it as safe as write_file: it lands where it says or not
 * at all, and it reaches the disk only through write_file and the gate.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const editFile = require('../../app/agent/tools/editFile');
const { locate, reindent, closestLines } = editFile;
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');
const { parseAction, actionSchema } = require('../../app/core/outputParser');
const toolRegistry = require('../../app/agent/toolRegistry');
const { actionKey, nextStepHint, recoveryHint } = require('../../app/agent/reactLoop');
const { CART_JS } = require('../../tools/lib/cartFixture');

describe('edit_file', () => {
  describe('locate', () => {
    it('finds an exact match', () => {
      const found = locate('a\nconst X = 1;\nb\n', 'const X = 1;');
      assert.ok(found.ok);
      assert.strictEqual(found.at.how, 'exact');
      assert.strictEqual(found.at.start, 2);
    });

    it('matches whole lines when only the indentation is wrong', () => {
      // Small models copy a line's words faithfully and its indentation carelessly.
      const text = 'function f() {\n    if (x) {\n        return 1;\n    }\n}\n';
      const found = locate(text, 'if (x) {\n  return 1;\n}');
      assert.ok(found.ok);
      assert.strictEqual(found.at.how, 'loose');
      assert.strictEqual(text.slice(found.at.start, found.at.end), '    if (x) {\n        return 1;\n    }');
    });

    it('refuses text that appears more than once, and says where', () => {
      const found = locate('x = 1;\ny = 2;\nx = 1;\n', 'x = 1;');
      assert.strictEqual(found.ok, false);
      assert.strictEqual(found.reason, 'many');
      assert.deepStrictEqual(found.lines, [1, 3]);
    });

    it('does not match a near miss', () => {
      assert.strictEqual(locate('const TAX_RATE = 0.08;\n', 'const TAX = 0.08;').ok, false);
    });
  });

  it('re-indents a replacement to the depth it landed at', () => {
    assert.strictEqual(reindent('if (x) {\n  y();\n}', '', '    '), '    if (x) {\n      y();\n    }');
    assert.strictEqual(reindent('  a\n  b', '  ', '\t'), '\ta\n\tb');
  });

  it('shows the closest lines, numbered, when nothing matched', () => {
    const shown = closestLines(CART_JS, 'const TAX = 0.08;');
    assert.match(shown, /const TAX_RATE = 0\.08;/);
    assert.match(shown, /^\s*\d+ \| /m);
    assert.strictEqual(closestLines(CART_JS, 'zzz qqq'), '');
  });

  describe('as a tool', () => {
    /** @type {string} */
    let root;
    /** @type {object} */
    let context;
    /** @type {object[]} */
    let asked;

    const file = () => fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8');
    const setup = (autoEdit, answer = true) => {
      asked = [];
      context = {
        gate: new PermissionGate({
          workspaceRoot: root,
          modes: new PermissionModes({ initial: { autoEdit } }),
          auditLog: new AuditLog(root),
          confirm: async (request) => {
            asked.push(request);
            return answer;
          },
        }),
        sessionId: '1',
        mode: 'agent',
        workspaceRoot: root,
      };
    };

    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-edit-')));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'cart.js'), CART_JS);
      setup(true);
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

    it('changes the one line and leaves every other line as it was', async () => {
      const result = await editFile(
        { path: 'src/cart.js', find: 'const TAX_RATE = 0.08;', replace: 'const TAX_RATE = 0.1;' },
        context
      );
      assert.strictEqual(result.ok, true, result.observation);
      assert.strictEqual(file(), CART_JS.replace('0.08', '0.1'));
      assert.match(result.observation, /line 8/);
      assert.strictEqual(result.detail.shapeChange, '"const TAX_RATE = 0.08;" became "const TAX_RATE = 0.1;"');
    });

    it('keeps CRLF line endings', async () => {
      fs.writeFileSync(path.join(root, 'src', 'cart.js'), CART_JS.replace(/\n/g, '\r\n'));
      const result = await editFile(
        { path: 'src/cart.js', find: 'const MAX_QUANTITY = 99;', replace: 'const MAX_QUANTITY = 50;' },
        context
      );
      assert.strictEqual(result.ok, true, result.observation);
      assert.strictEqual(file(), CART_JS.replace('99;', '50;').replace(/\n/g, '\r\n'));
    });

    it('goes through the permission gate like any write', async () => {
      setup(false, false);
      const result = await editFile(
        { path: 'src/cart.js', find: 'const TAX_RATE = 0.08;', replace: 'const TAX_RATE = 0.1;' },
        context
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(asked.length, 1, 'the user was not asked');
      assert.ok(asked[0].after.includes('0.1'), 'the confirmation did not carry the edited file');
      assert.strictEqual(file(), CART_JS, 'the file changed despite a refusal');
    });

    it('refuses an edit that would break the file, in words about the edit', async () => {
      const result = await editFile(
        { path: 'src/cart.js', find: 'function createCart() {', replace: 'function createCart() {{' },
        context
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'SUSPICIOUS_TRUNCATION');
      assert.match(result.observation, /edit .* was not applied: the file would be left with unclosed brackets/);
      assert.doesNotMatch(result.observation, /COMPLETE/, 'it was told to resend the whole file');
      assert.strictEqual(file(), CART_JS);
    });

    it('says where the closest text is when the find does not match', async () => {
      const result = await editFile({ path: 'src/cart.js', find: 'const TAX = 0.08;', replace: 'const TAX = 0.1;' }, context);
      assert.strictEqual(result.error, 'EDIT_NOT_FOUND');
      assert.match(result.observation, /closest lines/);
      assert.match(result.observation, /TAX_RATE/);
    });

    it('redacts a secret in the closest lines, as read_file would', async () => {
      const key = 'sk-proj-Q7vR2mX9kL4pT8wN3bY6cH1dF5gJ0aZs';
      fs.writeFileSync(path.join(root, 'src', 'cart.js'), CART_JS.replace('const TAX_RATE = 0.08;', `const TAX_RATE = 0.08;\nconst TAX_API_KEY = '${key}';`));
      const result = await editFile({ path: 'src/cart.js', find: 'const TAX_API = 1;', replace: 'const TAX_API = 2;' }, context);
      assert.strictEqual(result.error, 'EDIT_NOT_FOUND');
      assert.match(result.observation, /TAX_API_KEY = '\[REDACTED/);
      assert.doesNotMatch(result.observation, new RegExp(key));
    });

    it('refuses an ambiguous find', async () => {
      const result = await editFile({ path: 'src/cart.js', find: 'return { ...cart, items };', replace: 'return cart;' }, context);
      assert.strictEqual(result.error, 'EDIT_AMBIGUOUS');
      assert.strictEqual(file(), CART_JS);
    });

    it('refuses an edit that changes nothing, and one with no find', async () => {
      assert.strictEqual(
        (await editFile({ path: 'src/cart.js', find: 'const TAX_RATE = 0.08;', replace: 'const TAX_RATE = 0.08; ' }, context)).error,
        'EDIT_NO_CHANGE'
      );
      assert.strictEqual((await editFile({ path: 'src/cart.js', find: '  ', replace: 'x' }, context)).error, 'MISSING_FIND');
    });

    it('points at write_file for a file that does not exist', async () => {
      const result = await editFile({ path: 'src/nope.js', find: 'a', replace: 'b' }, context);
      assert.strictEqual(result.error, 'ENOENT');
      assert.match(result.observation, /write_file/);
    });

    it('refuses a path outside the workspace', async () => {
      const result = await editFile({ path: '../outside.js', find: 'a', replace: 'b' }, context);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'OUTSIDE_WORKSPACE');
    });
  });

  describe('in the protocol', () => {
    it('parses with find, replace, and an empty replace kept as a deletion', () => {
      const parsed = parseAction(
        JSON.stringify({ thought: 't', action: 'edit_file', path: 'src/a.js', find: '  x();\n', replace: '' })
      );
      assert.ok(parsed.ok, parsed.error);
      assert.strictEqual(parsed.action.find, '  x();\n', 'the whitespace in find was not kept');
      assert.strictEqual(parsed.action.replace, '');
    });

    it('says exactly what is missing', () => {
      const parsed = parseAction(JSON.stringify({ action: 'edit_file', path: 'src/a.js', find: 'x' }));
      assert.strictEqual(parsed.ok, false);
      assert.match(parsed.error, /missing: replace/);
      assert.match(recoveryHint(parsed.error), /"find".*"replace"/);
    });

    it('is offered in Agent mode, and absent from Plan mode and its schema', () => {
      assert.ok(toolRegistry.actionsForMode('agent').has('edit_file'));
      assert.ok(!toolRegistry.actionsForMode('plan').has('edit_file'));
      const branches = actionSchema(toolRegistry.actionsForMode('agent')).anyOf;
      const edit = branches.find((branch) => branch.properties.action.const === 'edit_file');
      assert.deepStrictEqual(edit.required, ['thought', 'action', 'path', 'find', 'replace']);
    });

    it('is listed before write_file, so a small model meets it first', () => {
      const names = toolRegistry.forMode('agent').map((tool) => tool.name);
      assert.ok(names.indexOf('edit_file') < names.indexOf('write_file'));
    });

    it('does not count two different edits to one file as a repeat', () => {
      const first = { action: 'edit_file', path: 'src/a.js', find: 'a', replace: 'b' };
      const second = { action: 'edit_file', path: 'src/a.js', find: 'c', replace: 'd' };
      assert.notStrictEqual(actionKey(first), actionKey(second));
      assert.strictEqual(actionKey(first), actionKey({ ...first, replace: 'zzz' }));
    });

    it('answers a missed edit by pointing at the result, not by banning the file', () => {
      const route = { allowedActions: new Set(['read_file', 'edit_file', 'write_file', 'done']) };
      const hint = nextStepHint(
        { action: 'edit_file', path: 'src/a.js' },
        { ok: false, error: 'EDIT_NOT_FOUND', observation: '' },
        1,
        route
      );
      assert.match(hint, /send edit_file again/);
      assert.doesNotMatch(hint, /Do NOT try/);
    });

    it('steers a read towards an edit when one is available', () => {
      const route = { allowedActions: new Set(['read_file', 'edit_file', 'write_file', 'done']) };
      const hint = nextStepHint({ action: 'read_file', path: 'src/a.js' }, { ok: true, observation: '' }, 1, route);
      assert.match(hint, /edit_file/);
      assert.doesNotMatch(hint, /complete updated file/);
    });
  });
});
