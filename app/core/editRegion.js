'use strict';

/**
 * Which lines of a file a request is about. Found by reading, not by asking.
 *
 * ## Why the extension finds them
 *
 * `edit_file` asks the model to copy the text it wants to change. Measured on
 * `llama3.2:1b` with `tools/bench-edit.js`, it did not: asked to "change the tax rate
 * from 8% to 10%", its first action was an edit with `"find": "8%"`, copied from the
 * request rather than from a file it had not opened. The line was `const TAX_RATE =
 * 0.08;`. Told the text was not there, it lost the JSON format altogether and filled
 * `replace` with the extension's own instructions until the token cap.
 *
 * Copying exact text from a file is precisely what a 1B model is bad at, and finding the
 * right lines is precisely what the extension is good at: the request's words are in the
 * file, spelled as identifiers. `TAX_RATE` is "tax rate" once split; `removeItem` is
 * "remove item". So the extension picks the lines, and the model is asked only to rewrite
 * them (see `agent/dictation.dictateEdit`).
 *
 * ## How
 *
 * Words are split out of identifiers and weighted by how rare they are in this file, so a
 * word on every line (the project's own noun) says nothing about which line. Comments do
 * not score: they describe the code next to them and would otherwise tie with it. A line
 * that *declares* a matching name beats a line that merely uses it. The winner is widened
 * to its whole definition when that is short, because a small model rewrites a whole
 * function more reliably than half of one.
 *
 * A request that names something the file does not have yet ("add `itemCount(cart)`") is
 * an addition, and its region is where additions go: the export list, so the new name can
 * be exported too, or the end of the file.
 *
 * It declines when nothing scores, or when two separate places score the same. Declining
 * hands the request back to the ordinary loop, which is what happened before this existed.
 *
 * @module core/editRegion
 */

const { toLf } = require('../utils/platform');

/** Longest region handed to a model to rewrite. */
const MAX_REGION_LINES = 40;

/** Files longer than this are not searched; the loop handles them as before. */
const MAX_FILE_LINES = 2000;

/** Words that carry no information about where in a file a request points. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'from', 'with', 'that', 'this', 'into', 'when', 'than', 'then', 'them', 'they',
  'make', 'change', 'changes', 'update', 'add', 'set', 'use', 'should', 'would', 'could', 'instead',
  'file', 'code', 'please', 'also', 'just', 'only', 'some', 'there', 'their', 'what', 'which', 'where',
  'are', 'was', 'were', 'has', 'have', 'not', 'but', 'its', 'can', 'all', 'any', 'one', 'new',
  'function', 'method', 'class', 'const', 'returns', 'return', 'value', 'variable', 'src', 'lib', 'app',
]);

/**
 * Lower-case words, with identifiers split: `removeItem` → remove, item; `TAX_RATE` → tax, rate.
 *
 * @param {string} text
 * @returns {string[]}
 */
function wordsOf(text) {
  const out = [];
  for (const token of String(text).slice(0, 20000).match(/[A-Za-z][A-Za-z0-9]{0,60}/g) || []) {
    const parts = token
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/\s+/);
    for (const part of parts) {
      if (part.length >= 3 && !STOPWORDS.has(part)) out.push(part);
    }
  }
  return out;
}

/**
 * Short forms code uses for words people spell out: `MAX_QUANTITY` for "maximum quantity".
 * Only these match on three letters; any other three-letter prefix is too common to mean much.
 */
const ABBREVIATIONS = new Set([
  'max', 'min', 'num', 'len', 'str', 'idx', 'cnt', 'msg', 'err', 'req', 'res', 'btn', 'img', 'tmp',
  'val', 'cfg', 'env', 'pos', 'avg', 'qty', 'amt', 'addr', 'auth', 'conf', 'desc', 'info', 'init',
]);

