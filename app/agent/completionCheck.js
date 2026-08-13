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
 * A promise, in a string the program prints, that the feature does not exist yet.
 *
 * The comment-based check above misses this entirely, and it is what a model actually
 * produced when asked for a working TODO app — twice, in two languages, from the same
 * conversation:
 *
 *     case 1 -> System.out.println("Add feature coming soon.");
 *     case 2 -> System.out.println("Remove feature coming soon.");
 *
 * Both files compiled. Both ran. `TodoManager` was written correctly, with working
 * add/remove/modify, and `TodoApp` never constructed one — so the menu drew, took input,
 * and announced that the three features the prompt had asked for were not ready. The
 * Python conversion reproduced it faithfully, because it was a faithful conversion.
 *
 * Nothing else in the system could see this. There is no comment to find, no function is
 * empty, the change set grew, the compile succeeded, and every guard in `writeFile` is
 * about a file being *damaged* rather than being hollow. The only tell is the program
 * saying so out loud, which is why this matches the sentence rather than the structure.
 *
 * Deliberately not matching a bare "TODO" in a string: a todo *application* prints the
 * word constantly, and that is the exact program this was found in.
 *
 * "placeholder" was in this list for one commit and is gone for the same reason. It is
 * a standard HTML attribute — `<input placeholder="Enter a task...">` — so the pattern
 * fired on the attribute name and reported a perfectly ordinary form field as an
 * unbuilt feature. Every entry here has to be a phrase whose *only* use is announcing
 * that something is missing, and a word that appears in the HTML spec is not one.
 */
const PLACEHOLDER_LITERAL =
  /["'`][^"'`\n]*\b(?:coming\s+soon|not\s+(?:yet\s+)?implemented|implement(?:ation)?\s+pending|to\s+be\s+implemented|feature\s+pending)\b[^"'`\n]*["'`]/i;

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
 * Strings in the content that announce the feature is not built.
 *
 * File-level rather than body-scoped, unlike `placeholderBodies`, because that is where
 * the failure lives: the Java version put these inside a `switch` inside a `main` full
 * of real menu-drawing code, so nothing structural about the enclosing function looked
 * wrong. What is wrong is that the program tells its user the feature is missing.
 *
 * @param {string} content
 * @returns {string[]}
 */
function placeholderLiterals(content) {
  const text = String(content || '');
  /** @type {string[]} */
  const found = [];

  for (const line of text.split('\n')) {
    const match = PLACEHOLDER_LITERAL.exec(line);
    if (match) found.push(match[0].trim());
    if (found.length >= 5) break;
  }

  return found;
}

/** Interactive elements that only do something if script is wired to them. */
const INTERACTIVE_ELEMENT = /<(?:button|input|select|textarea|form)\b/gi;

/** Enough interactive markup that the page is clearly meant to do something. */
const MIN_CONTROLS_FOR_INERT_CHECK = 2;

/**
 * Is this an HTML page whose controls are wired to nothing?
 *
 * The third shape of hollow output, and the one both checks above miss. Produced when
 * asked to convert a working Python TODO app to a web page with "a cool UI":
 *
 *     <button id="addTodoBtn" class="action-button">1. Add TODO</button>
 *     …
 *     <script>
 *         // JavaScript functionality will go here later to implement the full application logic.
 *     </script>
 *
 * Four buttons, styled, laid out, captioned with the menu options from the Python app —
 * and a script block containing one comment. No string says "coming soon", no function
 * body is a placeholder because there are no functions, and the file is 52 lines of
 * real markup. Every existing signal reads it as finished work.
 *
 * The test is structural and narrow: a page with controls and no executable script is
 * a mockup. Pages with no controls are untouched — a static page is a legitimate thing
 * to write — and a single stray `<button>` is not enough, since a "back" link on a
 * content page is not an application.
 *
 * External scripts count as wiring. A page that loads `app.js` has its behaviour
 * somewhere this function cannot see, and guessing would fail exactly the projects that
 * are organised properly.
 *
 * @param {string} content
 * @returns {number} How many unwired controls, or 0 when the page is fine.
 */
