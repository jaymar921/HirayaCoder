'use strict';

/**
 * The release workflow marks 1.0.0 as a release, not a pre-release.
 *
 * This is checked here because it is checkable exactly once — on the tag push, in a job
 * that runs for about a minute and then cannot be re-run against the same tag. Getting
 * it wrong publishes a 1.0.0 that GitHub shows under "Pre-release", hides from the
 * repository header, and excludes from `/releases/latest`, which is the URL install
 * instructions point at. The fix afterwards is a manual edit by whoever notices.
 *
 * The classification is derived from `package.json` rather than from a checkbox, so it
 * is derivable here too: the same `case` the workflow runs, applied to the same version.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
const { version } = require('../../package.json');

/**
 * The workflow's rule, in JavaScript: a `0.x` version or any version carrying a
 * pre-release suffix is a pre-release; everything else is a release.
 *
 * @param {string} v
 * @returns {boolean}
 */
const isPrerelease = (v) => v.startsWith('0.') || v.includes('-');

describe('release workflow — release vs pre-release', () => {
  it('still decides from the version rather than from an input', () => {
    // If this moves to a workflow_dispatch checkbox, the assertions below stop meaning
    // anything, so the shape is pinned before the behaviour.
    assert.match(workflow, /case "\$VERSION" in/);
    assert.match(workflow, /0\.\*\|\*-\*\)\s*echo "prerelease=true"/);
    assert.match(workflow, /\*\)\s*echo "prerelease=false"/);
  });

  it('classifies the version in package.json as a full release', () => {
    assert.strictEqual(
      isPrerelease(version),
      false,
      `package.json is ${version}, which the workflow would publish as a pre-release`
    );
  });

  it('agrees with the workflow on the versions either side of the line', () => {
    for (const v of ['0.1.0', '0.9.0', '1.0.0-rc.1', '2.0.0-beta']) {
      assert.strictEqual(isPrerelease(v), true, `${v} should be a pre-release`);
    }
    for (const v of ['1.0.0', '1.2.3', '10.0.0']) {
      assert.strictEqual(isPrerelease(v), false, `${v} should be a full release`);
    }
  });

  it('states the flag in both directions, so an existing release cannot stay flagged', () => {
    // The create path could rely on gh's default; the edit path cannot, because it is
    // reached when a release already exists and may already be marked a pre-release.
    assert.match(workflow, /CREATE_FLAGS="--latest"/);
    assert.match(workflow, /EDIT_FLAGS="--prerelease=false --latest"/);
    assert.match(workflow, /gh release edit "\$\{GITHUB_REF_NAME\}" \$EDIT_FLAGS/);
    assert.ok(
      !/if \[ -n "\$FLAGS" \]/.test(workflow),
      'the conditional edit is back — a hand-drafted pre-release would stay one'
    );
  });

  it('only attaches the pre-release warning when it is actually a pre-release', () => {
    // The warning block and the flag are driven by the same variable. If they ever came
    // apart, a full release could ship notes telling people not to depend on it.
    const guard = workflow.indexOf('if [ "$PRERELEASE" = "true" ]; then\n          cat >> notes.md');
    assert.ok(guard > -1, 'the pre-release notes block is no longer guarded by $PRERELEASE');
  });
});