/**
 * Do two words name the same thing? Exact, one is a four-letter-plus stem of the other
 * ("export" and "exports", "throw" and "throws"), or one is a known short form of the
 * other ("max" and "maximum").
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function sameWord(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 4) return long.startsWith(short);
  return ABBREVIATIONS.has(short) && long.startsWith(short);
}

/**
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isComment(line) {
  return /^\s*(?:\/\/|\/\*|\*|#(?!!)|"""|''')/.test(line);
}

/**
 * Does this line start a statement at its indentation, rather than close one?
 *
 * @param {string} line
 * @returns {boolean}
 */
function opensStatement(line) {
  const text = line.trim();
  if (!text) return false;
  if (/^[)}\]]/.test(text)) return false;
  return !isComment(line);
}

/** The name a line declares, if it declares one. */
const DECLARES =
  /^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(?:(?:async[ \t]+)?(?:function\*?|def|class)|const|let|var|(?:public|private|protected)(?:[ \t]+(?:static|final))*[ \t]+[\w<>[\],]{1,60})[ \t]+([A-Za-z_$][\w$]{0,60})/;

/**
 * A top-level assignment, which is how Python declares a constant. Without it,
 * `LOW_STOCK_THRESHOLD = 5` tied with the line that used it and the request was declined:
 * measured on the held-out inventory suite.
 */
const ASSIGNS = /^([A-Za-z_$][\w$]{0,60})[ \t]*=(?!=)/;

/**
 * @param {string} line
 * @returns {RegExpExecArray | null}
 */
function declarationOf(line) {
  return DECLARES.exec(line) || ASSIGNS.exec(line);
}

/**
 * The smallest block around `index` at or below `indent`: from the statement that opens it
 * to the line before the next statement at the same depth.
 *
 * @param {string[]} lines
 * @param {number} index
 * @param {number} indent
 * @returns {{start: number, end: number}}
 */
function blockAt(lines, index, indent) {
  let start = index;
  while (start > 0 && !(indentOf(lines[start]) <= indent && opensStatement(lines[start]))) start -= 1;

  let end = start;
  for (let at = start + 1; at < lines.length; at += 1) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index.
    const line = lines[at];
    if (!line.trim()) continue;
    if (indentOf(line) <= indent && opensStatement(line)) break;
    // A comment at this depth introduces the next statement; it is not part of this one.
    if (indentOf(line) <= indent && isComment(line)) break;
    end = at;
  }
  return { start, end };
}

/**
 * Identifiers the request names that the file does not contain: `itemCount(cart)`,
 * `` `formatEuro` ``. Their presence makes the request an addition.
 *
 * @param {string} request
 * @param {string} content
 * @returns {string[]}
 */
function newNames(request, content) {
  const names = new Set();
  for (const match of String(request).slice(0, 20000).matchAll(/`([A-Za-z_$][\w$]{1,60})`|\b([A-Za-z_$][\w$]{1,60})\(/g)) {
    names.add(match[1] || match[2]);
  }
  // A set of the file's identifiers rather than a pattern built from each name: the name
  // came from a message, and building expressions out of input is a habit worth not having.
  const present = new Set(String(content).match(/[A-Za-z_$][\w$]*/g) || []);
  return [...names].filter((name) => !present.has(name));
}

/**
 * Names a piece of code declares at its top level.
 *
 * @param {string} code
 * @returns {string[]}
 */
function declaredNames(code) {
  const names = [];
  for (const line of toLf(String(code || '')).split('\n')) {
    if (/^\s/.test(line)) continue;
    const declared = DECLARES.exec(line);
    if (declared) names.push(declared[1]);
  }
  return names;
}

/**
 * An export list with names added, in the list's own layout, or null when the list is not
 * one this can extend safely (`module.exports = {…}` or `export {…}`, one name per entry).
 *
 * Done by the extension rather than asked for. Measured on `llama3.2:1b`: shown the export
 * list and asked to add a function and export it, it added the name to the list and wrote
 * no function, three times out of three. Asked only for the function, it writes the
 * function; putting a name in a list needs no model at all.
 *
 * @param {string} block
 * @param {string[]} names
 * @returns {string | null}
 */
function withExports(block, names) {
  const lines = toLf(block).split('\n');
  if (!EXPORT_BLOCK.test(lines[0])) return null;
  const fresh = names.filter((name) => !new Set(block.match(/[A-Za-z_$][\w$]*/g) || []).has(name));
  if (fresh.length === 0) return block;

  // One line: `module.exports = { a, b };`
  if (lines.length === 1) {
    const close = block.lastIndexOf('}');
    if (close === -1) return null;
    const inner = block.slice(block.indexOf('{') + 1, close).trim().replace(/,$/, '');
    return `${block.slice(0, block.indexOf('{') + 1)} ${[inner, ...fresh].filter(Boolean).join(', ')} ${block.slice(close)}`;
  }

  // Several lines: insert before the closing line, matching the entries' indentation.
  const closing = lines.length - 1;
  if (!/^\s*\}/.test(lines[closing])) return null;
  let last = closing - 1;
  while (last > 0 && !lines[last].trim()) last -= 1;
  const indent = last > 0 ? /^[ \t]*/.exec(lines[last])[0] : '  ';
  // `trimEnd`, not `/\s+$/`: the regex retries from every position in a run of spaces that
  // something follows, so it grows with the square of the line. See the 1.2.0 SAST report.
  if (last > 0 && !/,\s*$/.test(lines[last])) lines[last] = `${lines[last].trimEnd()},`;
  lines.splice(closing, 0, ...fresh.map((name) => `${indent}${name},`));
  return lines.join('\n');
}

