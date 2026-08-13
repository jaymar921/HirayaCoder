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

/**
 * Does this path exist on disk with exactly this spelling?
 *
 * `fs.stat` is not the answer, and the difference is a bug that only appears on someone
 * else's machine. Windows and macOS both resolve `./hooks/usetodos.js` to `useTodos.js`
 * and report success, so a model that gets the case wrong produces a file that builds
 * locally and fails on Linux CI or a Linux deploy. The guard would be quietly wrong in
 * the one direction that ships a broken build.
 *
 * So the parent directory is read and the name compared byte-for-byte. `readdir` returns
 * the real spelling regardless of how the lookup was cased, which is the only way to ask
 * this question portably.
 *
 * @param {string} workspaceRoot
 * @param {string} relative  Workspace-relative, posix-separated.
 * @returns {Promise<boolean>}
 */
async function existsExactly(workspaceRoot, relative) {
  const posix = toPosixPath(relative);
  const absolute = path.join(workspaceRoot, posix);

  let stats;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    stats = await fs.promises.stat(absolute);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;

  // Every segment has to match, not only the basename: `./Hooks/useTodos.js` is just as
  // broken on Linux as `./hooks/usetodos.js`.
  const segments = posix.split('/').filter(Boolean);
  let walked = workspaceRoot;

  for (const segment of segments) {
    /** @type {string[]} */
    let names;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      names = await fs.promises.readdir(walked);
    } catch {
      return false;
    }
    if (!names.includes(segment)) return false;
    walked = path.join(walked, segment);
  }

  return true;
}

/** Directories a search for a misplaced file should never descend into. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', '.git', '.hirayacoder', 'dist', 'out', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.venv', 'venv', '__pycache__', 'target', 'vendor',
]);

/** Depth and breadth caps, so a suggestion never costs more than the write it follows. */
const SEARCH_MAX_DEPTH = 5;
const SEARCH_MAX_ENTRIES = 2000;

/**
 * Workspace files whose name matches a specifier's, wherever they actually live.
 *
 * Used only to turn "this import is broken" into "this import is broken, and here is
 * the path that works". The search is by basename stem, because the model almost always
 * has the *name* right and the *route* wrong.
 *
 * @param {string} workspaceRoot
 * @param {string} stem  Basename without extension, lower-cased.
 * @returns {Promise<string[]>} Workspace-relative paths.
 */
async function findByStem(workspaceRoot, stem) {
  /** @type {string[]} */
  const found = [];
  let seen = 0;

  /**
   * @param {string} absolute
   * @param {string} relative
   * @param {number} depth
   */
  async function walk(absolute, relative, depth) {
    if (seen >= SEARCH_MAX_ENTRIES || found.length >= 5) return;

    /** @type {import('fs').Dirent[]} */
    let dirents;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      dirents = await fs.promises.readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (seen >= SEARCH_MAX_ENTRIES || found.length >= 5) return;
      seen += 1;
      const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;

      if (dirent.isDirectory()) {
        if (SKIP_DIRECTORIES.has(dirent.name) || depth >= SEARCH_MAX_DEPTH) continue;
        await walk(path.join(absolute, dirent.name), childRelative, depth + 1);
      } else if (dirent.isFile()) {
        const base = dirent.name.replace(/\.[a-z0-9]{1,6}$/i, '').toLowerCase();
        if (base === stem) found.push(childRelative);
      }
    }
  }

  await walk(workspaceRoot, '', 0);
  return found;
}

/**
 * The relative specifier that would actually reach `target` from `from`.
 *
 * @param {string} from    Workspace-relative path of the importing file.
 * @param {string} target  Workspace-relative path of the file it wants.
 * @returns {string}
 */
function specifierFrom(from, target) {
  const dir = path.posix.dirname(toPosixPath(from));
  const relative = toPosixPath(path.posix.relative(dir === '.' ? '' : dir, toPosixPath(target)));
  return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * Relative imports in a file that point at nothing.
 *
 * ## Why a written file needs this and a read one does not
 *
 * `resolveImports` answers "what else should the model see", and silently dropping a
 * specifier that resolves to nothing is the right answer there. When the model has just
 * *written* the file, the same fact means something entirely different: the file cannot
 * run, and nothing else in the system can tell.
 *
 * Measured on the React benchmark, after step sessions had got `qwen3.5:4b` as far as
 * rewriting `App.jsx` for the first time — it wrote, from inside `src/App.jsx`:
 *
 *     import { useTodos } from '../hooks/useTodos.js';
 *     import { TodoInput } from '../components/TodoInput.jsx';
 *
 * Both climb one level too many. Every guard passed: the file is large, its brackets
 * balance, it exports, it has no placeholder bodies, and the change set grew. The app
 * does not build, and the run was reported as four of four items complete.
 *
 * Bare package specifiers are ignored, because whether `react` is installed is a
 * question about `node_modules` and not about what the model wrote.
 *
 * @param {object} options
 * @param {string} options.content
 * @param {string} options.path            Workspace-relative path of the written file.
 * @param {string} options.workspaceRoot
 * @returns {Promise<Array<{specifier: string, suggestion: string | null}>>}
 */
async function brokenImports(options) {
  const workspaceRoot = String(options.workspaceRoot || '');
  if (!workspaceRoot) return [];

  const from = toPosixPath(options.path || '');
  /** @type {Array<{specifier: string, suggestion: string | null}>} */
  const broken = [];

  for (const specifier of parseSpecifiers(options.content)) {
    // Only the model's own routing is in scope. A bare specifier is a dependency.
    if (!RELATIVE.test(specifier)) continue;

    // `existsExactly`, not `stat` — see its note. A case-wrong import resolves on this
    // machine and fails on Linux, and reporting it as fine is the one wrong answer that
    // ships a broken build.
    let resolves = false;
    for (const candidate of candidatesFor(specifier, from)) {
      if (await existsExactly(workspaceRoot, candidate)) {
        resolves = true;
        break;
      }
    }
    if (resolves) continue;

    const stem = path.posix.basename(specifier).replace(/\.[a-z0-9]{1,6}$/i, '').toLowerCase();
    const matches = stem ? await findByStem(workspaceRoot, stem) : [];
    // Only suggest when there is one obvious answer. Offering three candidate paths to
    // a model that already picked the wrong one is not help. `findByStem` matches
    // case-insensitively and returns the real spelling, which is what makes it the right
    // source for a suggestion when the case is the thing that was wrong.
    broken.push({ specifier, suggestion: matches.length === 1 ? specifierFrom(from, matches[0]) : null });

    if (broken.length >= 5) break;
  }

  return broken;
}

module.exports = {
  parseSpecifiers,
  candidatesFor,
  resolveImports,
  brokenImports,
  findByStem,
  specifierFrom,
  existsExactly,
  SPECIFIER_PATTERNS,
  RESOLUTION_EXTENSIONS,
  INDEX_BASENAMES,
  SOURCE_ALIASES,
};
