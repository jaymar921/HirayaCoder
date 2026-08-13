'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Every path read here is built by joining a hardcoded file name from CANDIDATES or
 * MANIFESTS onto the workspace root, and confined by pathGuard.resolvePath before the
 * read. No path here originates from the model or from a file's contents. */

/**
 * What project is this, in the user's own words?
 *
 * ## The failure this exists for
 *
 * Asked "what is this project all about?", the agent answered from the file listing —
 * the only project context it had ever been given — and produced, across four separate
 * sessions on the same repository, four variations of "a full-stack web application
 * built using Node.js, Express, and Vite, with a strong focus on API development".
 *
 * That description is not wrong. It is what you get from reading directory names. It is
 * also useless, and it was contradicted by line 3 of the repository's own README, which
 * said: "Find the best food prices near you before you buy." The project was a local
 * food-price comparison platform. Nothing in the agent's context could have told it so.
 *
 * The pattern held even when the user pushed back. Told "review the README.md", one
 * session restated the same inferred-from-folders answer and added "No notable features
 * or technologies were mentioned in the README.md file" — a claim about a document it
 * had not opened. A model with no grounding does not report that it lacks grounding; it
 * elaborates, confidently, on the little it has.
 *
 * ## Why this is seeded rather than left to the tools
 *
 * The agent could read the README itself, and on a large model it usually will. But it
 * costs a turn to discover the file, a turn to read it, and a turn to answer — and on
 * Tier B that budget is 8 steps total, shared with whatever was actually asked. Across
 * the observed sessions the small models never got there: one looped on `read_file`
 * until the repeat guard stopped it, one escalated to running the project's dev script,
 * and the rest answered from folder names without ever trying.
 *
 * Seeding costs a few hundred tokens once and removes the whole class of failure. It is
 * the same trade `_workspaceFiles` already makes for the file listing, for the same
 * reason: orientation the model would otherwise have to buy with steps it does not have.
 *
 * ## What is extracted, and what is deliberately not
 *
 * The README's title and opening prose, stopping at the first section heading. That is
 * where projects say what they are; everything after it is installation and API
 * reference, which is longer, less distinctive, and answers a question nobody asked.
 * Badges, images, and HTML wrappers are stripped — they carry no meaning in a prompt and
 * a badge table can eat the whole budget.
 *
 * Plus the manifest's name and description, which are short, structured, and frequently
 * the only prose in a project with no README at all.
 *
 * @module core/projectOverview
 */

const fs = require('fs');

const logger = require('../utils/logger');
const pathGuard = require('../security/pathGuard');
const { redact } = require('../security/secretsScanner');
const { toLf } = require('../utils/platform');

/**
 * README file names, in the order they win.
 *
 * Case matters on Linux and does not on Windows, so both common spellings are listed
 * rather than lowercasing a directory scan — a scan would be a directory read per turn
 * to find a file that is almost always called exactly `README.md`.
 */
const CANDIDATES = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README', 'README.txt'];

/**
 * Manifests that carry a human description, by ecosystem.
 *
 * `parse` returns `{name, description}` or null. Kept declarative so adding an
 * ecosystem is a row here rather than a branch in the extractor.
 */
const MANIFESTS = [
  {
    file: 'package.json',
    parse: (raw) => {
      const pkg = JSON.parse(raw);
      return { name: pkg.name, description: pkg.description };
    },
  },
  {
    file: 'pyproject.toml',
    parse: (raw) => ({
      name: firstTomlValue(raw, 'name'),
      description: firstTomlValue(raw, 'description'),
    }),
  },
  {
    file: 'Cargo.toml',
    parse: (raw) => ({
      name: firstTomlValue(raw, 'name'),
      description: firstTomlValue(raw, 'description'),
    }),
  },
  {
    file: 'pom.xml',
    parse: (raw) => ({
      name: firstXmlTag(raw, 'artifactId'),
      description: firstXmlTag(raw, 'description'),
    }),
  },
  {
    file: 'composer.json',
    parse: (raw) => {
      const pkg = JSON.parse(raw);
      return { name: pkg.name, description: pkg.description };
    },
  },
];

