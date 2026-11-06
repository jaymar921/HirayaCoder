'use strict';

/**
 * What a source file offers, with the arguments each thing takes, and what an edit to it
 * changed. Read off the text, never asked of a model.
 *
 * ## Why names were not enough
 *
 * `dictation.exportsOf` already lists what a module exports, and it settled one class of
 * failure: the import that names something which does not exist. The class it left open
 * is the call that gets the arguments wrong. The 0.7.0 session lost an hour to four
 * missing default exports *and two prop-name mismatches*, and a list of names says
 * `TodoItem` without saying that it takes `{ todo, onToggle, onDelete }`. A small model
 * that has to guess the props guesses `item` and `onRemove`, and the build is green.
 *
 * It also missed CommonJS outright. `module.exports = { createCart, addItem }` is how
 * both of this repository's own benchmark fixtures are written, and the JavaScript
 * reader looked only for `export`.
 *
 * ## What it is not
 *
 * A parser. Regular expressions over the text, with every result treated as a hint for a
 * prompt: a missed export costs a line of context, a wrong one costs a slightly wrong
 * line. Every expression here is anchored to the start of a line and bounded, and the
 * input is capped before any of them run, because the input is whatever the model wrote.
 *
 * @module core/codeShape
 */

const { toLf } = require('../utils/platform');

/** Past this a file is not read for its shape. The prompt only ever wants the top of it anyway. */
const MAX_SOURCE_CHARS = 200000;

/** How much of one parameter list is kept. Long enough for a props object, short enough for a prompt. */
const MAX_PARAMS_CHARS = 80;

/** Items listed per file before the rest are counted rather than named. */
const MAX_ITEMS = 12;

/**
 * @typedef {object} ShapeItem
 * @property {string} name
 * @property {string} signature   `addItem(cart, product, quantity = 1)`, or `class Cart`.
 * @property {'function' | 'class' | 'value' | 'method'} kind
 * @property {boolean} [isDefault]
 */

/**
 * @param {string} filePath
 * @returns {'js' | 'python' | 'jvm' | null}
 */
function languageOf(filePath) {
  const name = String(filePath || '').toLowerCase();
  if (/\.(?:[cm]?jsx?|tsx?)$/.test(name)) return 'js';
  if (/\.pyi?$/.test(name)) return 'python';
  if (/\.(?:java|kt)$/.test(name)) return 'jvm';
  return null;
}

/**
 * Collapse a parameter list to one short line.
 *
 * @param {string} raw
 * @returns {string}
 */
function tidyParams(raw) {
  const text = String(raw || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\{\s+/g, '{ ')
    .replace(/\s+\}/g, ' }')
    .trim();
  return text.length > MAX_PARAMS_CHARS ? `${text.slice(0, MAX_PARAMS_CHARS - 1).trimEnd()}…` : text;
}

/**
 * The text of a balanced parenthesised list starting at `open`, or null.
 *
 * A scan rather than an expression: parameter lists hold default values, destructuring
 * and nested calls, and `[^)]*` stops at the first of those.
 *
 * @param {string} text
 * @param {number} open  Index of the `(`.
 * @returns {string | null}
 */
