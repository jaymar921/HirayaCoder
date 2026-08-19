'use strict';

/**
 * Packages the written code imports and the project does not have.
 *
 * ## The measurement
 *
 * A `qwen3.5:0.8b` run got further than any before it: project scaffolded, dependencies
 * installed, twelve of the thirteen required files written. The build then failed with:
 *
 *     Failed to load PostCSS config: Cannot find module 'tailwindcss'
 *
 * The model had written a correct `postcss.config.js` naming `tailwindcss`, and never
 * installed it. The brief did ask — *"Install and configure Tailwind CSS for Vite"* —
 * but the install is a separate action from the file, and the file is the part the model
 * is good at.
 *
 * This is the same shape as everything else in this release. The extension knows both
 * halves already: it wrote the file, so it can read what the file imports, and it can
 * read `package.json` to see what is declared. Nobody has to be asked.
 *
 * ## What it will not do
 *
 * It reads only files **this session wrote**, so it cannot go hunting through a
 * pre-existing project and propose installs nobody asked for. It never proposes a
 * relative import, a Node builtin, or anything already declared. And it does not
 * install anything itself — it returns a list, and the caller puts that through the
 * permission gate like any other command, where a network install always confirms.
 *
 * @module core/missingDeps
 */

/** Node's own modules, which are never dependencies. */
const BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'dgram', 'dns',
  'events', 'fs', 'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'stream', 'string_decoder', 'timers',
  'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib',
]);

/** `import x from 'pkg'`, `import 'pkg'`, `export … from 'pkg'`, `require('pkg')`. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"]([^'"\n]{1,120})['"]/g;

/**
 * A quoted package name inside a config file.
 *
 * PostCSS and Tailwind configs name their plugins as *keys*, not imports —
 * `plugins: { '@tailwindcss/postcss': {} }` — so nothing above finds them, and those are
 * exactly the two files this module exists for.
 */
const CONFIG_FILE = /(?:^|\/)(?:postcss|tailwind|vite|rollup|babel|jest|vitest|eslint)\.config\.[cm]?[jt]s$/i;

/** Keys that live in a config object and are settings rather than plugins. */
const CONFIG_KEYS = new Set([
  'theme', 'extend', 'content', 'darkMode', 'safelist', 'blocklist', 'variants', 'presets',
  'future', 'experimental', 'corePlugins', 'important', 'prefix', 'separator', 'options',
  'parser', 'syntax', 'map', 'from', 'to', 'plugins',
]);

/** Package-name shape: `name`, `@scope/name`, with an optional deep path after it. */
const PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)(?:\/.*)?$/i;

/**
 * The package a specifier belongs to, or '' when it is not one.
 *
 * `react-dom/client` is `react-dom`; `@tailwindcss/postcss` is itself; `./TodoItem.jsx`
 * and `node:fs` are neither.
 *
 * @param {string} specifier
 * @returns {string}
 */
function packageOf(specifier) {
  const text = String(specifier || '').trim();
  if (!text || text.startsWith('.') || text.startsWith('/') || text.startsWith('node:')) return '';
  if (/^[a-z]+:/i.test(text)) return '';
  const match = PACKAGE_NAME.exec(text);
  if (!match) return '';
  const name = match[1];
  if (BUILTINS.has(name)) return '';
  // A bare word with a dot in it is a filename somebody forgot to make relative.
  if (!name.startsWith('@') && /\.(?:jsx?|tsx?|css|json|svg|png)$/i.test(name)) return '';
  return name;
}

/**
 * Every package one file reaches for.
 *
 * @param {string} filePath
 * @param {string} source
 * @returns {string[]}
 */
function packagesIn(filePath, source) {
  const text = String(source || '');
  /** @type {Set<string>} */
  const found = new Set();

  for (const match of text.matchAll(SPECIFIER)) {
    const name = packageOf(match[1]);
    if (name) found.add(name);
  }

  if (CONFIG_FILE.test(String(filePath || ''))) {
    // Plugin *keys*, which are not imports and which nothing above can see. This is the
    // exact file that produced the finding:
    //
    //     export default { plugins: { tailwindcss: {}, autoprefixer: {} } }
    //
    // Restricted to config files, because in ordinary source a word that looks like a
    // package name is usually a class name or an id, and proposing an install for one
    // would be worse than missing it.
    // Greedy, deliberately. Non-greedy stopped at the first `}`, which is the empty
    // options object of the *first* plugin — so `autoprefixer` in
    // `{ tailwindcss: {}, autoprefixer: {} }` was never seen at all.
    const block = /plugins\s*:\s*\{([\s\S]{0,800})\}/.exec(text);
    if (block) {
      for (const match of block[1].matchAll(/(?:^|[,{\s])['"]?(@?[\w.@/-]{3,80})['"]?\s*:/g)) {
        const name = packageOf(match[1]);
        if (name && !CONFIG_KEYS.has(name)) found.add(name);
      }
    }
  }

  return [...found];
}

/**
 * What the written files import that the manifest does not declare.
 *
 * @param {object} options
 * @param {Array<{path: string, source: string}>} options.files  Files this session wrote.
 * @param {string} [options.manifest]  The contents of `package.json`, if there is one.
 * @returns {string[]}  Package names, in the order first seen.
 */
function missing(options) {
  /** @type {Set<string>} */
  const declared = new Set();
  try {
    const manifest = JSON.parse(String(options.manifest || '{}'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(manifest[field] || {})) declared.add(name);
    }
  } catch {
    // A manifest that will not parse is a different problem, and not this one's to solve.
  }

  /** @type {string[]} */
  const wanted = [];
  for (const file of options.files || []) {
    for (const name of packagesIn(file.path, file.source)) {
      if (!declared.has(name) && !wanted.includes(name)) wanted.push(name);
    }
  }
  return wanted;
}

module.exports = { missing, packagesIn, packageOf, BUILTINS, CONFIG_FILE };
