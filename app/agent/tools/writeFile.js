'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Paths are resolved and confined by permissionGate → pathGuard before any write;
 * the absolute path used here is the guard's output, not the model's string. */

/**
 * Create or replace a file.
 *
 * The write is proposed to the permission gate, which either asks the user or
 * applies it directly under Auto Edit. Either way the change is recorded in the
 * session's change set so the chat tab can present one grouped diff review.
 *
 * Two details that matter more than they look:
 *
 *  - **Line endings are preserved.** A CRLF file rewritten with LF turns a one-line
 *    change into a whole-file diff, which makes review useless and pollutes git
 *    history. The existing convention is detected and re-applied.
 *  - **A no-op write is not a write.** Small models re-emit a file unchanged fairly
 *    often. Detecting that and skipping saves the user a pointless confirmation and
 *    keeps the diff review honest.
 *
 * @module agent/tools/writeFile
 */

const fs = require('fs');
const path = require('path');

const { detectEol, applyEol, toLf } = require('../../utils/platform');

/** Below this fraction of the original size, a replacement is treated as truncated. */
const SUSPICIOUS_SHRINK_RATIO = 0.2;

/**
 * Files shorter than this are exempt, since a real edit can legitimately gut a
 * two-line file. Kept low deliberately: the live failure destroyed an 80-character
 * file, and small source files are common enough that a high threshold would leave
 * most of them unprotected.
 */
const MIN_LENGTH_FOR_SHRINK_CHECK = 30;

/**
 * Line prefixes that start a comment, per file family.
 *
 * Deliberately a per-extension map rather than one generic set: `#` begins a comment
 * in Python and a heading in Markdown, and `#` in CSS begins an id selector. A
 * generic set would misread whole categories of legitimate files as commented-out.
 */
const COMMENT_PREFIXES = new Map([
  ['.js', ['//', '/*', '*', '*/']],
  ['.mjs', ['//', '/*', '*', '*/']],
  ['.cjs', ['//', '/*', '*', '*/']],
  ['.jsx', ['//', '/*', '*', '*/']],
  ['.ts', ['//', '/*', '*', '*/']],
  ['.tsx', ['//', '/*', '*', '*/']],
  ['.java', ['//', '/*', '*', '*/']],
  ['.c', ['//', '/*', '*', '*/']],
  ['.h', ['//', '/*', '*', '*/']],
  ['.cpp', ['//', '/*', '*', '*/']],
  ['.hpp', ['//', '/*', '*', '*/']],
  ['.cs', ['//', '/*', '*', '*/']],
  ['.go', ['//', '/*', '*', '*/']],
  ['.rs', ['//', '/*', '*', '*/']],
  ['.php', ['//', '/*', '*', '*/', '#']],
  ['.css', ['/*', '*', '*/']],
  ['.scss', ['//', '/*', '*', '*/']],
  ['.py', ['#']],
  ['.rb', ['#']],
  ['.sh', ['#']],
  ['.sql', ['--']],
  ['.lua', ['--']],
]);

/**
 * Split a file into live lines and comment lines, ignoring blanks.
 *
 * @param {string} text
 * @param {string[]} prefixes
 * @returns {{code: number, comment: number}}
 */
function countLines(text, prefixes) {
  let code = 0;
  let comment = 0;
  for (const raw of toLf(text).split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (prefixes.some((prefix) => line.startsWith(prefix))) comment += 1;
    else code += 1;
  }
  return { code, comment };
}

/** Non-blank lines that are not comments. */
function countCodeLines(text, prefixes) {
  return countLines(text, prefixes).code;
}

/** How many live lines a file needs before the comment-out guard applies. */
const MIN_CODE_LINES_FOR_COMMENT_CHECK = 3;

/** Below this share of its original live lines, a file has been gutted. */
const CODE_SURVIVAL_RATIO = 0.5;

/** Extensions where an unclosed brace means the file is broken. */
const BRACE_LANGUAGES = new Set([
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.java', '.c', '.h', '.cpp',
  '.hpp', '.cs', '.go', '.rs', '.php', '.css', '.scss', '.json',
]);

/**
 * Strip strings and comments so brackets inside them are not counted.
 *
 * Not a parser — it does not need to be. It only has to stop a brace inside a string
 * literal from being mistaken for structure, and it is applied identically to the
 * old and new content, so a consistent mistake cancels out.
 *
 * @param {string} text
 * @returns {string}
 */