/** Where a JavaScript module lists its exports, if it lists them in one place. */
const EXPORT_BLOCK = /^(?:module\.exports[ \t]*=[ \t]*\{|export[ \t]*\{)/;

/**
 * @typedef {object} Region
 * @property {'replace' | 'insert' | 'append'} mode
 *   `replace`: the reply replaces the lines. `insert`: the reply is new code that goes above
 *   the export list (`exportList`). `append`: new code that goes after the last line.
 * @property {number} start   0-based first line.
 * @property {number} end     0-based last line, inclusive.
 * @property {string} text    The lines themselves, joined with LF. Empty for the two additions.
 * @property {string} reason  What placed it, for the log.
 * @property {string[]} [names]  For an addition: the names the request asks for.
 * @property {{start: number, end: number, text: string}} [exportList]
 */

/**
 * The region for an addition: just above the export list when there is one, otherwise the
 * end of the file. The model is asked for the new code only; see `withExports` for why the
 * list itself is left to the extension.
 *
 * @param {string[]} lines
 * @param {string[]} names
 * @returns {Region}
 */
function additionRegion(lines, names, related) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index.
    if (EXPORT_BLOCK.test(lines[index])) {
      const block = blockAt(lines, index, 0);
      // Closing brace included: `blockAt` stops before a line that opens a statement.
      let end = block.end;
      while (end + 1 < lines.length && /^[)}\]]/.test(lines[end + 1].trim())) end += 1;
      if (end - index + 1 <= MAX_REGION_LINES) {
        return {
          mode: 'insert',
          start: index,
          end,
          text: '',
          names,
          related,
          exportList: { start: index, end, text: lines.slice(index, end + 1).join('\n') },
          reason: `adds ${names.join(', ')} above the export list`,
        };
      }
    }
  }
  let last = lines.length - 1;
  while (last > 0 && !lines[last].trim()) last -= 1;
  return { mode: 'append', start: last + 1, end: last, text: '', names, related, reason: `adds ${names.join(', ')} at the end of the file` };
}

/**
 * The region for a new method: the end of the class the request names.
 *
 * Measured on the held-out inventory suite: asked to add `count_products(self)` "to the
 * Inventory class", the request was treated as a file-level addition and the method was
 * appended after the last function in the file, outside any class. The model, shown no
 * class, also wrote one, re-declaring `class Inventory:` with a placeholder comment for its
 * body. Both broke the file. A request that names a class the file declares is about that
 * class's body.
 *
 * @param {string[]} lines
 * @param {string[]} names
 * @param {string} request
 * @returns {Region | null}
 */