/** A README past this is truncated before parsing — the interesting part is the top. */
const MAX_README_BYTES = 64 * 1024;

/** Characters of prose kept from the README. Roughly a paragraph or three. */
const MAX_PROSE_CHARS = 700;

/**
 * First `key = "value"` in a TOML document.
 *
 * Deliberately not a TOML parser. This reads two fields out of the top table of a file
 * whose full grammar is irrelevant here, and a dependency (or a hand-rolled parser) to
 * do it would be more code and more failure modes than the job is worth. A miss returns
 * empty and the README carries the block.
 *
 * @param {string} raw
 * @param {string} key
 * @returns {string}
 */
function firstTomlValue(raw, key) {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"'\\n]*)["']`, 'm').exec(raw);
  return match ? match[1].trim() : '';
}

/**
 * First `<tag>value</tag>` in an XML document.
 *
 * Same reasoning as `firstTomlValue`. In a `pom.xml` the first `artifactId` and
 * `description` are the project's own, since parent and dependency blocks come later.
 *
 * @param {string} raw
 * @param {string} tag
 * @returns {string}
 */
function firstXmlTag(raw, tag) {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(raw);
  return match ? match[1].trim() : '';
}

/**
 * Strip the decoration that surrounds a README's opening prose.
 *
 * Order matters: HTML blocks go first because a `<p align="center">` wrapper usually
 * contains the logo `<img>`, and removing the image first would leave a stray wrapper.
 *
 * @param {string} markdown
 * @returns {string}
 */
function stripDecoration(markdown) {
  return (
    markdown
      // Badge links: [![Build](img-url)](target). These cluster under the title and are
      // pure noise in a prompt — a row of them can outweigh the description itself.
      .replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '')
      // Bare images, including the logo.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      // HTML blocks — <p align="center">, <img>, <div>, <br>.
      .replace(/<[^>]+>/g, '')
      // Link syntax down to its text: the URL is not readable context.
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Comments, which sometimes hold template instructions from a scaffolder.
      .replace(/<!--[\s\S]*?-->/g, '')
  );
}

/**
 * Is this line a markdown horizontal rule?
 *
 * @param {string} line
 * @returns {boolean}
 */
function isHorizontalRule(line) {
  const bare = line.replace(/\s/g, '');
  if (bare.length < 3) return false;
  const first = bare[0];
  if (first !== '-' && first !== '*' && first !== '_') return false;
  return bare.split('').every((char) => char === first);
}

/**
 * Pull the title and opening prose out of a README.
 *
 * Walks from the top, keeping the first heading as the title and accumulating prose
 * until the next heading. A project states what it is before it states how to install
 * it, and the next heading is reliably where "what it is" ends.
 *
 * The one exception is a README that opens with badges and a logo and only reaches
 * prose after a `##` heading such as "About" or "Overview". So if the walk collects
 * nothing before the first section, it continues into that section rather than giving
 * up — an empty overview is worse than one that starts a heading late.
 *
 * @param {string} markdown
 * @returns {{title: string, prose: string}}
 */
function extractReadme(markdown) {
  const lines = toLf(markdown).split('\n');
  let title = '';
  /** @type {string[]} */
  const prose = [];
  let crossedHeading = false;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());

    if (heading) {
      if (!title) {
        title = stripDecoration(heading[2]).trim();
        continue;
      }
      // A heading ends the opening section — unless nothing has been collected yet, in
      // which case the prose starts below it and the walk keeps going.
      if (prose.length > 0) break;
      crossedHeading = true;
      continue;
    }

    // Horizontal rules (`---`, `***`) are section breaks, not prose. Treated like a
    // heading: they end the opening section once something has been collected.
    //
    // Tested by collapsing the whitespace out first rather than with a single pattern.
    // The natural regex for a rule nests two whitespace quantifiers, which is a
    // backtracking hazard on a line of a file this module does not control.
    if (isHorizontalRule(line)) {
      if (prose.length > 0) break;
      continue;
    }

    // Blockquote and list markers, kept as prose but without their punctuation.
    const text = stripDecoration(line).replace(/^\s*[>*+-]\s+/, '').trim();
    if (!text) {
      // A blank line after real prose ends the paragraph run, once past any heading the
      // walk had to cross to find text at all.
      if (prose.length > 0 && !crossedHeading) continue;
      continue;
    }
    prose.push(text);
    if (prose.join(' ').length >= MAX_PROSE_CHARS) break;
  }

  const joined = prose.join(' ').replace(/\s+/g, ' ').trim();
  return {
    title,
    prose: joined.length > MAX_PROSE_CHARS ? `${joined.slice(0, MAX_PROSE_CHARS).trimEnd()}…` : joined,
  };
}

