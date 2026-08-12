'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Every path here is derived from this repository's own package.json version and the
 * repo root, never from user input. */

/**
 * Build a `.vsix` into `builds/v<version>/`.
 *
 * The convention is documented in `builds/README.md`: one immutable folder per
 * version, build output only, never committed. This script exists so that convention
 * is executable rather than a thing to remember — the version comes from
 * `package.json`, so the folder can never disagree with the manifest inside the
 * package.
 *
 * Refuses to overwrite an existing version folder. A released `.vsix` and the git tag
 * that produced it have to keep pointing at the same bytes; silently replacing one
 * because the version was not bumped is how a "v0.1.0" ends up meaning two different
 * builds. Bump the version, or delete the folder deliberately.
 *
 * Usage:
 *
 *   npm run package
 *   npm run package -- --force   # replace the existing folder for this version
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const force = process.argv.includes('--force');

/** @param {string} message */
function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = String(manifest.version || '').trim();

// A version that is missing or not `x.y.z` would produce a folder name that does not
// sort or compare like the others, and `vsce` would reject it downstream anyway.
//
// Split before matching rather than writing one pattern with an optional trailing
// group: two quantifiers sharing the same input is the shape that backtracks badly,
// and `outputParser.js` makes the same trade for the same reason.
const [core, ...prerelease] = version.split('-');
const versionLooksSane =
  /^\d+\.\d+\.\d+$/.test(core) && prerelease.every((part) => /^[0-9A-Za-z.]+$/.test(part));

if (!versionLooksSane) {
  fail(`package.json has no usable version (found ${JSON.stringify(manifest.version)}).`);
}

const outputDir = path.join(repoRoot, 'builds', `v${version}`);
const vsixName = `${manifest.name}-${version}.vsix`;
const outputPath = path.join(outputDir, vsixName);

if (fs.existsSync(outputDir) && !force) {
  const existing = fs.readdirSync(outputDir);
  if (existing.length > 0) {
    fail(
      `builds/v${version}/ already exists and is not empty (${existing.join(', ')}).\n` +
        '    Bump the version in package.json, or re-run with --force to replace it.'
    );
  }
}

fs.mkdirSync(outputDir, { recursive: true });

console.log(`\n  Packaging HirayaCoder ${version} → builds/v${version}/${vsixName}\n`);

// vsce's own JS entry point, run with this Node — not the `.bin` shim.
//
// On Windows the shim is `vsce.cmd`, and Node refuses to spawn a `.cmd` without
// `shell: true` (CVE-2024-27980), which fails here with EINVAL. `scriptRunner.js`
// solves that by going through `cmd.exe` with an argument array, because the command
// it runs is chosen by a model and must stay on the allow-listed path. Nothing is
// untrusted here, so the simpler answer is available: skip the shim entirely and
// invoke the script directly, which also keeps `shell: false` on every platform.
const vsceEntry = path.join(repoRoot, 'node_modules', '@vscode', 'vsce', 'vsce');

if (!fs.existsSync(vsceEntry)) {
  fail('@vscode/vsce is not installed. Run `npm install` first.');
}

const result = spawnSync(process.execPath, [vsceEntry, 'package', '--out', outputPath], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: false,
});

if (result.error) fail(`Could not run vsce: ${result.error.message}`);
if (result.status !== 0) fail(`vsce exited with code ${result.status}.`);
if (!fs.existsSync(outputPath)) fail('vsce reported success but produced no .vsix.');

const bytes = fs.statSync(outputPath).size;
console.log(`\n  ✓ builds/v${version}/${vsixName}  (${(bytes / 1024).toFixed(1)} KB)`);
console.log('    Attach this to the GitHub Release for the matching tag; do not commit it.\n');
