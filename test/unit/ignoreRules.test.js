'use strict';

/**
 * `api/.env` was read twice, and the audit log records both as `"auto-approved"`, in a
 * project whose `.gitignore` begins `*.env`. These are the assertions that says it
 * cannot happen silently again.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IgnoreRules, globToRegExpSource, normalize } = require('../../app/security/ignoreRules');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');

/** @type {string} */
let root;

/** @param {string} content */
function writeGitignore(content) {
  fs.writeFileSync(path.join(root, '.gitignore'), content, 'utf8');
}

describe('ignoreRules.classify', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-ignore-')));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('flags a .env even with no .gitignore at all', () => {
    // The backstop. A folder that is not a git repository still has secrets in it.
    const rules = new IgnoreRules(root);
    assert.strictEqual(rules.classify('api/.env').sensitive, true);
    assert.strictEqual(rules.classify('api/.env').because, 'always');
  });

  it('flags the loco-menu case exactly', () => {
    writeGitignore('*.env\n\n*/node_modules\n');
    const rules = new IgnoreRules(root);
    assert.strictEqual(rules.classify('api/.env').sensitive, true);
  });

  it('leaves ordinary source alone', () => {
    writeGitignore('*.env\n*/node_modules\n');
    const rules = new IgnoreRules(root);
    for (const file of ['api/server.js', 'README.md', 'app/src/main.jsx', 'api/package.json']) {
      assert.strictEqual(rules.classify(file).sensitive, false, `${file} should not need asking about`);
    }
  });

  it('does not ask about a .env.example', () => {
    // Committed on purpose, holds placeholders, and is the single most useful file for
    // "what does this project need to run". Asking is pure friction.
    const rules = new IgnoreRules(root);
    for (const file of ['.env.example', 'api/.env.sample', 'config.example']) {
      assert.strictEqual(rules.classify(file).sensitive, false, `${file} should be readable`);
    }
  });

  it('flags private keys and registry credentials by name', () => {
    const rules = new IgnoreRules(root);
    for (const file of ['certs/server.pem', 'id_rsa', '.npmrc', 'keys/app.p12', 'service-account-prod.json']) {
      assert.strictEqual(rules.classify(file).sensitive, true, `${file} should need asking about`);
    }
  });

  it('honours a negation, because git does', () => {
    writeGitignore('secrets/*\n!secrets/README.md\n');
    const rules = new IgnoreRules(root);
    assert.strictEqual(rules.classify('secrets/token.txt').sensitive, true);
    assert.strictEqual(rules.classify('secrets/README.md').sensitive, false);
  });

  it('anchors a rule that starts with a slash', () => {
    writeGitignore('/build\n');
    const rules = new IgnoreRules(root);
    assert.strictEqual(rules.classify('build/out.js').sensitive, true);
    assert.strictEqual(rules.classify('src/build/out.js').sensitive, false);
  });

  it('matches an unanchored name at any depth', () => {
    writeGitignore('coverage\n');
    const rules = new IgnoreRules(root);
    assert.strictEqual(rules.classify('coverage/index.html').sensitive, true);
    assert.strictEqual(rules.classify('packages/api/coverage/index.html').sensitive, true);
  });

  it('handles ** across directories', () => {
    writeGitignore('**/generated/*.ts\n');
    const rules = new IgnoreRules(root);
    assert.strictEqual(rules.classify('generated/api.ts').sensitive, true);
    assert.strictEqual(rules.classify('src/deep/generated/api.ts').sensitive, true);
    assert.strictEqual(rules.classify('src/hand-written.ts').sensitive, false);
  });

  it('ignores comments and blank lines', () => {
    writeGitignore('# a comment\n\n   \n*.log\n');
    const rules = new IgnoreRules(root);
    assert.strictEqual(rules.classify('debug.log').sensitive, true);
    assert.strictEqual(rules.classify('a comment').sensitive, false);
  });

  it('treats a rule it cannot parse as no rule, rather than refusing everything', () => {
    writeGitignore('[unclosed\n*.log\n');
    const rules = new IgnoreRules(root);
    assert.strictEqual(rules.classify('src/app.js').sensitive, false);
    // The rules after the bad one still apply.
    assert.strictEqual(rules.classify('debug.log').sensitive, true);
  });

  it('remembers a grant for one path only', () => {
    const rules = new IgnoreRules(root);
    rules.grant('api/.env');
    assert.strictEqual(rules.isGranted('api/.env'), true);
    // Allowing one .env is not allowing every .env.
    assert.strictEqual(rules.isGranted('web/.env'), false);
  });

  it('normalises separators so a Windows path matches', () => {
    writeGitignore('*.env\n');
    const rules = new IgnoreRules(root);
    assert.strictEqual(rules.classify('api\\.env').sensitive, true);
    assert.strictEqual(normalize('./api\\.env'), 'api/.env');
  });
});