function stripLiterals(text) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const two = text.slice(index, index + 2);
    if (two === '//') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (two === '/*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    const char = text.charAt(index);
    if (char === '"' || char === "'" || char === '`') {
      index += 1;
      while (index < text.length) {
        if (text.charAt(index) === '\\') {
          index += 2;
          continue;
        }
        if (text.charAt(index) === char) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Are all brackets closed?
 *
 * @param {string} text
 * @returns {boolean}
 */
function bracketsBalanced(text) {
  const pairs = new Map([['}', '{'], [')', '('], [']', '[']]);
  const opens = new Set(['{', '(', '[']);
  /** @type {string[]} */
  const stack = [];
  for (const char of stripLiterals(text)) {
    if (opens.has(char)) stack.push(char);
    else if (pairs.has(char)) {
      if (stack.pop() !== pairs.get(char)) return false;
    }
  }
  return stack.length === 0;
}

/** Extensions where a module's exports are the interface other files depend on. */
const MODULE_LANGUAGES = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

/**
 * How a module publishes itself, if it does.
 *
 * The two systems are tracked separately on purpose: converting one to the other is
 * the failure this detects, and a check that just asked "does it export anything?"
 * would wave it through.
 *
 * @param {string} text
 * @returns {{cjs: boolean, esm: boolean}}
 */
function exportStyles(text) {
  const source = stripLiterals(text);
  return {
    cjs: /\bmodule\s*\.\s*exports\b/.test(source) || /\bexports\s*\.\s*[\w$]+\s*=/.test(source),
    esm: /\bexport\s+(?:default|const|let|var|function|class|async|\{|\*)/.test(source),
  };
}

/**
 * The bare identifiers a module exports — `module.exports = { greet }`, `export { a }`.
 *
 * Only shorthand entries. `{ greet: somethingElse }` names a value that lives
 * elsewhere in the file and is checked by nothing here, deliberately: the point is to
 * catch an export pointing at a symbol that does not exist, not to type-check.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function exportedNames(text) {
  const source = stripLiterals(text);
  /** @type {Set<string>} */
  const names = new Set();

  for (const pattern of [/\bmodule\s*\.\s*exports\s*=\s*\{([^}]*)\}/g, /\bexport\s*\{([^}]*)\}/g]) {
    for (const match of source.matchAll(pattern)) {
      for (const entry of match[1].split(',')) {
        const trimmed = entry.trim();
        if (!trimmed || trimmed.includes(':') || trimmed.includes('...')) continue;
        const name = /^([A-Za-z_$][\w$]*)(?:\s+as\s+[\w$]+)?$/.exec(trimmed);
        if (name) names.add(name[1]);
      }
    }
  }
  return names;
}

/**
 * How many callable definitions a file contains — functions, classes, arrows.
 *
 * Not an exact count and does not need to be: it is compared against the same file's
 * own previous count, so a consistent approximation on both sides answers the only
 * question asked of it — did the implementation survive?
 *
 * @param {string} text
 * @returns {number}
 */
function definitionCount(text) {
  return (stripLiterals(text).match(/\bfunction\b|\bclass\s+[\w$]+|=>/g) || []).length;
}

/**
 * Does this name exist anywhere in the file other than inside the export list?
 *
 * @param {string} text
 * @param {string} name
 * @returns {boolean}
 */
function definesName(text, name) {
  const body = stripLiterals(text)
    .replace(/\bmodule\s*\.\s*exports\s*=\s*\{[^}]*\}/g, '')
    .replace(/\bexport\s*\{[^}]*\}/g, '');

  // Tokenised rather than `new RegExp(`\\b${name}\\b`)`. The name reaches here from a
  // file the model wrote, and building a pattern out of model output is a habit worth
  // not having even when — as here — `exportedNames` has already restricted it to an
  // identifier. Scanning identifiers is also exactly the comparison intended, with no
  // word-boundary subtleties to get wrong.
  return (body.match(/[A-Za-z_$][\w$]*/g) || []).includes(name);
}

/**
 * A compact diff summary. Enough for a confirmation prompt; the real side-by-side
 * diff is rendered by the webview from the change set.
 *
 * @param {string | null} before
 * @param {string} after
 * @returns {{added: number, removed: number, preview: string}}
 */
