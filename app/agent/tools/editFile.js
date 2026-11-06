'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * The only path read here is the one permissionGate → pathGuard resolved; the write goes
 * through writeFile, which asks the gate again. */

/**
 * Change part of a file: find this text, put that text in its place.
 *
 * ## Why the agent needed it
 *
 * Until 1.2.0 the only way to change a file was `write_file` with the whole file in it.
 * For a large model that is wasteful. For a small one it is the hardest thing it can be
 * asked to do, because it turns "change the tax rate" into "retype 150 lines without
 * dropping one", and retyping is precisely where small models fail. Every guard in
 * `writeFile` exists because a model damaged a file while retyping it: cut off half way,
 * exports dropped, the implementation replaced by an empty object.
 *
 * Measured on machine B with `tools/bench-edit.js` (a 164-line module, four ordinary edit
 * requests, graded by running the file) before this tool existed: `llama3.2:1b` passed
 * 0 of 12. Half of its runs never produced a usable action at all, because the whole file
 * as a JSON string does not fit in the 800 tokens a constrained turn is allowed; most of
 * the rest had every write refused as truncated. One got a broken file past every guard.
 *
 * An edit is a few lines of output instead of the whole file, so it fits, and the lines
 * the model did not mention are never retyped, so they cannot be lost.
 *
 * ## What it does not change
 *
 * The new content is written by `writeFile`, so the path guard, the permission gate, the
 * diff the user approves, the change set, the audit entry and every one of the content
 * guards apply exactly as they do to a whole-file write. This tool decides *what* the new
 * file is; it has no route of its own to the disk.
 *
 * ## Matching
 *
 * Exact first. Then, because small models copy a line's words faithfully and its
 * indentation carelessly, whole lines compared with surrounding whitespace ignored, and
 * the replacement re-indented to where it landed. Never fuzzier than that: an edit that
 * lands on the wrong lines is worse than one refused, and a refusal here says where the
 * closest text is so the next attempt can copy it.
 *
 * @module agent/tools/editFile
 */

const fs = require('fs');

const { toLf } = require('../../utils/platform');
const { redact } = require('../../security/secretsScanner');
const editRegion = require('../../core/editRegion');
const writeFile = require('./writeFile');

/** The same ceiling `read_file` uses. A file it cannot read is not one to edit by search. */
const MAX_FILE_BYTES = 1024 * 1024;

/** Longest `find` accepted. Past this the model is sending the file, and write_file is for that. */
const MAX_FIND_CHARS = 20000;

/** How many places a repeated match lists. */
const MAX_LISTED_MATCHES = 5;

/** Lines shown either side of the closest match when nothing matched. */
const NEARBY_LINES = 2;

/** Below this share of shared words, a line is not called "close". */
const MIN_CLOSENESS = 0.34;

/**
 * Errors from `writeFile` that mean the *content* was refused, and what each one means
 * for an edit. Reworded because writeFile's remedy, "send the COMPLETE file", is the
 * wrong instruction for this tool.
 */
const CONTENT_REFUSALS = new Map([
  ['SUSPICIOUS_TRUNCATION', 'the file would be left with unclosed brackets, or far shorter than it was'],
  ['FULLY_COMMENTED', "most of the file's code would be commented out"],
  ['EXPORTS_REMOVED', 'the file would stop exporting what other files import from it'],
  ['EXPORT_NOT_DEFINED', 'the file would export a name it no longer defines'],
  ['IMPLEMENTATION_REMOVED', 'the file would no longer define any function or class'],
]);

/**
 * @param {string} line
 * @returns {string}
 */
function squash(line) {
  return String(line).trim().replace(/\s+/g, ' ');
}

/**
 * 1-based line number of a character offset.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
function lineAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

/**
 * Every offset where `needle` occurs, up to `limit`.
 *
 * @param {string} text
 * @param {string} needle
 * @param {number} limit
 * @returns {number[]}
 */