describe('ignoreRules.globToRegExpSource', () => {
  it('keeps a single star inside one path segment', () => {
    assert.ok(new RegExp(`^${globToRegExpSource('*.env')}$`).test('.env'));
    assert.ok(!new RegExp(`^${globToRegExpSource('*.env')}$`).test('api/.env'));
  });

  it('escapes regex metacharacters in a literal name', () => {
    const source = globToRegExpSource('a+b(c).txt');
    assert.ok(new RegExp(`^${source}$`).test('a+b(c).txt'));
    assert.ok(!new RegExp(`^${source}$`).test('axbxcx.txt'));
  });

  it('refuses syntax it does not implement rather than guessing', () => {
    assert.strictEqual(globToRegExpSource('[unclosed'), null);
  });
});

describe('permissionGate — reading a sensitive file', () => {
  /** @param {object} opts */
  function makeGate(opts = {}) {
    const asked = [];
    const gate = new PermissionGate({
      workspaceRoot: root,
      modes: new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: true } }),
      ignoreRules: new IgnoreRules(root),
      confirm: async (request) => {
        asked.push(request);
        return opts.approve === true;
      },
    });
    return { gate, asked };
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-gate-ignore-')));
    writeGitignore('*.env\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=hunter2\n');
    fs.writeFileSync(path.join(root, 'app.js'), 'const a = 1;\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('asks before reading it', async () => {
    const { gate, asked } = makeGate({ approve: false });
    const decision = await gate.requestRead({ path: '.env' });

    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].kind, 'read');
    assert.strictEqual(asked[0].risk, 'elevated');
    assert.strictEqual(decision.allowed, false);
  });

  it('is not waved through by Auto Edit or Auto Scripts', async () => {
    // Both auto modes are on above. Neither is about reads, and neither may become a
    // blanket grant over the user's own .gitignore.
    const { asked } = makeGate({ approve: false });
    assert.strictEqual(asked.length, 0);
    const { gate, asked: asked2 } = makeGate({ approve: false });
    await gate.requestRead({ path: '.env' });
    assert.strictEqual(asked2.length, 1);
  });

  it('tells the model not to route around a refusal', async () => {
    const { gate } = makeGate({ approve: false });
    const decision = await gate.requestRead({ path: '.env' });
    assert.match(decision.reason, /do not try to read it again|another way/i);
  });

  it('reads it once the user says yes, and does not ask twice', async () => {
    const { gate, asked } = makeGate({ approve: true });

    const first = await gate.requestRead({ path: '.env' });
    assert.strictEqual(first.allowed, true);
    assert.strictEqual(first.decision, 'approved');

    const second = await gate.requestRead({ path: '.env' });
    assert.strictEqual(second.allowed, true);
    assert.strictEqual(asked.length, 1, 'the grant should last the session');
  });

  it('never asks about ordinary source', async () => {
    const { gate, asked } = makeGate({ approve: false });
    const decision = await gate.requestRead({ path: 'app.js' });

    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.decision, 'auto-approved');
    assert.strictEqual(asked.length, 0);
  });

  it('still blocks a path outside the workspace, without asking', async () => {
    const { gate, asked } = makeGate({ approve: true });
    const decision = await gate.requestRead({ path: '../outside.txt' });

    assert.strictEqual(decision.allowed, false);
    assert.strictEqual(asked.length, 0, 'confinement is not a question for the user');
  });

  it('behaves exactly as before when no ignoreRules are configured', async () => {
    // Every existing caller constructs a gate without one.
    const asked = [];
    const gate = new PermissionGate({
      workspaceRoot: root,
      modes: new PermissionModes({ initial: {} }),
      confirm: async (request) => {
        asked.push(request);
        return false;
      },
    });

    const decision = await gate.requestRead({ path: '.env' });
    assert.strictEqual(decision.allowed, true);
    assert.strictEqual(decision.decision, 'auto-approved');
    assert.strictEqual(asked.length, 0);
  });
});