function inertControls(content) {
  const text = String(content || '');
  if (!/<html\b|<!doctype\s+html/i.test(text) && !/<body\b/i.test(text)) return 0;

  const controls = (text.match(INTERACTIVE_ELEMENT) || []).length;
  if (controls < MIN_CONTROLS_FOR_INERT_CHECK) return 0;

  // Behaviour delegated to a file this function cannot read: assume it is there.
  if (/<script[^>]*\bsrc\s*=/i.test(text)) return 0;

  // An inline handler is wiring, even if it is unfashionable.
  if (/\bon(?:click|change|submit|input|keyup|keydown)\s*=/i.test(text)) return 0;

  for (const block of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = block[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '')
      .trim();
    if (body.length > 0) return 0;
  }

  return controls;
}

/** Longest restatement of the ask carried into an objection. */
const MAX_RESTATED_TASK_CHARS = 300;

/**
 * The ask, short enough to sit inside an objection.
 *
 * A TODO item is one line and arrives whole. A user's message can be the 5,000-character
 * spec that produced this benchmark, so it is cut — from the head, where a request states
 * what it wants before it elaborates.
 *
 * @param {string} task
 * @returns {string}
 */
function restate(task) {
  const text = String(task || '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_RESTATED_TASK_CHARS ? `${text.slice(0, MAX_RESTATED_TASK_CHARS)}…` : text;
}

/**
 * @typedef {object} CompletionContext
 * @property {string} task            What was asked, verbatim.
 * @property {boolean} changed        Did the change set grow during this run?
 * @property {Array<{path: string, after: string | null}>} written
 *   Files this run created or edited, with their new contents.
 * @property {boolean} [planned]      True when `task` is a TODO item rather than a
 *   message the user typed. See `intentRouter.requiresChange`.
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
    if (!requiresChange(task, { planned: context.planned })) return null;

    // The ask is repeated rather than referred to. By the time this fires the model has
    // spent a dozen turns with file contents filling its context, and on the benchmark
    // both `qwen3.5:4b` and `ornith:9b` answered the previous wording of this objection
    // by asking the *user* what to do — "What would you like me to accomplish?" — with
    // the request still sitting in the first message of the same conversation. A model
    // that has lost the ask cannot act on being told it did not do it.
    const ask = restate(task);

    return (
      `You replied "done", but nothing in the project has actually changed — no file was ` +
      'written, edited, or deleted in this session. Reading a file is not doing the work.\n\n' +
      `What you were asked to do: ${ask}\n\n` +
      'Do it now with write_file, sending the COMPLETE contents in "code". Do not ask what to ' +
      'work on — the task is the line above. If you genuinely believe there is nothing to do, ' +
      'reply "done" again and say plainly in the summary that you changed nothing and why.'
    );
  }

  for (const file of context.written || []) {
    if (typeof file.after !== 'string') continue;

    const announced = placeholderLiterals(file.after);
    if (announced.length > 0) {
      return (
        `You replied "done", but ${file.path} tells the user the feature is missing: ` +
        `${announced.slice(0, 3).join(', ')}. ` +
        'A program that prints "coming soon" instead of doing the thing has not done the thing. ' +
        `Send write_file for ${file.path} again with those branches calling the real code — the ` +
        'complete file, every line. If the logic lives in another class or module, construct it ' +
        'and call it; writing it and never using it is the same as not writing it.'
      );
    }

    const inert = inertControls(file.after);
    if (inert > 0) {
      return (
        `You replied "done", but ${file.path} has ${inert} button(s) or input(s) and no JavaScript ` +
        'behind them — the script block is empty or contains only comments. Nothing on that page does ' +
        `anything when clicked. Send write_file for ${file.path} again with the real logic in the ` +
        '<script> block: the handlers, the array the items live in, and the function that redraws the ' +
        'list. The complete file, every line.'
      );
    }

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

module.exports = {
  objectTo,
  restate,
  placeholderBodies,
  placeholderLiterals,
  inertControls,
  PLACEHOLDER_COMMENT,
  PLACEHOLDER_LITERAL,
  MIN_CONTROLS_FOR_INERT_CHECK,
  MAX_RESTATED_TASK_CHARS,
};