function occurrences(text, needle, limit) {
  /** @type {number[]} */
  const found = [];
  let from = 0;
  while (found.length < limit) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    found.push(at);
    from = at + Math.max(1, needle.length);
  }
  return found;
}

/**
 * @typedef {object} Located
 * @property {number} start
 * @property {number} end
 * @property {'exact' | 'loose'} how
 * @property {string} [indentFrom]  For a loose match: the indentation `find` used.
 * @property {string} [indentTo]    And the indentation the file has there.
 */

/**
 * Where `find` is in `text`.
 *
 * @param {string} text  LF line endings.
 * @param {string} find  LF line endings.
 * @returns {{ok: true, at: Located} | {ok: false, reason: 'none' | 'many', lines?: number[]}}
 */
function locate(text, find) {
  const exact = occurrences(text, find, MAX_LISTED_MATCHES + 1);
  if (exact.length === 1) return { ok: true, at: { start: exact[0], end: exact[0] + find.length, how: 'exact' } };
  if (exact.length > 1) return { ok: false, reason: 'many', lines: exact.map((offset) => lineAt(text, offset)) };

  // Whole lines, whitespace ignored. Blank lines at either end of `find` are dropped,
  // since a model wrapping its text in newlines has not changed which lines it means.
  const findLines = find.split('\n');
  while (findLines.length && !findLines[0].trim()) findLines.shift();
  while (findLines.length && !findLines[findLines.length - 1].trim()) findLines.pop();
  if (findLines.length === 0) return { ok: false, reason: 'none' };

  const wanted = findLines.map(squash);
  const lines = text.split('\n');
  const squashed = lines.map(squash);
  /** @type {number[]} */
  const starts = [];
  for (let index = 0; index + wanted.length <= lines.length && starts.length <= MAX_LISTED_MATCHES; index += 1) {
    let matches = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      // eslint-disable-next-line security/detect-object-injection -- numeric indices.
      if (squashed[index + offset] !== wanted[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) starts.push(index);
  }
  if (starts.length > 1) return { ok: false, reason: 'many', lines: starts.map((index) => index + 1) };
  if (starts.length === 0) return { ok: false, reason: 'none' };

  const first = starts[0];
  let start = 0;
  for (let index = 0; index < first; index += 1) start += lines[index].length + 1;
  let end = start;
  for (let index = first; index < first + wanted.length; index += 1) end += lines[index].length + 1;
  end -= 1; // the newline after the last matched line stays where it is

  return {
    ok: true,
    at: {
      start,
      end,
      how: 'loose',
      indentFrom: /^[ \t]*/.exec(findLines[0])[0],
      // eslint-disable-next-line security/detect-object-injection -- numeric index.
      indentTo: /^[ \t]*/.exec(lines[first])[0],
    },
  };
}

/**
 * Re-indent a replacement written at the wrong depth.
 *
 * Only the leading indentation the model used for its `find` is swapped for the file's,
 * line by line, so the structure inside the replacement is kept as written.
 *
 * @param {string} replacement
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
function reindent(replacement, from, to) {
  if (from === to) return replacement;
  return replacement
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      // Relative indentation inside the replacement is kept: only the shared base moves.
      if (line.startsWith(from)) return to + line.slice(from.length);
      return to + line.replace(/^[ \t]*/, '');
    })
    .join('\n');
}

/**
 * The lines most like what the model was looking for, with numbers, so the next attempt
 * can copy them. Empty when nothing is close enough to be worth showing.
 *
 * @param {string} text
 * @param {string} find
 * @param {string} [hint]  The model's stated reason, which names what it meant in words.
 * @returns {string}
 */
