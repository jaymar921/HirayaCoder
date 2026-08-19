'use strict';

/**
 * Read an ASCII folder tree as a list of real paths.
 *
 * People draw the structure they want. It is one of the most common things in a
 * well-written brief and one of the most useful, because unlike prose it is
 * unambiguous — every file, its full path, and very often a comment saying what the
 * file is *for*:
 *
 *     todo-glass-app/
 *     ├── src/
 *     │   ├── components/
 *     │   │   ├── TodoInput.jsx        # Add-todo form
 *     │   │   └── TodoItem.jsx         # Single todo row (edit/delete/toggle)
 *     │   ├── App.jsx                  # Composes layout + components
 *     │   └── main.jsx
 *     └── package.json
 *
 * Until now that block reached the model as fourteen lines of box-drawing characters
 * competing for room in a 1,800-token window, and the model was left to work out which
 * of them were paths. It is a plan, and it can be read as one — `src/components/` plus
 * `TodoInput.jsx` is `src/components/TodoInput.jsx`, from indentation alone.
 *
 * ## The comment column matters more than it looks
 *
 * `# Add-todo form` is the author saying what they expect that file to contain, and it
 * is the best possible thing to hand to a model about to write it.
 *
 * It also, usefully, separates two kinds of entry. In the tree above, `App.jsx` and
 * `index.css` carry comments and `package.json`, `vite.config.js` and `main.jsx` do
 * not — because the first two are files the author expects to be *authored* and the
 * rest are files a scaffolding tool produces. That distinction is the author's own,
 * drawn in their own document, and it is exactly the one needed to decide which
 * existing files may be rewritten and which must be left alone.
 *
 * @module core/fileTree
 */

/** Wider than any real tree; a deeper one is a runaway or a diagram of something else. */
const MAX_DEPTH = 12;

/** A tree with more entries than this is a directory listing pasted by accident. */
const MAX_ENTRIES = 200;

/**
 * Everything a line can carry before the name starts: indent, guides, branch markers.
 *
 * Matched as one run rather than as separate indent and marker groups, which is the
 * second attempt at this and the one that works. The guides differ between the
 * box-drawing form (`│   ├── `), the ASCII form (`|   |-- `), the backtick form
 * (`` `-- ``) and plain spaces, and a brief pasted through two editors often has
 * several of them in the same block. Trying to tell an indent guide from a branch
 * marker means deciding whether the `|` in `|-- src/` is one or the other — and
 * nothing downstream cares, because all that is wanted is *how far in the name
 * starts*.
 */
