'use strict';

/**
 * Answering a doomed command from the filesystem instead of running it.
 *
 * The value here is not the refusal — npm refuses `npm run buld` perfectly well on its
 * own. It is what the model gets back: the list of scripts that do exist, in the turn
 * where it still has the budget to use one.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { preflight, parseRun } = require('../../app/agent/scriptPreflight');

describe('scriptPreflight.parseRun', () => {
  it('reads the script name out of the shapes package managers accept', () => {
    assert.deepStrictEqual(parseRun('npm run build'), { runner: 'npm', script: 'build' });
    assert.deepStrictEqual(parseRun('pnpm run test'), { runner: 'pnpm', script: 'test' });
    assert.deepStrictEqual(parseRun('yarn build'), { runner: 'yarn', script: 'build' });
  });

  it('has no opinion on anything that is not a package script', () => {
    assert.strictEqual(parseRun('node index.js'), null);
    assert.strictEqual(parseRun('npm install'), null);
    assert.strictEqual(parseRun('git status'), null);
    // `npm build` is not a real command; npm reserves the bare form for its own verbs.
    assert.strictEqual(parseRun('npm build'), null);
  });
});

describe('scriptPreflight', () => {
  /** @type {string} */
  let root;

  /**
   * @param {string} directory
   * @param {object} manifest
   */
  function project(directory, manifest) {
    const absolute = path.join(root, directory);
    fs.mkdirSync(absolute, { recursive: true });
    fs.writeFileSync(path.join(absolute, 'package.json'), JSON.stringify(manifest));
    return absolute;
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-preflight-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('lists the scripts that exist when the model invents one', async () => {
    project('.', { scripts: { dev: 'vite', build: 'vite build' } });
    fs.mkdirSync(path.join(root, 'node_modules'));

    const refusal = preflight({ command: 'npm run buld', workspaceRoot: root });

    assert.strictEqual(refusal.code, 'MISSING_SCRIPT');
    assert.match(refusal.reason, /dev, build/);
  });

  it('sends the model to the folder that has a package.json', () => {
    project('todo-glass-app', { scripts: { build: 'vite build' } });

    const refusal = preflight({ command: 'npm run build', workspaceRoot: root });

    assert.strictEqual(refusal.code, 'NO_PACKAGE_JSON');
    assert.match(refusal.reason, /"cwd"/);
  });

  it('says to install before building, rather than failing halfway through a build', () => {
    project('app', { scripts: { build: 'vite build' }, dependencies: { react: '^18.0.0' } });

    const refusal = preflight({ command: 'npm run build', cwd: 'app', workspaceRoot: root });

    assert.strictEqual(refusal.code, 'DEPENDENCIES_NOT_INSTALLED');
    assert.match(refusal.reason, /"cwd": "app"/);
  });

  it('allows a build in a project that genuinely has no dependencies', () => {
    // Being wrong in this direction blocks work that would have succeeded, which is
    // worse than any failure this module prevents.
    project('.', { scripts: { build: 'node build.js' } });

    assert.strictEqual(preflight({ command: 'npm run build', workspaceRoot: root }), null);
  });

  it('allows a script that is really there', () => {
    project('.', { scripts: { build: 'vite build' }, dependencies: { vite: '^5.0.0' } });
    fs.mkdirSync(path.join(root, 'node_modules'));

    assert.strictEqual(preflight({ command: 'npm run build', workspaceRoot: root }), null);
  });

  it('leaves npm test alone, since npm defines it whether package.json does or not', () => {
    project('.', { scripts: {} });

    assert.strictEqual(preflight({ command: 'npm run test', workspaceRoot: root }), null);
  });

  it('says nothing about commands it cannot reason about', () => {
    assert.strictEqual(preflight({ command: 'node index.js', workspaceRoot: root }), null);
    // `npm install` used to be waved through here. That assertion encoded the bug: with
    // no package.json in scope, npm searches upwards and installs outside the project.
    // See the escape suite below.
    project('.', { name: 'x' });
    assert.strictEqual(preflight({ command: 'npm install', workspaceRoot: root }), null);
  });

  it('defers to the gate for a folder outside the workspace', () => {
    // The gate refuses this with a better message; a second opinion here would only
    // race it.
    assert.strictEqual(preflight({ command: 'npm run build', cwd: '../..', workspaceRoot: root }), null);
  });
});

describe('scriptPreflight — npm climbing out of the workspace', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-escape-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('refuses an install with no package.json anywhere inside the project', () => {
    // The live failure, exactly: a workspace whose project lives in a subfolder, and one
    // `npm install --save lucide-react` sent without a cwd. npm searches upwards, so it
    // left the workspace, left .ignore/, and wrote into the extension's own package.json
    // — exit code 0, reported as success.
    fs.mkdirSync(path.join(root, 'todo-glass-app'));
    fs.writeFileSync(path.join(root, 'todo-glass-app', 'package.json'), '{}');

    const refusal = preflight({ command: 'npm install --save lucide-react', workspaceRoot: root });

    assert.strictEqual(refusal.code, 'NO_PACKAGE_JSON');
    assert.match(refusal.reason, /outside the workspace/i);
  });

  it('allows the same install once it is pointed at the project', () => {
    fs.mkdirSync(path.join(root, 'todo-glass-app'));
    fs.writeFileSync(path.join(root, 'todo-glass-app', 'package.json'), '{}');

    assert.strictEqual(
      preflight({ command: 'npm install --save lucide-react', cwd: 'todo-glass-app', workspaceRoot: root }),
      null
    );
  });

  it('allows a command whose manifest is a folder above it but still inside the project', () => {
    // A monorepo package, or any nested folder: npm resolves upwards to a package.json
    // that is still the user's own, which is fine.
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
    fs.mkdirSync(path.join(root, 'packages', 'web'), { recursive: true });

    assert.strictEqual(preflight({ command: 'npm run build', cwd: 'packages/web', workspaceRoot: root }), null);
  });

  it('guards every package manager, not just npm', () => {
    for (const command of ['yarn add react', 'pnpm install', 'npm ci']) {
      const refusal = preflight({ command, workspaceRoot: root });
      assert.strictEqual(refusal && refusal.code, 'NO_PACKAGE_JSON', command);
    }
  });

  it('still says nothing about a command that is not a package manager', () => {
    assert.strictEqual(preflight({ command: 'node src/main.js', workspaceRoot: root }), null);
    assert.strictEqual(preflight({ command: 'git status', workspaceRoot: root }), null);
  });
});