function closestLines(text, find, hint = '') {
  // Identifiers split into words, so "tax rate" in the model's reason finds `TAX_RATE`.
  // Measured: `llama3.2:1b` sent `"find": "8%"` for a line reading `const TAX_RATE = 0.08;`,
  // and with only the find to go on there was nothing to point it at.
  const words = new Set(editRegion.wordsOf(`${find}\n${hint}`));
  if (words.size === 0) return '';

  const lines = text.split('\n');
  let best = -1;
  let bestScore = 0;
  lines.forEach((line, index) => {
    const theirs = new Set(editRegion.wordsOf(line));
    if (theirs.size === 0) return;
    let shared = 0;
    for (const word of words) {
      for (const candidate of theirs) {
        if (editRegion.sameWord(word, candidate)) {
          shared += 1;
          break;
        }
      }
    }
    const score = shared / Math.max(1, Math.min(words.size, theirs.size));
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  });
  if (best === -1 || bestScore < MIN_CLOSENESS) return '';

  const from = Math.max(0, best - NEARBY_LINES);
  const to = Math.min(lines.length, best + NEARBY_LINES + 1);
  const width = String(to).length;
  return lines
    .slice(from, to)
    .map((line, offset) => `${String(from + offset + 1).padStart(width)} | ${line}`)
    .join('\n');
}

/**
 * The span an extension-placed edit names, checked against the file as it is now.
 *
 * `lines` is set only by the extension, for a dictated edit (`agentSession._dictateEdit`):
 * the region was chosen by `core/editRegion`, so the place is known exactly and searching
 * for the text again could only find it somewhere else. It cannot come from a model: the
 * parser copies only the fields an action declares, and the native loop maps its
 * arguments by name, so neither carries `lines` through.
 *
 * `find` must still equal what is on those lines now, so an edit planned against a file
 * that has changed since is refused rather than applied to the wrong text.
 *
 * @param {string} text
 * @param {{start: number, end: number}} lines  0-based, inclusive; `end < start` inserts.
 * @param {string} find
 * @returns {Located | null}
 */
function locateLines(text, lines, find) {
  const all = text.split('\n');
  const start = Number(lines.start);
  const end = Number(lines.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > all.length || end >= all.length) return null;

  let offset = 0;
  for (let index = 0; index < start; index += 1) offset += all[index].length + 1;

  if (end < start) {
    // Insertion after line `start - 1`. Nothing is replaced, so nothing can be stale.
    if (find) return null;
    const at = Math.min(offset, text.length);
    return { start: at, end: at, how: 'exact' };
  }

  const current = all.slice(start, end + 1).join('\n');
  if (current !== find) return null;
  return { start: offset, end: offset + current.length, how: 'exact' };
}

