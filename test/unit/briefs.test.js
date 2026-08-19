'use strict';

/**
 * The benchmark's briefs, checked against the prompts they grade.
 *
 * A brief's `requiredFiles` is copied by hand from the folder tree in its prompt, and
 * hand-copied lists drift. These tests make the drift a failure rather than a quiet
 * mis-measurement — a required file the prompt never asks for would fail every model
 * for something nobody requested.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const briefs = require('../../tools/lib/briefs');
const requestPlan = require('../../app/core/requestPlan');
const fileTree = require('../../app/core/fileTree');

const promptsDir = path.join(__dirname, '..', '..', 'tools', 'prompts');

describe('briefs', () => {
  it('has a prompt on disk for each one', () => {
    for (const brief of briefs.BRIEFS) {
      assert.ok(fs.existsSync(path.join(promptsDir, brief.promptFile)), `${brief.id}: ${brief.promptFile} is missing`);
    }
  });

  it('gives each one a distinct id, directory and probe', () => {
    const ids = briefs.BRIEFS.map((brief) => brief.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    const dirs = briefs.BRIEFS.map((brief) => brief.appDir);
    assert.strictEqual(new Set(dirs).size, dirs.length);
  });

  it('names only files its own prompt asks for', () => {
    // The check that matters: every required file has to appear in the prompt's drawn
    // tree, or the benchmark is failing models for something nobody requested.
    for (const brief of briefs.BRIEFS) {
      const text = fs.readFileSync(path.join(promptsDir, brief.promptFile), 'utf8');
      const plan = requestPlan.fromRequest(text);
      const drawn = plan.items
        .filter((item) => fileTree.hasTree(item.detail))
        .flatMap((item) => fileTree.files(item.detail).map((file) => file.path));
      assert.ok(drawn.length > 0, `${brief.id}: no folder tree found in ${brief.promptFile}`);

      // The tree is written with the project directory as its root; the brief lists
      // paths relative to that directory.
      const relative = new Set(
        drawn.map((file) => (file.startsWith(brief.appDir + '/') ? file.slice(brief.appDir.length + 1) : file))
      );
      for (const required of brief.requiredFiles) {
        assert.ok(relative.has(required), `${brief.id}: requires ${required}, which its prompt never draws`);
      }
    }
  });

  it('finds a brief by id, and nothing by a name it does not have', () => {
    assert.strictEqual(briefs.byId('todo').appDir, 'todo-glass-app');
    assert.strictEqual(briefs.byId('cms').toolchain, 'node');
    assert.strictEqual(briefs.byId('pos').toolchain, 'maven');
    assert.strictEqual(briefs.byId('nope'), null);
  });
});

describe('probe suites', () => {
  const { SUITES } = require('../../tools/lib/appProbe');
  const { JAVA_FEATURES } = require('../../tools/lib/javaProbe');

  it('has a suite for every browser brief, and a page script on disk for each', () => {
    for (const brief of briefs.BRIEFS) {
      if (brief.toolchain === 'maven') {
        assert.ok(JAVA_FEATURES.length > 0);
        continue;
      }
      const suite = SUITES[brief.probe];
      assert.ok(suite, `${brief.id}: no probe suite named ${brief.probe}`);
      assert.ok(
        fs.existsSync(path.join(__dirname, '..', '..', 'tools', 'lib', suite.file)),
        `${brief.id}: ${suite.file} is missing`
      );
    }
  });

  it('reports a feature list the runner can size a score against', () => {
    for (const suite of Object.values(SUITES)) {
      assert.ok(suite.features.length >= 8, 'a suite with fewer than eight checks is not measuring much');
      assert.strictEqual(new Set(suite.features).size, suite.features.length, 'duplicate feature names');
    }
  });
});
