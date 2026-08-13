'use strict';

/**
 * What a file pulls in from the rest of the project.
 *
 * ## Why a read is not enough on its own
 *
 * A model asked to wire `App.jsx` up to a hook and four components reads `App.jsx`,
 * sees five import lines, and now needs five more reads to learn what any of them
 * export. On CPU inference each of those is a turn, and a turn is tens of seconds — so
 * on the React benchmark the models never got there. `qwen3.5:4b` spent all 44 of its
 * steps on `read_file` and `list_files` and wrote nothing at all; the ones that did
 * write produced components in isolation and left `App.jsx` holding Vite's counter
 * demo, because nothing in their context said what `useTodos` returned.
 *
 * Following the imports at read time turns those five turns into one. It is also the
 * cheaper half of the trade: a component file is small, and the alternative is not
 * "spend fewer tokens" but "spend the same tokens one turn at a time, with the model
 * losing the thread in between".
 *
 * ## What this deliberately does not do
 *
 * It is not a module resolver and must not become one. Node's algorithm involves
 * `package.json` `exports` maps, conditional exports, `node_modules` walking, and
 * tsconfig path aliases — all of which can fail, and none of which matter here,
 * because the question being answered is only "is there a file in this workspace the
 * model should see alongside this one". A specifier that does not resolve to a file
 * inside the workspace is simply dropped: a bare `react` is a dependency the model
 * already knows, and a mis-resolved alias is better skipped than guessed at.
 *
 * Depth is one, not transitive. Two hops from `App.jsx` reaches every leaf of a small
 * React app, which is the whole context budget spent on files nobody asked about.
 *
 * @module core/importGraph
 */

const fs = require('fs');
const path = require('path');

const { toPosixPath } = require('../utils/platform');

/**
 * Statements that name another module.
 *
 * ## Why each of these is trivially linear
 *
 * These run over whole source files, up to a megabyte, including generated and minified
 * ones. A pattern where two quantifiers can claim the same run of characters backtracks
 * quadratically or worse on exactly that input, so none of these has one: every
 * quantifier here is followed by a literal that cannot itself match, and the specifier
 * class excludes both quote characters and the newline.
 *
 * The cost of that discipline is anchoring on the keyword nearest the string rather
 * than parsing the statement. `from './y'` is matched wherever it appears, including
 * inside a comment or a string literal — which is harmless, because a specifier that
 * does not resolve to a real file is dropped, and that is this module's normal outcome
 * for anything it cannot place.
 *
 * Covered: ES `import`/`export … from`, bare side-effect `import`, CommonJS `require`,
 * dynamic `import()`, and CSS `@import`. Python and Go are absent on purpose — their
 * specifiers are package paths rather than file paths, so resolving them would be
 * guesswork of exactly the kind this module declines to do.
 */
const SPECIFIER_PATTERNS = [
  // import x from './y'  |  export { x } from './y'  — including the multi-line form,
  // where the brace list is on its own lines and only `} from './y'` matches.
  /\bfrom\s+['"]([^'"\n]+)['"]/g,
  // import './y'  — a side-effect import, which has no `from`.
  /\bimport\s+['"]([^'"\n]+)['"]/g,
  // require('./y')  |  import('./y')
  /\b(?:require|import)\s*\(\s*['"]([^'"\n]+)['"]/g,
  // @import './y.css'  |  @import url('./y.css')
  /@import\s+(?:url\()?\s*['"]([^'"\n]+)['"]/g,
];

/**
 * Extensions tried, in order, when a specifier names no file extension.
 *
 * Ordered by how likely the file is to be the one meant, not alphabetically:
 * `./useTodos` in a React project is `useTodos.js` far more often than `useTodos.mjs`.
 */
const RESOLUTION_EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.css', '.vue', '.svelte'];

/** `./components` is a folder; this is what is tried inside it. */
const INDEX_BASENAMES = ['index.js', 'index.jsx', 'index.ts', 'index.tsx', 'index.mjs', 'index.css'];

/** A specifier this module will try to resolve at all. */
const RELATIVE = /^\.{1,2}\//;

/**
 * Aliases that conventionally mean "the project's source root".
 *
 * Vite, Next, and most bundler configs set one of these up, and a React project of any
 * size uses them instead of `../../`. Resolving them is a guess, but a narrow and
 * checkable one: the candidate either exists on disk or it does not, and a wrong guess
 * costs nothing because it resolves to no file and is dropped.
 */
const SOURCE_ALIASES = [
  { prefix: '@/', roots: ['src', ''] },
  { prefix: '~/', roots: ['src', ''] },
  { prefix: 'src/', roots: [''] },
];

/**
 * Every module specifier named in a source file, in source order, de-duplicated.
 *
 * @param {string} content
 * @returns {string[]}
 */
function parseSpecifiers(content) {
  const text = String(content || '');
  /** @type {Set<string>} */
  const found = new Set();

  for (const pattern of SPECIFIER_PATTERNS) {
    // Each pattern carries `g`, so `lastIndex` has to be reset: the constants are
    // module-level and shared across every call.
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1].trim();
      if (specifier) found.add(specifier);
    }
  }

  return [...found];
}