function memberRegion(lines, names, request) {
  const mentioned = new Set(String(request).slice(0, 20000).match(/[A-Za-z_$][\w$]{0,60}/g) || []);
  for (let index = 0; index < lines.length; index += 1) {
    // eslint-disable-next-line security/detect-object-injection -- numeric index.
    const match = /^([ \t]*)(?:export[ \t]+(?:default[ \t]+)?)?class[ \t]+([A-Za-z_$][\w$]{0,60})/.exec(lines[index]);
    if (!match || !mentioned.has(match[2])) continue;

    const block = blockAt(lines, index, indentOf(lines[index]));
    let end = block.end;
    // A brace language's class closes with `}`; the new method goes before it.
    while (end + 1 < lines.length && /^[)}\]];?$/.test(lines[end + 1].trim())) end += 1;
    const closes = /^\s*\}/.test(lines[end]) && end > index;
    const insertAt = closes ? end : end + 1;
    const body = lines.slice(index + 1, end + 1).find((line) => line.trim() && !/^\s*\}/.test(line));
    const indent = body ? /^[ \t]*/.exec(body)[0] : `${match[1]}    `;

    // The class's own most relevant method, as the example to follow.
    const own = lines.slice(index + 1, insertAt);
    const related = relatedDefinition(own, request, '') || '';
    return {
      mode: 'member',
      start: insertAt,
      end: insertAt - 1,
      text: '',
      names,
      className: match[2],
      indent,
      related,
      reason: `adds ${names.join(', ')} to class ${match[2]}`,
    };
  }
  return null;
}

/** Longest existing definition shown beside an addition, as an example of the file's own code. */
const MAX_RELATED_LINES = 20;

/**
 * The existing definition most like what is being added, for the model to copy the file's
 * conventions from.
 *
 * Measured on `llama3.2:1b`: asked to add `itemCount(cart)` returning the total quantity,
 * it wrote `cart.reduce(…)`, since nothing it was shown said a cart keeps its items in
 * `cart.items`. `subtotal(cart)`, one screen up, is `cart.items.reduce(…)`. The function
 * that already does nearly the same thing is the best explanation of the data there is.
 *
 * @param {string[]} lines
 * @param {string} request
 * @param {string} filePath
 * @returns {string}
 */
function relatedDefinition(lines, request, filePath) {
  const scored = scoreLines(lines, request, filePath);
  if (!scored) return '';
  let best = -1;
  scored.scores.forEach((score, index) => {
    // eslint-disable-next-line security/detect-object-injection -- numeric index.
    if (score > 0 && !EXPORT_BLOCK.test(lines[index]) && (best === -1 || score > scored.scores[best])) best = index;
  });
  if (best === -1) return '';
  // The largest enclosing definition that still fits, so inside a class this finds the
  // method rather than the whole class.
  /** @type {{start: number, end: number} | null} */
  let found = null;
  for (let depth = indentOf(lines[best]); depth >= 0; depth -= 2) {
    const block = blockAt(lines, best, depth);
    let end = block.end;
    while (end + 1 < lines.length && /^[)}\]];?$/.test(lines[end + 1].trim())) end += 1;
    if (end - block.start + 1 > MAX_RELATED_LINES) break;
    if (declarationOf(lines[block.start]) && !EXPORT_BLOCK.test(lines[block.start])) found = { start: block.start, end };
  }
  if (!found) return '';
  return lines.slice(found.start, found.end + 1).join('\n');
}

/**
 * Score every line by the request's words, weighted by rarity in this file.
 *
 * @param {string[]} lines
 * @param {string} request
 * @param {string} [filePath]
 * @returns {{scores: number[], weight: Map<string, number>, lineWords: Array<Set<string>>, wanted: string[]} | null}
 */