function summarizeChange(before, after) {
  const beforeLines = before === null ? [] : toLf(before).split('\n');
  const afterLines = toLf(after).split('\n');

  // Trim the common head and tail so the reported counts reflect the edit rather
  // than the file size.
  let head = 0;
  // Numeric indices into arrays.
  // eslint-disable-next-line security/detect-object-injection
  while (head < beforeLines.length && head < afterLines.length && beforeLines[head] === afterLines[head]) head += 1;

  let tail = 0;
  while (
    tail < beforeLines.length - head &&
    tail < afterLines.length - head &&
    beforeLines[beforeLines.length - 1 - tail] === afterLines[afterLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  const removed = beforeLines.length - head - tail;
  const added = afterLines.length - head - tail;
  const changedLines = afterLines.slice(head, afterLines.length - tail).slice(0, 6);

  return {
    added: Math.max(0, added),
    removed: Math.max(0, removed),
    preview: changedLines.join('\n').slice(0, 600),
  };
}

/**
 * @param {{path: string, code: string}} args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function writeFile(args, context) {
  if (typeof args.code !== 'string') {
    return {
      ok: false,
      observation: 'write_file needs the complete new file content in "code".',
      error: 'MISSING_CONTENT',
    };
  }

  // Read the current contents first, both to detect a no-op and to preserve the
  // file's line-ending convention.
  /** @type {string | null} */
  let existing = null;
  const probe = await context.gate.requestRead({
    path: args.path,
    sessionId: context.sessionId,
    // Reads are permitted in every mode; the write below is what mode-checks.
    mode: 'agent',
  });
  if (probe.allowed) {
    try {
      existing = await fs.promises.readFile(probe.resolved.absolute, 'utf8');
    } catch {
      existing = null;
    }
  }

  const isNew = existing === null;
  const eol = isNew ? detectEol(args.code) : detectEol(existing);
  const nextContent = applyEol(args.code, eol);

  // A truncated generation must not be able to obliterate a file. Observed live:
  // `llama3.2:1b` emitted `"code": "{"` for an 80-byte source file, and the write
  // succeeded — leaving a 1-byte file and reporting "+1 / -6 lines" as though that
  // were an ordinary edit.
  //
  // The signal is a replacement drastically smaller than what it replaces. That
  // shape is almost never a real edit, and it is exactly what a cut-off or
  // malformed generation looks like. Refusing costs a legitimate whole-file
  // deletion-by-rewrite, which `delete_file` covers properly anyway.
  if (!isNew && existing.length >= MIN_LENGTH_FOR_SHRINK_CHECK) {
    const ratio = nextContent.length / existing.length;
    if (ratio < SUSPICIOUS_SHRINK_RATIO) {
      return {
        ok: false,
        observation:
          `Refused: the content you sent for ${args.path} is only ${nextContent.length} characters, ` +
          `replacing ${existing.length}. That looks like a truncated response rather than a real edit. ` +
          'Send the COMPLETE updated file in "code" — every line, not just the part you changed. ' +
          'If you actually meant to remove the file, use delete_file instead.',
        error: 'SUSPICIOUS_TRUNCATION',
      };
    }
  }

  // Truncation that the size check cannot see. Observed on `llama3.2:1b`, asked to
  // add a guard clause to an 80-byte module — it returned 79 bytes that stopped
  // mid-file:
  //
  //     function greet(name) {
  //       return name === '' ? 'Hello there' : `Hello ${name}!`;
  //
  // No closing brace, no `module.exports`. The logic was right and the file was
  // ruined, at 99% of the original size, so the shrink ratio could never catch it.
  //
  // Balance is only compared against the file's own starting state: if the original
  // did not balance under this simple scan, the check stays out of the way rather
  // than blocking every edit to a file it cannot read accurately.
  if (!isNew && BRACE_LANGUAGES.has(path.extname(args.path).toLowerCase())) {
    if (bracketsBalanced(existing) && !bracketsBalanced(nextContent)) {
      return {
        ok: false,
        observation:
          `Refused: the content you sent for ${args.path} has unclosed brackets — it stops part-way ` +
          'through the file. Send the COMPLETE file from the first line to the last, including every ' +
          'closing brace and any exports at the end.',
        error: 'SUSPICIOUS_TRUNCATION',
      };
    }
  }

  // The other way a bad generation destroys a file: not by truncating it, but by
  // commenting out every line. Observed live on `qwen3.5:0.8b`, asked to add a guard
  // clause to an 80-byte module — it returned the whole file with `// ` in front of
  // each line. The result parses, exports nothing, and *grew* to 147 bytes, so the
  // shrink guard above could never see it. Every caller of that module breaks, and
  // the diff reads as an ordinary "+6 / -6".
  //
  // A file that had working code and now has none is not an edit anyone asked for.
  // "Comment this file out" is the one legitimate case, and it is rare enough to be
  // worth a refusal the model can read and correct.
  if (!isNew) {
    const prefixes = COMMENT_PREFIXES.get(path.extname(args.path).toLowerCase());
    if (prefixes) {
      const before = countLines(existing, prefixes);
      const after = countLines(nextContent, prefixes);
      const lostCode = before.code - after.code;
      const gainedComments = after.comment - before.comment;

      // The distinction that makes this safe is between code that was *deleted* and
      // code that was *commented out*. Deleting most of a file is a legitimate edit;
      // a refactor that moves a function elsewhere looks exactly like that, and
      // refusing it would be obstruction. Commenting it out is different — the lines
      // do not leave, they reappear as comments, so live lines fall while comment
      // lines rise by a comparable amount. That pairing is the signal.
      //
      // The first version of this guard only caught a file with *no* live code left,
      // and `qwen3.5:0.8b` slipped straight past it by commenting out the function
      // while leaving `module.exports = { greet };` behind — a file that still parses
      // and exports an undefined symbol.
      const gutted = before.code >= MIN_CODE_LINES_FOR_COMMENT_CHECK && after.code < before.code * CODE_SURVIVAL_RATIO;
      const commentedRatherThanDeleted = lostCode > 0 && gainedComments >= lostCode * 0.5;

      if (gutted && commentedRatherThanDeleted) {
        return {
          ok: false,
          observation:
            `Refused: the content you sent for ${args.path} comments out the working code — ` +
            `${before.code} live lines became ${after.code}, with ${gainedComments} new comment lines. ` +
            'The file would parse but do nothing. Send it with the real code still active: change the ' +
            'lines you need to change and leave the rest exactly as they were.',
          error: 'FULLY_COMMENTED',
        };
      }
    }
  }

  // The third way a plausible-looking rewrite ruins a file: it keeps the logic and
  // drops the module's interface. Nothing above can see it — the file is a normal
  // size, its brackets balance, and nothing is commented out.
  //
  // Measured across a full benchmark sweep, four runs on three different models:
  //
  //   llama3.2:1b       function greet(name) { return name === '' ? 'Hello there' : name; }
  //   llama3.2:latest   function greet(name) { return name ? `Hello, ${name}!` : "Hello there"; }
  //
  // — both dropping `module.exports = { greet };` entirely, so every caller breaks
  // with "greet is not a function". And `stable-code:latest`, twice, silently
  // rewriting a CommonJS module to `export default greet;`, which breaks `require`
  // just as thoroughly while still looking like it exports something.
  //
  // The rule is that an edit may change what a module exports, but not stop it being
  // importable the way it was. Its callers were not part of the request.
  //
  // The cost is a legitimate CommonJS→ESM migration, which is a deliberate act across
  // a whole project rather than a side effect of "handle an empty name" — and the
  // refusal explains itself, so a model asked to do that can say so and be believed by
  // the user rather than by this function.
  if (!isNew && MODULE_LANGUAGES.has(path.extname(args.path).toLowerCase())) {
    const before = exportStyles(existing);
    const after = exportStyles(nextContent);

    const lostCjs = before.cjs && !after.cjs;
    const lostEsm = before.esm && !after.esm;

    if (lostCjs || lostEsm) {
      const style = lostCjs ? 'module.exports' : 'export';
      const nowHas = after.cjs || after.esm ? 'a different export style' : 'no exports at all';
      return {
        ok: false,
        observation:
          `Refused: ${args.path} currently publishes its API with ${style}, and the content you sent has ` +
          `${nowHas}. Every file that imports it would break. Keep the existing export statement exactly ` +
          'as it is and change only the code you were asked to change. If removing the export is genuinely ' +
          'part of the task, say so in your summary instead of doing it silently.',
        error: 'EXPORTS_REMOVED',
      };
    }
  }

  // The export survived and now points at nothing. Observed on `qwen3.5:2b`, asked
  // only to handle an empty name:
  //
  //     const greeting = (name) => { … };
  //     module.exports = { greet };
  //
  // It renamed the function and left the export list alone. The file parses, it still
  // has `module.exports`, so the check above is satisfied — and `require('./greet')
  // .greet` is `undefined`. This is the same failure as the commented-out module that
  // kept its exports, arrived at by renaming instead of commenting.
  //
  // Only names the previous version actually defined are checked, so a file that was
  // already broken this way is not made un-editable.
  if (!isNew && MODULE_LANGUAGES.has(path.extname(args.path).toLowerCase())) {
    const orphaned = [...exportedNames(nextContent)].filter(
      (name) => !definesName(nextContent, name) && definesName(existing, name)
    );

    if (orphaned.length > 0) {
      return {
        ok: false,
        observation:
          `Refused: ${args.path} exports ${orphaned.map((n) => `"${n}"`).join(', ')}, but the content you ` +
          `sent no longer defines ${orphaned.length === 1 ? 'it' : 'them'}. Importing the file would give ` +
          'undefined. If you renamed something, update the export list to match; otherwise keep the ' +
          'original names and change only what you were asked to change.',
        error: 'EXPORT_NOT_DEFINED',
      };
    }
  }

  // The module keeps a well-formed `module.exports` and has nothing left to export.
  // Observed on `llama3.2:1b` after this file had already refused two worse attempts —
  // it replaced an 80-byte module with:
  //
  //     module.exports = { name: '' };
  //
  // The export style survives, so the check above passes. The entry has a colon, so it
  // is not a shorthand name and the check above that has nothing to test. 30 against 80
  // bytes clears the shrink ratio, the brackets balance, and nothing is commented out.
  // Every guard in this file waved through the deletion of the entire implementation.
  //
  // The signal is narrow and hard to argue with: the file used to define something
  // callable and now defines nothing at all. That is not an edit to a module, it is its
  // removal — and `delete_file` exists for that, behind a confirmation this would
  // bypass. A data-only module is unaffected, having had no definitions to lose.
  if (!isNew && definitionCount(existing) > 0 && definitionCount(nextContent) === 0) {
    return {
      ok: false,
      observation:
        `Refused: ${args.path} defines no functions or classes any more — the content you sent removed ` +
        'the implementation and kept only the surrounding lines. Send the complete file with its code ' +
        'intact, changing only what you were asked to change. If the file really should be removed, use ' +
        'delete_file.',
      error: 'IMPLEMENTATION_REMOVED',
    };
  }

  if (!isNew && existing === nextContent) {
    // Not an error — the model reached the right state, it just did so already.
    return {
      ok: true,
      observation: `${args.path} already has exactly that content. No change was needed.`,
      detail: { path: args.path, unchanged: true },
    };
  }

  const change = summarizeChange(existing, args.code);
  const decision = await context.gate.requestWrite({
    path: args.path,
    sessionId: context.sessionId,
    mode: context.mode,
    isNew,
    preview: isNew
      ? `New file, ${toLf(args.code).split('\n').length} lines.`
      : `+${change.added} / -${change.removed} lines.`,
    // Both sides of the change travel with the request so the confirmation can offer
    // a real side-by-side diff. A "+7 / -5 lines" summary tells the user how much
    // changed, never whether it is the change they wanted.
    before: existing,
    after: nextContent,
  });

  if (!decision.allowed) {
    return {
      ok: false,
      observation: `The write to ${args.path} was not applied: ${decision.reason}`,
      error: decision.code,
    };
  }

  const target = decision.resolved;
  try {
    await fs.promises.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.promises.writeFile(target.absolute, nextContent, 'utf8');
  } catch (err) {
    return {
      ok: false,
      observation: `Could not write ${target.relative}: ${/** @type {Error} */ (err).message}`,
    };
  }

  if (context.changeSet) {
    context.changeSet.record({
      kind: isNew ? 'create' : 'edit',
      path: target.relative,
      before: existing,
      after: nextContent,
      added: change.added,
      removed: change.removed,
    });
  }

  return {
    ok: true,
    observation: isNew
      ? `Created ${target.relative} (${toLf(args.code).split('\n').length} lines).`
      : `Updated ${target.relative} (+${change.added} / -${change.removed} lines).`,
    detail: { path: target.relative, isNew, ...change },
  };
};

module.exports.summarizeChange = summarizeChange;
module.exports.countCodeLines = countCodeLines;
module.exports.bracketsBalanced = bracketsBalanced;
module.exports.stripLiterals = stripLiterals;
module.exports.SUSPICIOUS_SHRINK_RATIO = SUSPICIOUS_SHRINK_RATIO;
module.exports.MIN_LENGTH_FOR_SHRINK_CHECK = MIN_LENGTH_FOR_SHRINK_CHECK;
module.exports.MIN_CODE_LINES_FOR_COMMENT_CHECK = MIN_CODE_LINES_FOR_COMMENT_CHECK;
module.exports.countLines = countLines;
module.exports.COMMENT_PREFIXES = COMMENT_PREFIXES;
module.exports.exportStyles = exportStyles;
module.exports.exportedNames = exportedNames;
module.exports.definesName = definesName;
module.exports.definitionCount = definitionCount;
