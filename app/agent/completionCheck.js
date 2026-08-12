'use strict';

/**
 * Is the model's `done` supported by anything?
 *
 * ## The two ways a session reports success without producing any
 *
 * **It never wrote anything.** Observed repeatedly across an evaluation session, on two
 * models. Asked five separate times, in escalating detail, to convert a Python TODO app
 * into `todoapp.html`, the agent replied:
 *
 *     2 of 2 item(s) completed.
 *     1. Read src/todo_app.py and src/todo_manager.py … — done (no files changed)
 *     2. Convert the Python todo app into an HTML webpage … — done (no files changed)
 *
 * Every word of that is technically accurate — `judgeItem` derives it from evidence and
 * appends the caveat honestly — and a user reading "2 of 2 completed" believes a file
 * exists. The fifth attempt ended with the user typing "nothing changed. again."
 *
 * **It wrote a placeholder.** The file that eventually appeared was 49 lines whose two
 * handlers were:
 *
 *     function deleteTask(taskId) {
 *         // Implement the delete functionality here
 *         console.log("Deleting task:", taskId);
 *     }
 *
 * A change set grew, so nothing downstream had any reason to doubt it. The delete
 * feature the user had asked for three times did not exist.
 *
 * ## Why this is a nudge and not a refusal
 *
 * A model that cannot produce the work will not be argued into producing it, and a loop
 * that refuses `done` indefinitely burns the budget and ends with a worse report than
 * the honest one. So each objection is raised **once**. If the second `done` still has
 * nothing behind it, it is accepted and the existing "no files changed" caveat carries
 * the truth to the user — which is where this started, minus one wasted turn.
 *
 * What the single retry buys is the case that is actually common on small models: the
 * model has read everything it needs, has lost track of the fact that it never wrote,
 * and needs to be told. That one costs one turn and produces the file.
 *
 * @module agent/completionCheck
 */

const { requiresChange } = require('../core/intentRouter');

/**
 * Comments that mark work deferred rather than done.
 *
 * Every one of these is a phrase whose only purpose is to say "not implemented". The
 * bar is deliberately that high: `// TODO` on its own is an ordinary thing to leave in
 * working code, and a check that fired on it would object to half the source files ever
 * written. These have to be *inside* a function body with nothing else of substance
 * around them, which is what `placeholderBodies` establishes.
 */
const PLACEHOLDER_COMMENT =
  // One leading `\s*`, and the optional `TODO` begins with a literal rather than
  // another whitespace quantifier. Two `\s*` either side of an optional group can both
  // claim the same run of spaces, and the engine tries every split: measured at 308 ms
  // on `"// TODO" + 20,000 spaces`, against 0.2 ms here. This runs over every file the
  // agent writes, and a model that emits a long run of whitespace is not a rare event.
  /(?:\/\/|\/\*|#|<!--)\s*(?:TODO\b:?\s+)?(?:implement|add|write|fill\s+in|complete|your\s+code)\b[^\n]*/i;

/** A body that only logs, which is the other shape a stub takes. */
const ONLY_LOGS = /^[\s{}]*(?:console\.log\([^)]*\);?|print\([^)]*\);?|pass|\.\.\.|)\s*$/;

/**
 * Function bodies in the content that contain a deferral comment and no real work.
 *
 * Not a parser, and it does not need to be — it is looking for a specific, blatant
 * shape, and anything it cannot read confidently it declines to report. Braces are
 * matched by counting from the opening one, which is wrong inside a string literal and
 * harmless when it is: the result is a body boundary in the wrong place, and a body that
 * then fails the "nothing but a placeholder" test.
 *
 * **Brace languages only.** Python and its indentation are not handled, and pretending
 * otherwise would be worse than the gap: a body delimited by indentation needs a
 * different scan, and half a scan would report the wrong bodies rather than none. The
 * observed failure was JavaScript inside an HTML file, which this covers; a Python
 * equivalent is worth adding when one is actually seen rather than imagined.
 *
 * @param {string} content
 * @returns {string[]} The placeholder comments found, in order.
 */
function placeholderBodies(content) {
  const text = String(content || '');
  /** @type {string[]} */
  const found = [];

  // `function name(args) {`, `name(args) {`, and arrow bodies.
  const header = /(?:function\s+[\w$]*\s*\([^)]*\)|=>)\s*\{?/g;

  for (const match of text.matchAll(header)) {
    const open = text.indexOf('{', match.index);
    if (open === -1 || open > match.index + match[0].length + 2) continue;

    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i += 1) {
      // Numeric index into a string.
      // eslint-disable-next-line security/detect-object-injection
      const char = text[i];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;

    const body = text.slice(open + 1, close);
    const comment = PLACEHOLDER_COMMENT.exec(body);
    if (!comment) continue;

    // The comment says "not implemented". The question is whether anything else in the
    // body disagrees.
    const withoutComment = body.replace(PLACEHOLDER_COMMENT, '').trim();
    if (ONLY_LOGS.test(withoutComment)) found.push(comment[0].trim());
  }

  return found;
}

/**
 * @typedef {object} CompletionContext
 * @property {string} task            What was asked, verbatim.
 * @property {boolean} changed        Did the change set grow during this run?
 * @property {Array<{path: string, after: string | null}>} written
 *   Files this run created or edited, with their new contents.
 */

/**
 * The objection to raise against a `done`, or null to accept it.
 *
 * @param {CompletionContext} context
 * @returns {string | null}
 */
function objectTo(context) {
  const task = String(context.task || '');

  if (!context.changed) {
    // A request to look at, check, or explain something finishes correctly having
    // written nothing. Objecting there would fire the check on exactly the cases it is
    // most likely to be wrong about.
    if (!requiresChange(task)) return null;

    return (
      'You replied "done", but nothing in the project has actually changed — no file was ' +
      'written, edited, or deleted in this session. Reading a file is not doing the work. ' +
      'If the task still needs a file created or changed, do that now with write_file, sending ' +
      'the COMPLETE contents in "code". If you genuinely believe there is nothing to do, reply ' +
      '"done" again and say plainly in the summary that you changed nothing and why.'
    );
  }

  for (const file of context.written || []) {
    if (typeof file.after !== 'string') continue;
    const placeholders = placeholderBodies(file.after);
    if (placeholders.length === 0) continue;

    return (
      `You replied "done", but ${file.path} still has ${placeholders.length === 1 ? 'a function that was never written' : 'functions that were never written'}: ` +
      `${placeholders.slice(0, 3).map((p) => `"${p}"`).join(', ')}. ` +
      'A comment describing what the code should do is not the code. Send write_file for ' +
      `${file.path} again with those bodies actually implemented — the complete file, every line.`
    );
  }

  return null;
}

module.exports = { objectTo, placeholderBodies, PLACEHOLDER_COMMENT };