/**
 * Candidate workspace-relative paths a specifier might mean, best guess first.
 *
 * Pure string work — nothing here touches the disk, so it is cheap to over-generate and
 * let the caller check which candidate exists.
 *
 * @param {string} specifier
 * @param {string} fromRelative  Workspace-relative path of the file doing the importing.
 * @returns {string[]}
 */
function candidatesFor(specifier, fromRelative) {
  const spec = String(specifier || '').trim();
  if (!spec) return [];

  /** @type {string[]} */
  const bases = [];

  if (RELATIVE.test(spec)) {
    const dir = path.posix.dirname(toPosixPath(fromRelative));
    bases.push(path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, spec)));
  } else {
    const alias = SOURCE_ALIASES.find((entry) => spec.startsWith(entry.prefix));
    if (!alias) return [];
    const rest = spec.slice(alias.prefix.length);
    if (!rest) return [];
    // The importing file's own package root, so a monorepo's `@/x` resolves next to the
    // file rather than at the workspace root.
    const owner = toPosixPath(fromRelative).split('/')[0];
    for (const root of alias.roots) {
      bases.push(path.posix.normalize(path.posix.join(root, rest)));
      if (owner && owner !== rest) bases.push(path.posix.normalize(path.posix.join(owner, root, rest)));
    }
  }

  /** @type {string[]} */
  const candidates = [];
  for (const base of bases) {
    // A path that climbed out of the workspace is not ours to read; the guard would
    // refuse it anyway, and generating it only wastes a stat.
    if (base.startsWith('../') || base === '..') continue;
    const hasExtension = /\.[a-z0-9]{1,6}$/i.test(base);

    for (const extension of RESOLUTION_EXTENSIONS) {
      // The bare candidate is only worth trying when the specifier already named an
      // extension; otherwise it is the folder, which the index pass below covers.
      if (extension === '' && !hasExtension) continue;
      if (extension !== '' && hasExtension) continue;
      candidates.push(`${base}${extension}`);
    }
    for (const index of INDEX_BASENAMES) candidates.push(path.posix.join(base, index));
  }

  return [...new Set(candidates)];
}

/**
 * The workspace files a source file imports.
 *
 * @param {object} options
 * @param {string} options.content            The importing file's contents.
 * @param {string} options.path               Its workspace-relative path.
 * @param {string} options.workspaceRoot
 * @param {number} [options.max]              Cap on how many are returned.
 * @returns {Promise<string[]>} Workspace-relative paths, in source order.
 */
async function resolveImports(options) {
  const workspaceRoot = String(options.workspaceRoot || '');
  if (!workspaceRoot) return [];

  const fromRelative = toPosixPath(options.path || '');
  const max = Number.isFinite(options.max) ? Number(options.max) : Infinity;

  /** @type {Set<string>} */
  const resolved = new Set();

  for (const specifier of parseSpecifiers(options.content)) {
    if (resolved.size >= max) break;

    for (const candidate of candidatesFor(specifier, fromRelative)) {
      // Never report the file as importing itself: `./index` from `index.js` resolves
      // straight back, and the caller would read it twice.
      if (candidate === fromRelative) continue;

      // The candidate is built from a workspace-relative path and a fixed extension
      // list, and `..` segments are refused above. The *read* that follows this goes
      // through permissionGate → pathGuard regardless; this stat only decides which
      // path is worth asking the guard about.
      let stats;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        stats = await fs.promises.stat(path.join(workspaceRoot, candidate));
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;

      resolved.add(candidate);
      break;
    }
  }

  return [...resolved].slice(0, Number.isFinite(max) ? max : undefined);
}

module.exports = {
  parseSpecifiers,
  candidatesFor,
  resolveImports,
  SPECIFIER_PATTERNS,
  RESOLUTION_EXTENSIONS,
  INDEX_BASENAMES,
  SOURCE_ALIASES,
};