/**
 * Read one workspace file, or null if it is missing or unreadable.
 *
 * Confined through `pathGuard.resolvePath` like every other read in the extension. The
 * names are hardcoded, so confinement cannot fail on input — it is here so that a
 * workspace root containing a symlinked `README.md` pointing outside the project cannot
 * pull an arbitrary file into a prompt.
 *
 * @param {string} workspaceRoot
 * @param {string} name
 * @returns {string | null}
 */
function readIfPresent(workspaceRoot, name) {
  try {
    const { absolute } = pathGuard.resolvePath(workspaceRoot, name);

    // Symlink containment, checked here rather than via `pathGuard.assertRealPath`
    // because that one is async and this whole module is a synchronous read of two
    // small files on the prompt-building path. A `README.md` symlinked out of the
    // workspace would otherwise splice an arbitrary file into every prompt.
    const real = fs.realpathSync(absolute);
    if (!pathGuard.isInside(fs.realpathSync(workspaceRoot), real)) return null;

    const stat = fs.statSync(real);
    if (!stat.isFile()) return null;
    const handle = fs.openSync(real, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_README_BYTES));
      fs.readSync(handle, buffer, 0, buffer.length, 0);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    // Missing is the common case and not worth a log line; anything else is a project
    // the agent will simply orient itself in the old way.
    return null;
  }
}

/**
 * Build the project overview block for a workspace.
 *
 * @param {string} workspaceRoot
 * @returns {string} The rendered block, or '' when the project says nothing about
 *   itself. An empty string is a real answer: a bare directory of source files has no
 *   description, and inventing one is the failure this module exists to prevent.
 */
function build(workspaceRoot) {
  if (!workspaceRoot) return '';

  /** @type {string[]} */
  const parts = [];
  let readmeName = '';

  for (const candidate of CANDIDATES) {
    const raw = readIfPresent(workspaceRoot, candidate);
    if (raw === null) continue;
    readmeName = candidate;
    const { title, prose } = extractReadme(raw);
    if (title) parts.push(`Name: ${title}`);
    if (prose) parts.push(`From ${candidate}: ${prose}`);
    break;
  }

  for (const manifest of MANIFESTS) {
    const raw = readIfPresent(workspaceRoot, manifest.file);
    if (raw === null) continue;
    try {
      const parsed = manifest.parse(raw) || {};
      const name = String(parsed.name || '').trim();
      const description = String(parsed.description || '').trim();
      // The manifest name is only worth the tokens when the README did not supply one;
      // a description is worth it either way, being the author's own one-liner.
      if (name && parts.length === 0) parts.push(`Name: ${name}`);
      if (description) parts.push(`From ${manifest.file}: ${description}`);
    } catch (err) {
      logger.debug(`Could not parse ${manifest.file} for the project overview: ${/** @type {Error} */ (err).message}`);
    }
    break;
  }

  if (parts.length === 0) return '';

  const source = readmeName || 'the project manifest';
  return redact(
    `What this project is, taken from ${source} in the workspace root. This is the ` +
      `project's own description of itself — prefer it over anything you would infer ` +
      `from folder or file names:\n${parts.join('\n')}`
  );
}

module.exports = {
  build,
  extractReadme,
  stripDecoration,
  CANDIDATES,
  MANIFESTS,
  MAX_PROSE_CHARS,
};
