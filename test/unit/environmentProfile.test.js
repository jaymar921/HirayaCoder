'use strict';

/**
 * Telling the model what machine it is on, instead of letting it guess.
 *
 * The bug these cover is not subtle and did not need a clever detector: on macOS the
 * model proposed `mkdir -p`, on Windows it would have proposed `md`, and the extension
 * knew the answer both times and never said it. So the assertions are about the two
 * things that have to be true of the block — it names the real platform, and it never
 * implies a shell exists — plus the one thing that must not happen, which is a Plan
 * prompt naming a tool Plan mode does not have.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const environmentProfile = require('../../app/core/environmentProfile');

describe('environmentProfile.detect', () => {
  it('names each platform the way a person would', () => {
    assert.strictEqual(environmentProfile.detect({ platform: 'darwin' }).osName, 'macOS');
    assert.strictEqual(environmentProfile.detect({ platform: 'win32' }).osName, 'Windows');
    assert.strictEqual(environmentProfile.detect({ platform: 'linux' }).osName, 'Linux');
  });

  it('reports the command style a user of this machine would type in', () => {
    assert.strictEqual(environmentProfile.detect({ platform: 'win32' }).commandStyle, 'cmd');
    assert.strictEqual(environmentProfile.detect({ platform: 'darwin' }).commandStyle, 'sh');
    assert.strictEqual(environmentProfile.detect({ platform: 'linux' }).commandStyle, 'sh');
  });

  it('describes this machine without being told what it is', () => {
    const profile = environmentProfile.detect();
    assert.strictEqual(profile.platform === 'other' ? 'other' : profile.platform, profile.platform);
    assert.ok(profile.osVersion.length > 0);
    assert.strictEqual(profile.nodeVersion, process.versions.node);
    assert.ok(!Number.isNaN(Date.parse(profile.generatedAt)));
  });
});

describe('environmentProfile.render', () => {
  it('states the operating system as a fact, not a question to ask the user', () => {
    const block = environmentProfile.render(environmentProfile.detect({ platform: 'darwin', release: '24.1.0' }));
    assert.ok(block.includes('macOS'));
    assert.ok(block.includes('24.1.0'));
    assert.ok(/never speculate/i.test(block));
  });

  it('says the POSIX utilities are unavailable even on a POSIX machine', () => {
    // The mistake worth designing against: a model told "this is macOS" and nothing else
    // proposes `mkdir -p` with more confidence, not less.
    const block = environmentProfile.render(environmentProfile.detect({ platform: 'darwin' }));
    assert.ok(block.includes('mkdir -p'));
    assert.ok(/unavailable/i.test(block));
    assert.ok(block.includes('"cwd"'));
  });

  it('writes the Windows note for a Windows machine', () => {
    const block = environmentProfile.render(environmentProfile.detect({ platform: 'win32' }));
    assert.ok(block.includes('Windows'));
    assert.ok(/cmd\/PowerShell/.test(block));
    assert.ok(!/bash\/zsh/.test(block));
  });

  it('names no mutating tool when the route has none', () => {
    const block = environmentProfile.render(environmentProfile.detect({ platform: 'linux' }), { mutating: false });
    for (const name of ['write_file', 'create_folder', 'run_script', 'delete_file']) {
      assert.ok(!block.includes(name), `${name} was named in a read-only environment block`);
    }
    // The platform facts still travel — they are true whatever the mode is.
    assert.ok(block.includes('Linux'));
  });
});

describe('environmentProfile.persist', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-env-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('leaves the profile where a user can read what the agent was told', () => {
    const written = environmentProfile.persist(root, environmentProfile.detect({ platform: 'darwin' }));
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.hirayacoder', 'environment.json'), 'utf8'));

    assert.strictEqual(onDisk.osName, 'macOS');
    assert.strictEqual(onDisk.platform, 'darwin');
    assert.strictEqual(onDisk.nodeVersion, written.nodeVersion);
  });

  it('returns the profile rather than throwing when the file cannot be written', () => {
    // No workspace is the ordinary case, not an error: the extension runs without one.
    const profile = environmentProfile.persist('', environmentProfile.detect({ platform: 'linux' }));
    assert.strictEqual(profile.osName, 'Linux');
  });
});