/**
 * @param {{path: string, find: string, replace: string, thought?: string, lines?: {start: number, end: number}}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function editFile(args, context) {
  const placed = args.lines && typeof args.lines === 'object';
  if (!placed && (typeof args.find !== 'string' || !args.find.trim())) {
    return {
      ok: false,
      observation:
        'edit_file needs "find": the exact text in the file that you want to change, copied from the file. ' +
        'To write a whole new file, use write_file instead.',
      error: 'MISSING_FIND',
    };
  }
  if (typeof args.replace !== 'string') {
    return {
      ok: false,
      observation: 'edit_file needs "replace": the text to put where "find" was. Use "" to remove it.',
      error: 'MISSING_CONTENT',
    };
  }
  if (args.find.length > MAX_FIND_CHARS) {
    return {
      ok: false,
      observation:
        `"find" is ${args.find.length} characters, which is most of a file. Send only the lines that change, ` +
        'or use write_file to replace the whole file.',
      error: 'EDIT_TOO_LARGE',
    };
  }

  const decision = await context.gate.requestRead({ path: args.path, sessionId: context.sessionId, mode: 'agent' });
  if (!decision.allowed) {
    return { ok: false, observation: `Could not open ${args.path}: ${decision.reason}`, error: decision.code };
  }
  const target = decision.resolved;

  let raw;
  try {
    const stats = await fs.promises.stat(target.absolute);
    if (stats.isDirectory()) {
      return { ok: false, observation: `${target.relative} is a folder, not a file.`, error: 'EISDIR' };
    }
    if (stats.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        observation: `${target.relative} is ${Math.round(stats.size / 1024)}KB, too large to edit this way.`,
        error: 'EDIT_TOO_LARGE',
      };
    }
    raw = await fs.promises.readFile(target.absolute, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return {
        ok: false,
        observation: `${target.relative} does not exist, so there is nothing to edit. To create it, use write_file with its complete contents.`,
        error: 'ENOENT',
      };
    }
    return { ok: false, observation: `Could not read ${target.relative}: ${/** @type {Error} */ (err).message}` };
  }
  if (raw.includes('\0')) {
    return { ok: false, observation: `${target.relative} is a binary file and cannot be edited as text.`, error: 'BINARY' };
  }

  const text = toLf(raw);
  const find = toLf(String(args.find || ''));
  const replace = toLf(args.replace);

  if (squash(find) === squash(replace)) {
    return {
      ok: false,
      observation: 'That edit changes nothing: "find" and "replace" are the same text. Put the NEW text in "replace".',
      error: 'EDIT_NO_CHANGE',
    };
  }

  if (placed) {
    const at = locateLines(text, args.lines, find);
    if (!at) {
      return {
        ok: false,
        observation: `${target.relative} changed since those lines were read, so the edit was not applied.`,
        error: 'EDIT_STALE',
      };
    }
    return applyAt(text, at, replace, args, context, target);
  }

  const found = locate(text, find);
  if (!found.ok && found.reason === 'many') {
    return {
      ok: false,
      observation:
        `That text appears more than once in ${target.relative} (lines ${found.lines.slice(0, MAX_LISTED_MATCHES).join(', ')}). ` +
        'Add the line before or after it to "find" so it matches only the place you mean, and send edit_file again.',
      error: 'EDIT_AMBIGUOUS',
    };
  }
  if (!found.ok) {
    // Redacted like a `read_file` result, since these lines go to the model the same way.
    const nearby = redact(closestLines(text, find, args.thought || ''));
    return {
      ok: false,
      observation: nearby
        ? `Could not find that text in ${target.relative}. The closest lines are:\n${nearby}\n` +
          'Copy the lines you want to change exactly as they appear above, without the line numbers, ' +
          'into "find", and send edit_file again.'
        : `Could not find that text in ${target.relative}, and nothing in it looks similar. ` +
          'Use read_file to see what the file contains now, then copy the exact lines into "find".',
      error: 'EDIT_NOT_FOUND',
    };
  }

  return applyAt(text, found.at, replace, args, context, target);
};

/**
 * Put the replacement in place and write the result through `writeFile`.
 *
 * @param {string} text
 * @param {Located} at
 * @param {string} replace
 * @param {{path: string}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @param {{relative: string}} target
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
async function applyAt(text, at, replace, args, context, target) {
  const replacement = at.how === 'loose' ? reindent(replace, at.indentFrom || '', at.indentTo || '') : replace;
  // An insertion at the very end goes on a line of its own.
  const joiner = at.start === at.end && at.start === text.length && text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  const next = text.slice(0, at.start) + joiner + replacement + text.slice(at.end);
  const line = lineAt(text, at.start);

  const written = await writeFile({ path: args.path, code: next }, context);

  if (!written.ok && CONTENT_REFUSALS.has(written.error)) {
    return {
      ...written,
      observation:
        `Your edit to ${target.relative} was not applied: ${CONTENT_REFUSALS.get(written.error)}. ` +
        'Check that "replace" keeps every bracket, export and definition that "find" had, then send edit_file again.',
    };
  }
  if (!written.ok) return written;

  const note = at.how === 'loose' ? ' (matched with the indentation ignored, and re-indented to fit)' : '';
  return {
    ...written,
    observation: `${written.observation} The edit is at line ${line}${note}.`,
    detail: { ...(written.detail || {}), edit: { line, how: at.how } },
  };
}

module.exports.locate = locate;
module.exports.locateLines = locateLines;
module.exports.reindent = reindent;
module.exports.closestLines = closestLines;
module.exports.CONTENT_REFUSALS = CONTENT_REFUSALS;
module.exports.MAX_FIND_CHARS = MAX_FIND_CHARS;