const PREFIX = /^[\s│|`+\-─├└]*/;

/** How wide one level of indentation is, in characters, in every tree format seen. */
const LEVEL_WIDTH = 4;

/**
 * @typedef {object} TreeEntry
 * @property {string} path      Full path, joined from the enclosing directories.
 * @property {string} name      Just this entry's own name.
 * @property {boolean} isDir
 * @property {string} purpose   The trailing `#` comment, or ''.
 * @property {number} depth
 */

/** A name that is a file or folder rather than prose that happened to be in the block. */
function looksLikeEntry(name) {
  const text = String(name).trim();
  if (!text || text.length > 120) return false;
  // A sentence is not a filename. Spaces are the giveaway: real paths in a tree do not
  // have them often enough to be worth the false positives from prose that does.
  if (/\s/.test(text)) return false;
  // No segment may climb out of the tree. Everything downstream — `pathGuard` on the
  // read, `pathGuard` again on the write — refuses a path that leaves the workspace, so
  // this is not the control that stops it. It is the parser being honest about what it
  // returns: these are paths inside the project the tree describes, and a `..` in one
  // would make that untrue several layers before anything checked.
  if (text.split('/').some((segment) => segment === '..' || segment === '.')) return false;
  return /^[\w.@~-]+(?:\/[\w.@~-]+)*\/?$/.test(text);
}

/**
 * Parse a tree block into entries with full paths.
 *
 * Depth comes from where the entry's *name* starts, not from counting guide characters,
 * because the guides are inconsistent and the column is not.
 *
 * @param {string} text  The tree, with or without surrounding prose and code fences.
 * @returns {TreeEntry[]}
 */
function parse(text) {
  const lines = String(text || '').split(/\r?\n/);

  /** @type {TreeEntry[]} */
  const entries = [];
  /** Directory name at each depth, so a child can be joined onto its parents. */
  /** @type {string[]} */
  const stack = [];
  /** The column each accepted depth started at, so widths need not be assumed. */
  /** @type {number[]} */
  const columns = [];

  for (const raw of lines) {
    if (entries.length >= MAX_ENTRIES) break;

    const line = raw.replace(/\t/g, '    ').replace(/```.*/, '');
    if (!line.trim()) continue;

    const column = PREFIX.exec(line)[0].length;
    const rest = line.slice(column);
    const hash = rest.indexOf('#');
    const name = (hash >= 0 ? rest.slice(0, hash) : rest).trim().replace(/[,;]$/, '');
    const comment = hash >= 0 ? rest.slice(hash + 1).trim() : '';

    if (!looksLikeEntry(name)) {
      // A line that is not an entry ends the tree if we have already started one —
      // otherwise a paragraph after the block would keep being scanned for paths.
      //
      // Unless it is still drawn as part of the tree. A rejected entry inside the
      // drawing — a `..` segment, a name with a space in it — is one line to skip, not a
      // reason to discard everything below it. Ending the tree there would let a single
      // odd line silently drop the rest of the structure.
      const drawn = /[├└│]|\|--|`--/.test(line);
      if (entries.length > 0 && rest.trim() && !drawn) break;
      continue;
    }

    // Depth by column, matched against the columns already accepted. A new column
    // wider than the deepest known one is a new level; a narrower one pops back to
    // whichever level it lines up with.
    let depth = columns.findIndex((known) => known === column);
    if (depth === -1) {
      depth = columns.filter((known) => known < column).length;
      columns[depth] = column;
      columns.length = depth + 1;
    } else {
      columns.length = depth + 1;
    }
    if (depth > MAX_DEPTH) continue;

    const isDir = name.endsWith('/');
    const bare = isDir ? name.slice(0, -1) : name;

    stack.length = depth;
    const path = [...stack, bare].filter(Boolean).join('/');
    if (isDir) stack[depth] = bare;

    entries.push({ path, name: bare, isDir, purpose: String(comment || '').trim(), depth });
  }

  return entries;
}

/**
 * The files a tree names, as paths, with whatever the author said each one is for.
 *
 * @param {string} text
 * @returns {Array<{path: string, purpose: string}>}
 */
function files(text) {
  return parse(text)
    .filter((entry) => !entry.isDir && /\.[a-z][\w]{0,7}$/i.test(entry.name))
    .map((entry) => ({ path: entry.path, purpose: entry.purpose }));
}

/**
 * Does this text contain a drawn tree at all?
 *
 * Two entries at different depths is the smallest thing that is a tree rather than a
 * list of filenames — and a list of filenames must not be read as one, because it has
 * no directories to join onto and every path would come out wrong.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasTree(text) {
  if (!/[├└│]|\|--|\+--/.test(String(text || ''))) return false;
  const entries = parse(text);
  return entries.length >= 2 && new Set(entries.map((entry) => entry.depth)).size >= 2;
}

/**
 * The same text with the drawing taken out, leaving the prose around it.
 *
 * Used when a step is about to write *one* of the files a tree names. The tree has
 * already been read — the paths are known — and leaving it in the prompt is actively
 * harmful: fifteen filenames compete with the one filename in the instruction, and on
 * a 0.8B model recency wins. Measured: asked for `tailwind.config.js` with the tree in
 * front of it, the model returned a `package.json`.
 *
 * What is left behind is the part worth keeping. Around the benchmark brief's tree sits
 * "do not flatten it" and "all todo CRUD operations live in the `useTodos` custom hook,
 * components stay presentational" — real instructions about how the files relate, with
 * no filenames to be distracted by.
 *
 * @param {string} text
 * @returns {string}
 */
function withoutTree(text) {
  const lines = String(text || '').split(/\r?\n/);
  const kept = lines.filter((line) => {
    if (/^\s*```/.test(line)) return false;
    const column = PREFIX.exec(line)[0].length;
    const rest = line.slice(column);
    const hash = rest.indexOf('#');
    const name = (hash >= 0 ? rest.slice(0, hash) : rest).trim();
    return !looksLikeEntry(name);
  });
  // Collapse the run of blank lines the removal leaves behind.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { parse, files, hasTree, withoutTree, looksLikeEntry, MAX_DEPTH, MAX_ENTRIES, LEVEL_WIDTH };