function scoreLines(lines, request, filePath) {
  // "Fix the bug in src/cart.js" names the file, and the file's own noun is on half its
  // lines. Matching on it picked a function at random.
  const pathWords = new Set(wordsOf(String(filePath || '')));
  const wanted = [...new Set(wordsOf(request))].filter((word) => !pathWords.has(word));
  if (wanted.length === 0) return null;

  const lineWords = lines.map((line) => (isComment(line) ? new Set() : new Set(wordsOf(line))));

  // How many lines each wanted word appears on. A word on a third of the file is noise.
  const weight = new Map();
  for (const word of wanted) {
    let frequency = 0;
    for (const words of lineWords) {
      for (const candidate of words) {
        if (sameWord(word, candidate)) {
          frequency += 1;
          break;
        }
      }
    }
    if (frequency === 0 || frequency > lines.length / 3) continue;
    weight.set(word, Math.log(1 + lines.length / frequency));
  }
  if (weight.size === 0) return null;

  /** @type {number[]} */
  const scores = lineWords.map((words, index) => {
    // eslint-disable-next-line security/detect-object-injection -- numeric index.
    const declared = declarationOf(lines[index]);
    const declaredWords = declared ? wordsOf(declared[1]) : [];
    let score = 0;
    for (const [word, value] of weight) {
      let hit = false;
      for (const candidate of words) {
        if (sameWord(word, candidate)) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      score += value;
      // The line that declares the name is the place the name is *about*.
      if (declaredWords.some((candidate) => sameWord(word, candidate))) score += value / 2;
    }
    return score;
  });
  return { scores, weight, lineWords, wanted };
}

/**
 * Find the lines of `content` that `request` is about.
 *
 * @param {string} content
 * @param {string} request
 * @param {{path?: string}} [opts]  The file's own path, whose words say nothing about where in it.
 * @returns {Region | null}
 */
function locate(content, request, opts = {}) {
  const text = toLf(String(content || ''));
  const lines = text.split('\n');
  if (lines.length === 0 || lines.length > MAX_FILE_LINES) return null;

  const adding = newNames(request, text);
  if (adding.length > 0) {
    return (
      memberRegion(lines, adding, request) || additionRegion(lines, adding, relatedDefinition(lines, request, opts.path))
    );
  }

  const scored = scoreLines(lines, request, opts.path);
  if (!scored) return null;
  const { scores, weight, lineWords, wanted } = scored;

  let best = -1;
  scores.forEach((score, index) => {
    // eslint-disable-next-line security/detect-object-injection -- numeric index.
    if (score > 0 && (best === -1 || score > scores[best])) best = index;
  });
  if (best === -1) return null;

  // Widen: the line's own statement, then its enclosing definition while that stays short.
  let region = { start: best, end: best };
  const ownIndent = indentOf(lines[best]);
  for (let depth = ownIndent; depth >= 0; depth -= 2) {
    const block = blockAt(lines, best, depth);
    if (block.end - block.start + 1 > MAX_REGION_LINES) break;
    region = block;
    if (depth === 0) break;
  }
  // The definition's closing line belongs to it.
  while (region.end + 1 < lines.length && /^[)}\]];?$/.test(lines[region.end + 1].trim()) && indentOf(lines[region.end + 1]) <= indentOf(lines[region.start])) {
    region.end += 1;
    if (region.end - region.start + 1 >= MAX_REGION_LINES) break;
  }

  // A second place, outside this region, that scores just as high: a guess, not a finding.
  for (let index = 0; index < scores.length; index += 1) {
    if (index >= region.start && index <= region.end) continue;
    // eslint-disable-next-line security/detect-object-injection -- numeric index.
    if (scores[index] === scores[best]) return null;
  }

  const hits = wanted.filter((word) => weight.has(word) && [...lineWords[best]].some((candidate) => sameWord(word, candidate)));
  return {
    mode: 'replace',
    start: region.start,
    end: region.end,
    text: lines.slice(region.start, region.end + 1).join('\n'),
    reason: `line ${best + 1} matched ${hits.join(', ')}`,
  };
}

module.exports = {
  locate,
  wordsOf,
  sameWord,
  blockAt,
  newNames,
  declaredNames,
  withExports,
  MAX_REGION_LINES,
  MAX_FILE_LINES,
};