function paramsAt(text, open) {
  if (text.charAt(open) !== '(') return null;
  let depth = 0;
  // A parameter list longer than this is not one; the scan gives up rather than walking the file.
  const end = Math.min(text.length, open + 600);
  for (let index = open; index < end; index += 1) {
    const char = text.charAt(index);
    if (char === '(' || char === '{' || char === '[') depth += 1;
    else if (char === ')' || char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return null;
}

/**
 * Every top-level-looking definition in a JavaScript file, by name.
 *
 * @param {string} text
 * @returns {Map<string, ShapeItem>}
 */
function jsDefinitions(text) {
  /** @type {Map<string, ShapeItem>} */
  const found = new Map();
  const add = (name, kind, params) => {
    if (found.has(name)) return;
    const signature = kind === 'class' ? `class ${name}` : kind === 'value' ? name : `${name}(${tidyParams(params)})`;
    found.set(name, { name, signature, kind });
  };

  // function name(…) / async function name(…) / export [default] function name(…)
  for (const match of text.matchAll(/^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:async[ \t]+)?function\*?[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?=\()/gm)) {
    const params = paramsAt(text, match.index + match[0].length);
    add(match[1], 'function', params === null ? '' : params);
  }
  // const name = (…) => / const name = async (…) => / const name = function (…)
  //
  // The function's own name is optional *together with* the spaces before it. Written as
  // `[ \t]*(?:name)?[ \t]*`, two whitespace runs met wherever the name was absent, and
  // `const a = function` followed by 80,000 spaces took 11.6 seconds. Measured, and pinned
  // in test/unit/codeShape.test.js.
  for (const match of text.matchAll(/^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?(?:function\*?(?:[ \t]+[A-Za-z_$][\w$]*)?[ \t]*)?(?=\()/gm)) {
    const params = paramsAt(text, match.index + match[0].length);
    if (params !== null) add(match[1], 'function', params);
  }
  // const name = singleParam => …
  for (const match of text.matchAll(/^[ \t]*(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*=>/gm)) {
    add(match[1], 'function', match[2]);
  }
  // class Name
  for (const match of text.matchAll(/^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?class[ \t]+([A-Za-z_$][\w$]*)/gm)) {
    add(match[1], 'class', '');
  }
  // Any other top-level binding, so an exported constant still has a name to show.
  for (const match of text.matchAll(/^(?:export[ \t]+)?(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/gm)) {
    add(match[1], 'value', '');
  }
  return found;
}

/**
 * What a JavaScript or TypeScript module exports, in either module system.
 *
 * @param {string} text
 * @returns {ShapeItem[]}
 */
function jsShape(text) {
  const definitions = jsDefinitions(text);
  /** @type {Map<string, ShapeItem>} */
  const exported = new Map();
  const take = (name, isDefault = false) => {
    const known = definitions.get(name);
    const item = known ? { ...known } : { name, signature: name, kind: /** @type {'value'} */ ('value') };
    if (isDefault) item.isDefault = true;
    if (!exported.has(name) || isDefault) exported.set(name, item);
  };

  // ES modules.
  for (const match of text.matchAll(/^[ \t]*export[ \t]+(?:async[ \t]+)?(?:function\*?|const|let|var|class)[ \t]+([A-Za-z_$][\w$]*)/gm)) {
    take(match[1]);
  }
  for (const match of text.matchAll(/^[ \t]*export[ \t]+default[ \t]+(?:async[ \t]+)?(?:function\*?|class)[ \t]+([A-Za-z_$][\w$]*)/gm)) {
    take(match[1], true);
  }
  // `(?:;[ \t]*)?` rather than `;?[ \t]*`: with no semicolon, the latter puts two
  // whitespace runs side by side, and a long one cost 9.5 seconds at 40,000 characters.
  for (const match of text.matchAll(/^[ \t]*export[ \t]+default[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?:;[ \t]*)?$/gm)) {
    take(match[1], true);
  }
  for (const match of text.matchAll(/^[ \t]*export[ \t]*\{([^}]{0,2000})\}/gm)) {
    for (const part of match[1].split(',')) {
      const pieces = part.trim().split(/\s+as\s+/i);
      const local = pieces[0];
      const name = pieces[pieces.length - 1];
      if (!/^[A-Za-z_$][\w$]*$/.test(local) || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      if (name === 'default' || name === local) {
        take(local, name === 'default');
        continue;
      }
      // `export { helper as double }` is imported as `double`, so that is the name shown.
      const known = definitions.get(local);
      exported.set(
        name,
        known ? { ...known, name, signature: known.signature.replace(local, name) } : { name, signature: name, kind: 'value' }
      );
    }
  }

  // CommonJS: module.exports = { a, b: c } / module.exports = name / exports.a = …
  const objectExport = /^[ \t]*module\.exports[ \t]*=[ \t]*\{([^}]{0,4000})\}/m.exec(text);
  if (objectExport) {
    for (const part of objectExport[1].split(',')) {
      const [key, value] = part.split(':').map((piece) => piece.trim());
      if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) continue;
      const local = value && /^[A-Za-z_$][\w$]*$/.test(value) ? value : key;
      const known = definitions.get(local);
      exported.set(key, known ? { ...known, name: key, signature: known.signature.replace(local, key) } : { name: key, signature: key, kind: 'value' });
    }
  }
  const singleExport = /^[ \t]*module\.exports[ \t]*=[ \t]*([A-Za-z_$][\w$]*)[ \t]*(?:;[ \t]*)?$/m.exec(text);
  if (singleExport) take(singleExport[1], true);
  for (const match of text.matchAll(/^[ \t]*(?:module\.)?exports\.([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]+)?(?:function\*?[ \t]*[\w$]*[ \t]*)?(?=(\()?)/gm)) {
    const name = match[1];
    if (exported.has(name)) continue;
    const open = match.index + match[0].length;
    const params = match[2] ? paramsAt(text, open) : null;
    if (params !== null) exported.set(name, { name, signature: `${name}(${tidyParams(params)})`, kind: 'function' });
    else take(name);
  }

  return [...exported.values()];
}

/**
 * Top-level functions and classes, and each public class's methods.
 *
 * @param {string} text
 * @returns {ShapeItem[]}
 */
function pythonShape(text) {
  const declared = /^__all__[ \t]*=[ \t]*[[(]([^\])]{0,2000})[\])]/m.exec(text);
  const allowed = declared ? new Set([...declared[1].matchAll(/['"]([A-Za-z_]\w*)['"]/g)].map((match) => match[1])) : null;

  /** @type {ShapeItem[]} */
  const items = [];
  let currentClass = '';
  for (const line of text.split('\n')) {
    const top = /^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(([^)]{0,300})\)?/.exec(line);
    const klass = /^class[ \t]+([A-Za-z_]\w*)/.exec(line);
    const method = /^[ \t]{2,8}(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)[ \t]*\(([^)]{0,300})\)?/.exec(line);
    if (klass) {
      currentClass = klass[1].startsWith('_') ? '' : klass[1];
      if (currentClass && (!allowed || allowed.has(currentClass))) items.push({ name: currentClass, signature: `class ${currentClass}`, kind: 'class' });
      if (allowed && !allowed.has(klass[1])) currentClass = '';
    } else if (top) {
      currentClass = '';
      if (top[1].startsWith('_') || (allowed && !allowed.has(top[1]))) continue;
      items.push({ name: top[1], signature: `${top[1]}(${tidyParams(top[2])})`, kind: 'function' });
    } else if (method && currentClass) {
      const name = method[1];
      if (name.startsWith('_') && name !== '__init__') continue;
      const params = tidyParams(method[2].replace(/^\s*(?:self|cls)\s*,?\s*/, ''));
      const shown = name === '__init__' ? `${currentClass}(${params})` : `${currentClass}.${name}(${params})`;
      items.push({ name: `${currentClass}.${name}`, signature: shown, kind: 'method' });
    } else if (/^\S/.test(line) && !/^(?:#|@)/.test(line)) {
      currentClass = '';
    }
  }
  return items;
}

/**
 * A Java type as it is written before a name: `int`, `List<Item>`, `Map<String, Long>[]`.
 *
 * No free spaces, so it can never compete with the `[ \t]+` that follows it for the same
 * run of whitespace; a space is allowed only inside the angle brackets, which must close.
 * One level of nesting is read; `Map<K, List<V>>` is not, and costs one missing hint.
 */
const JVM_TYPE = '[\\w$.]+(?:<[^\\n()<>]{0,80}(?:<[^\\n()<>]{0,40}>)?[^\\n()<>]{0,20}>)?(?:\\[\\])*';

/**
 * A Java or Kotlin file's public type and its public methods.
 *
 * @param {string} text
 * @returns {ShapeItem[]}
 */
function jvmShape(text) {
  /** @type {ShapeItem[]} */
  const items = [];
  const type = /^[ \t]*public[ \t]+(?:final[ \t]+|abstract[ \t]+|sealed[ \t]+)*(class|interface|enum|record)[ \t]+([A-Za-z_]\w*)/m.exec(text);
  if (type) items.push({ name: type[2], signature: `${type[1]} ${type[2]}`, kind: 'class' });
  // The return type may hold spaces only inside its `<…>`. An earlier version let the type
  // itself contain spaces next to the `[ \t]+` that follows it, and "public" followed by
  // 4,000 spaces took 2.5 seconds, growing with the square. See JVM_TYPE.
  for (const match of text.matchAll(new RegExp(`^[ \\t]+public[ \\t]+(?:(?:static|final|synchronized|abstract)[ \\t]+)*(?:<[^>\\n]{0,80}>[ \\t]+)?(${JVM_TYPE})[ \\t]+([a-zA-Z_]\\w*)[ \\t]*\\(([^)]{0,300})\\)`, 'gm'))) {
    if (/^(?:class|interface|enum|record|new|return)$/.test(match[1].trim())) continue;
    items.push({ name: match[2], signature: `${match[2]}(${tidyParams(match[3])}): ${match[1].trim()}`, kind: 'method' });
  }
  // Constructors: public TypeName(…). One fixed expression and a comparison afterwards,
  // never an expression built from the type's name: a 40,000-character name made the
  // built one invalid and threw.
  if (type) {
    for (const match of text.matchAll(/^[ \t]+public[ \t]+([A-Za-z_]\w{0,80})[ \t]*\(([^)]{0,300})\)/gm)) {
      if (match[1] !== type[2]) continue;
      items.push({ name: `new ${type[2]}`, signature: `new ${type[2]}(${tidyParams(match[2])})`, kind: 'method' });
    }
  }
  return items;
}

/**
 * What a file offers, item by item.
 *
 * @param {string} source
 * @param {string} filePath
 * @returns {ShapeItem[]}
 */
function shapeOf(source, filePath) {
  const language = languageOf(filePath);
  if (!language) return [];
  const text = toLf(String(source || '')).slice(0, MAX_SOURCE_CHARS);
  if (language === 'python') return pythonShape(text);
  if (language === 'jvm') return jvmShape(text);
  return jsShape(text);
}

/**
 * One line for a prompt: `createCart(), addItem(cart, product, quantity = 1), …`.
 *
 * @param {string} source
 * @param {string} filePath
 * @param {{maxItems?: number}} [opts]
 * @returns {string} Empty when nothing was found or the language is unknown.
 */
function describe(source, filePath, opts = {}) {
  const items = shapeOf(source, filePath);
  if (items.length === 0) return '';
  const limit = opts.maxItems || MAX_ITEMS;
  const shown = items.slice(0, limit).map((item) => (item.isDefault ? `default ${item.signature}` : item.signature));
  const more = items.length > limit ? `, and ${items.length - limit} more` : '';
  return `${shown.join(', ')}${more}`;
}

/** Longest code fragment quoted in a change description, per side. */
const MAX_QUOTE_CHARS = 48;

/**
 * Quote a line of code for a memory note.
 *
 * Double quotes, never backticks. `memoryStore.subjectOf` reads a backticked span in a
 * note as the *command* the note is about ("Ran `npm test`"), and a note quoting code in
 * backticks would be filed under a command that never ran and stop superseding the older
 * notes about its own file.
 *
 * @param {string} line
 * @returns {string}
 */
function quote(line) {
  const text = String(line).trim().replace(/\s+/g, ' ').replace(/[`"]/g, "'");
  return `"${text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS - 1)}…` : text}"`;
}

/**
 * The definition a line sits inside: the nearest definition line above it.
 *
 * @param {string[]} lines
 * @param {number} index
 * @param {'js' | 'python' | 'jvm'} language
 * @returns {string}
 */
function enclosingName(lines, index, language) {
  const patterns = {
    js: /^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:async[ \t]+)?(?:function\*?[ \t]+([A-Za-z_$][\w$]*)|(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?(?:\(|function|[A-Za-z_$][\w$]*[ \t]*=>)|class[ \t]+([A-Za-z_$][\w$]*))/,
    python: /^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+([A-Za-z_]\w*)/,
    jvm: new RegExp(`^[ \\t]*(?:public|private|protected)[ \\t]+(?:(?:static|final)[ \\t]+)*(?:${JVM_TYPE}[ \\t]+)?([A-Za-z_]\\w*)[ \\t]*\\(`),
  };
  // eslint-disable-next-line security/detect-object-injection -- language is one of three literals.
  const pattern = patterns[language];
  for (let at = Math.min(index, lines.length - 1); at >= 0 && at >= index - 200; at -= 1) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index.
    const match = pattern.exec(lines[at]);
    if (match) return match[1] || match[2] || match[3] || '';
  }
  return '';
}

/**
 * Describe what an edit changed, in words a later turn can act on, or null when there is
 * nothing it can say for certain.
 *
 * In order of preference: definitions that appeared or disappeared, then a single line
 * that changed (quoted both ways, because "the tax rate changed" is less use to the next
 * step than the line itself), then which definition the changed lines sit in.
 *
 * @param {string | null} before  Null for a new file.
 * @param {string} after
 * @param {string} filePath
 * @returns {string | null}
 */
function describeChange(before, after, filePath) {
  const language = languageOf(filePath);
  if (!language || typeof after !== 'string') return null;

  if (before === null || before === undefined) {
    const offered = describe(after, filePath, { maxItems: 6 });
    return offered ? `provides ${offered}` : null;
  }

  const was = new Map(shapeOf(before, filePath).map((item) => [item.name, item.signature]));
  const now = new Map(shapeOf(after, filePath).map((item) => [item.name, item.signature]));
  const added = [...now.keys()].filter((name) => !was.has(name)).map((name) => now.get(name));
  const removed = [...was.keys()].filter((name) => !now.has(name));
  const resigned = [...now.keys()].filter((name) => was.has(name) && was.get(name) !== now.get(name)).map((name) => now.get(name));

  const parts = [];
  if (added.length) parts.push(`added ${added.slice(0, 3).join(', ')}${added.length > 3 ? ` and ${added.length - 3} more` : ''}`);
  if (removed.length) parts.push(`removed ${removed.slice(0, 3).join(', ')}${removed.length > 3 ? ` and ${removed.length - 3} more` : ''}`);
  if (resigned.length) parts.push(`${resigned.slice(0, 2).join(', ')} now takes different arguments`);
  if (parts.length) return parts.join('; ');

  // Same definitions: say where the change is, and quote it when it is one line.
  const beforeLines = toLf(before).split('\n');
  const afterLines = toLf(after).split('\n');
  let head = 0;
  // eslint-disable-next-line security/detect-object-injection -- numeric indices.
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head += 1;
  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }
  const oldPart = beforeLines.slice(head, beforeLines.length - tail).filter((line) => line.trim());
  const newPart = afterLines.slice(head, afterLines.length - tail).filter((line) => line.trim());
  if (oldPart.length === 0 && newPart.length === 0) return null;

  const where = enclosingName(afterLines, head, language);
  const inside = where ? ` in ${where}` : '';
  if (oldPart.length === 1 && newPart.length === 1) return `${quote(oldPart[0])} became ${quote(newPart[0])}${inside}`;
  if (oldPart.length === 0) return `added ${newPart.length} line(s)${inside}`;
  if (newPart.length === 0) return `removed ${oldPart.length} line(s)${inside}`;
  return where ? `changed ${where} (${oldPart.length} line(s) replaced by ${newPart.length})` : null;
}

module.exports = {
  shapeOf,
  describe,
  describeChange,
  languageOf,
  tidyParams,
  paramsAt,
  MAX_ITEMS,
  MAX_SOURCE_CHARS,
};
