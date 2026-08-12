'use strict';

/**
 * The write_file guards. Both exist because a real model destroyed a real file in a
 * way the diff summary reported as an ordinary edit.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const writeFile = require('../../app/agent/tools/writeFile');
const { countCodeLines, COMMENT_PREFIXES, bracketsBalanced } = writeFile;
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');

const JS = COMMENT_PREFIXES.get('.js');

describe('writeFile guards', () => {
  describe('countCodeLines', () => {
    it('ignores blank lines and comments', () => {
      assert.strictEqual(countCodeLines('// a\n\n/* b */\nlet x = 1;\n', JS), 1);
    });

    it('counts a fully commented file as zero', () => {
      assert.strictEqual(countCodeLines('// let x = 1;\n// export {};\n', JS), 0);
    });

    it('does not treat a Markdown heading as a comment', () => {
      // `#` is a comment in Python and a heading in Markdown; a shared prefix set
      // would read every README as commented-out code.
      assert.strictEqual(COMMENT_PREFIXES.has('.md'), false);
    });

    it('does not treat a CSS id selector as a comment', () => {
      assert.strictEqual(countCodeLines('#main { color: red; }\n', COMMENT_PREFIXES.get('.css')), 1);
    });
  });

  describe('bracketsBalanced', () => {
    it('ignores brackets inside strings and comments', () => {
      assert.strictEqual(bracketsBalanced('const a = "{{{"; // }}}\n'), true);
      assert.strictEqual(bracketsBalanced('const a = `${x}`;\n'), true);
      assert.strictEqual(bracketsBalanced("const a = '\\'{';\n"), true);
      assert.strictEqual(bracketsBalanced('/* { */ let x = 1;\n'), true);
    });

    it('catches a file that stops part-way through', () => {
      assert.strictEqual(bracketsBalanced('function greet(name) {\n  return 1;\n'), false);
    });

    it('catches mismatched closers', () => {
      assert.strictEqual(bracketsBalanced('function a( ) }\n'), false);
    });
  });

  describe('as a tool', () => {
    /** @type {string} */
    let root;
    /** @type {object} */
    let context;

    beforeEach(() => {
      root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-write-')));
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(root, 'src', 'greet.js'),
        'function greet(name) {\n  return "Hello " + name;\n}\n\nmodule.exports = { greet };\n'
      );
      const modes = new PermissionModes({ initial: { autoEdit: true } });
      context = {
        gate: new PermissionGate({
          workspaceRoot: root,
          modes,
          auditLog: new AuditLog(root),
          confirm: async () => true,
        }),
        sessionId: '1',
        mode: 'agent',
      };
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

    const read = () => fs.readFileSync(path.join(root, 'src', 'greet.js'), 'utf8');

    it('refuses a file whose every line has been commented out', async () => {
      // Live failure on `qwen3.5:0.8b`, asked to add a guard clause: it returned the
      // whole module with `// ` in front of each line. The file GREW, so the
      // truncation guard could not see it, and the module stopped exporting anything.
      const before = read();
      const result = await writeFile(
        {
          path: 'src/greet.js',
          code:
            '// function greet(name) {\n' +
            "//   if (name === '') return 'Hello there';\n" +
            '//   return "Hello " + name;\n' +
            '// }\n' +
            '// module.exports = { greet };\n',
        },
        context
      );

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'FULLY_COMMENTED');
      assert.match(result.observation, /comments out the working code/);
      assert.strictEqual(read(), before, 'the file was modified despite the refusal');
    });

    it('refuses a partial comment-out that leaves one live line behind', async () => {
      // `qwen3.5:0.8b` walked straight past the first version of this guard by
      // commenting out the function and leaving `module.exports = { greet };` — the
      // file still parses and still exports, except `greet` is now undefined.
      const before = read();
      const result = await writeFile(
        {
          path: 'src/greet.js',
          code:
            '// function greet(name) {\n' +
            '//   return "Hello " + name;\n' +
            '// }\n\n' +
            'module.exports = { greet };\n',
        },
        context
      );

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'FULLY_COMMENTED');
      assert.strictEqual(read(), before);
    });

    it('allows a refactor that genuinely deletes most of a file', async () => {
      // Deleting code and commenting it out look alike by line count; only the
      // comment lines tell them apart. Blocking real deletions would be obstruction.
      fs.writeFileSync(
        path.join(root, 'src', 'big.js'),
        ['function a() {', '  return 1;', '}', 'function b() {', '  return 2;', '}', 'module.exports = { a, b };'].join('\n')
      );
      const result = await writeFile(
        { path: 'src/big.js', code: 'function a() {\n  return 1;\n}\nmodule.exports = { a };\n' },
        context
      );

      assert.strictEqual(result.ok, true, result.observation);
    });

    it('allows an edit that merely adds a comment', async () => {
      const result = await writeFile(
        {
          path: 'src/greet.js',
          code:
            '// Greets a person by name.\n' +
            'function greet(name) {\n' +
            "  if (name === '') return 'Hello there';\n" +
            '  return "Hello " + name;\n' +
            '}\n\nmodule.exports = { greet };\n',
        },
        context
      );

      assert.strictEqual(result.ok, true);
      assert.match(read(), /Hello there/);
    });

    it('allows a fully commented file when the original had no live code either', async () => {
      fs.writeFileSync(path.join(root, 'src', 'notes.js'), '// just notes\n// nothing here\n// at all\n');
      const result = await writeFile({ path: 'src/notes.js', code: '// rewritten notes\n' }, context);
      // Refused for shrinking, not for being commented — the point is that the
      // comment guard did not claim working code was destroyed.
      assert.notStrictEqual(result.error, 'FULLY_COMMENTED');
    });

    it('refuses a same-size write that stops mid-file', async () => {
      // Live failure on `llama3.2:1b`: 79 bytes replacing 80, correct logic, no
      // closing brace and no exports. The shrink ratio sees 99% and waves it through.
      const before = read();
      const result = await writeFile(
        {
          path: 'src/greet.js',
          code: "function greet(name) {\n  return name === '' ? 'Hello there' : `Hello ${name}!`;\n",
        },
        context
      );

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'SUSPICIOUS_TRUNCATION');
      assert.match(result.observation, /unclosed brackets/);
      assert.strictEqual(read(), before);
    });

    it('does not block an edit to a file that was already unbalanced', async () => {
      // A file this crude scan cannot read must not become permanently uneditable.
      fs.writeFileSync(path.join(root, 'src', 'odd.js'), 'const brace = "{";\nconst other = 1;\nmodule.exports = 1;\n');
      const result = await writeFile(
        { path: 'src/odd.js', code: 'const brace = "{";\nconst other = 2;\nmodule.exports = 2;\n' },
        context
      );
      assert.strictEqual(result.ok, true);
    });

    it('still refuses a truncated replacement', async () => {
      const result = await writeFile({ path: 'src/greet.js', code: '{' }, context);
      assert.strictEqual(result.error, 'SUSPICIOUS_TRUNCATION');
      assert.match(read(), /module\.exports/);
    });

    it('reports a missing code field rather than writing nothing', async () => {
      const result = await writeFile({ path: 'src/greet.js' }, context);
      assert.strictEqual(result.ok, false);
      assert.match(result.observation, /complete new file content/);
    });
  });
});
