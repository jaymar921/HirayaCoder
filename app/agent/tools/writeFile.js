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
