'use strict';

/**
 * These assertions are the regression test for the "what is this project about?"
 * failure — four sessions on a repository whose README opened with "Find the best food
 * prices near you before you buy", all four answered "a full-stack web application
 * built using Node.js, Express, and Vite".
 *
 * The load-bearing case is `keeps the sentence that says what the project does`. The
 * rest guard the extraction against the decoration that surrounds it in a real README.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectOverview = require('../../app/core/projectOverview');

/** @type {string} */
let root;

/**
 * @param {string} name
 * @param {string} content
 */
function write(name, content) {
  fs.writeFileSync(path.join(root, name), content, 'utf8');
}

describe('projectOverview.build', () => {
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-overview-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps the sentence that says what the project does', () => {
    // Shaped exactly like the README the agent failed on: title, badge, centered logo,
    // then the one line that answers the question.
    write(
      'README.md',
      [
        '# LocoMenu',
        '',
        'Find the best food prices near you before you buy.',
        '',
        '[![Build Pipeline](https://example.test/badge.svg)](https://example.test/actions)',
        '',
        '<p align="center">',
        '  <img width="125" src="./app/public/loco-menu.png" alt="LocoMenu logo">',
        '</p>',
        '',
        'LocoMenu is a hyper-local, community-powered food price intelligence platform.',
        '',
        '## Why People Use LocoMenu',
        '',
        '- Save money with local, map-based price comparisons.',
      ].join('\n')
    );

    const overview = projectOverview.build(root);

    assert.match(overview, /Name: LocoMenu/);
    assert.match(overview, /Find the best food prices near you before you buy/);
    assert.match(overview, /hyper-local, community-powered food price intelligence platform/);
  });

  it('stops at the first section rather than pulling in the whole document', () => {
    write(
      'README.md',
      ['# Thing', '', 'A tool for doing the thing.', '', '## Installation', '', 'npm install thing'].join('\n')
    );

    const overview = projectOverview.build(root);
    assert.match(overview, /A tool for doing the thing/);
    assert.doesNotMatch(overview, /npm install/);
  });

  it('drops badges, images, and HTML wrappers', () => {
    write(
      'README.md',
      ['# Thing', '', '[![CI](https://x.test/b.svg)](https://x.test/ci)', '<img src="logo.png">', '', 'Real prose here.'].join(
        '\n'
      )
    );

    const overview = projectOverview.build(root);
    assert.doesNotMatch(overview, /svg|img|https:/);
    assert.match(overview, /Real prose here/);
  });

  it('reads prose that only starts after a horizontal rule and a second heading', () => {
    write('README.md', ['# Thing', '', '---', '', '## About', '', 'It measures rainfall.'].join('\n'));

    assert.match(projectOverview.build(root), /It measures rainfall/);
  });

  it('falls back to the manifest when there is no README', () => {
    write('package.json', JSON.stringify({ name: 'rain-gauge', description: 'Measures rainfall.' }));

    const overview = projectOverview.build(root);
    assert.match(overview, /Name: rain-gauge/);
    assert.match(overview, /Measures rainfall/);
  });

  it('reads a description out of pyproject.toml and pom.xml', () => {
    write('pyproject.toml', '[project]\nname = "gauge"\ndescription = "Measures rainfall."\n');
    assert.match(projectOverview.build(root), /Measures rainfall/);

    fs.rmSync(path.join(root, 'pyproject.toml'));
    write('pom.xml', '<project><artifactId>gauge</artifactId><description>Measures rainfall.</description></project>');
    assert.match(projectOverview.build(root), /Measures rainfall/);
  });

  it('returns nothing for a project that describes itself nowhere', () => {
    write('index.js', 'console.log(1);');
    assert.strictEqual(projectOverview.build(root), '');
  });

  it('survives a malformed manifest instead of throwing', () => {
    write('package.json', '{ this is not json');
    assert.strictEqual(projectOverview.build(root), '');
  });

  it('tells the model to prefer this over what it would infer from folder names', () => {
    // The whole point. Without this framing the block is one more piece of context to
    // be outweighed by a directory listing, which is how the wrong answers were reached.
    write('README.md', '# Thing\n\nA tool.');
    assert.match(projectOverview.build(root), /prefer it over anything you would infer/i);
  });

  it('redacts a secret that someone pasted into their README', () => {
    // A README is prose and rarely holds credentials, but "rarely" is not "never" —
    // quickstart sections quote real keys — and this block goes into every prompt.
    write('README.md', '# Thing\n\nQuickstart: set api_key: "sk-abc123def456ghi789jkl" and run it.');

    const overview = projectOverview.build(root);
    assert.doesNotMatch(overview, /sk-abc123def456ghi789jkl/);
    assert.match(overview, /REDACTED/);
  });

  it('does not follow a README that is a symlink out of the workspace', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-outside-')));
    fs.writeFileSync(path.join(outside, 'secrets.md'), '# Secrets\n\nThe launch codes.', 'utf8');

    try {
      fs.symlinkSync(path.join(outside, 'secrets.md'), path.join(root, 'README.md'));
    } catch {
      // Windows without developer mode refuses symlink creation; the guard is asserted
      // by pathGuard's own suite, and there is nothing to check here.
      return;
    }

    assert.doesNotMatch(projectOverview.build(root), /launch codes/);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe('projectOverview.extractReadme', () => {
  it('separates the title from the prose', () => {
    const { title, prose } = projectOverview.extractReadme('# Gauge\n\nMeasures rainfall.');
    assert.strictEqual(title, 'Gauge');
    assert.strictEqual(prose, 'Measures rainfall.');
  });

  it('caps the prose so one long preamble cannot eat the budget', () => {
    const long = `# T\n\n${'word '.repeat(1000)}`;
    const { prose } = projectOverview.extractReadme(long);
    assert.ok(prose.length <= projectOverview.MAX_PROSE_CHARS + 1, `prose was ${prose.length} chars`);
  });

  it('handles a README with no heading at all', () => {
    const { title, prose } = projectOverview.extractReadme('Just a description, no heading.');
    assert.strictEqual(title, '');
    assert.match(prose, /Just a description/);
  });
});
