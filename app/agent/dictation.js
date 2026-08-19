'use strict';

/**
 * Ask a small model for the one thing it can actually produce: the contents of a file.
 *
 * ## The measurement this exists for
 *
 * On the React + Vite + Tailwind benchmark, `llama3.2:1b` ended eleven turns out of
 * eleven with `stopReason: "unparseable"` and wrote nothing. That reads as a model too
 * small to code, and it is not what happened. Asked the same question three ways:
 *
 * | How it was asked | What came back |
 * |---|---|
 * | Constrained to the action schema | `{"action":"done","summary":"Toggle Todo Item Complete"}` |
 * | `format: "json"` | `{}` |
 * | In plain words, "reply with the file in a code block" | a complete, correct, exported React component |
 *
 * The model can write the component. It cannot express the *decision* to write it
 * through a JSON action protocol — and schema-constrained decoding makes that worse
 * rather than better, because `done` is the cheapest object that satisfies the grammar.
 * At 1B the protocol is the bottleneck, not the coding.
 *
 * Measured across all three benchmark models, asking in plain words produced a complete
 * file with its exports intact on every single attempt:
 *
 * | Model | `TodoItem.jsx` | `useTodos.js` |
 * |---|---|---|
 * | `llama3.2:1b` | 827 chars, 2s | 1,558 chars, 4s |
 * | `qwen3.5:0.8b` | 3,426 chars, 14s | 1,489 chars, 5s |
 * | `qwen3.5:2b` | 3,406 chars, 73s | 1,334 chars, 19s |
 *
 * ## So the extension stops asking what to do
 *
 * A dictation turn is one where the decision has already been made off-model: the
 * action is `write_file`, the path came from the user's own request, and the only open
 * question is what goes in the file. The model is asked exactly that and nothing else.
 *
 * This is narrower than the agent loop and deliberately so — but note which way it
 * narrows. The model cannot choose the action and cannot choose the path, so a
 * dictation turn can only ever write a file the user's request named. The content still
 * goes through `write_file`, which means the same path guard, the same permission gate,
 * the same change set and the same audit entry as every other write. Nothing is
 * bypassed; one degree of freedom is removed, and it is the degree of freedom small
 * models get wrong.
 *
 * ## What it tells the model about the rest of the project
 *
 * `App.jsx` importing `TodoList` correctly depends on knowing what `TodoList.jsx`
 * exported — and the 0.7.0 session lost an hour to exactly this, with four missing
 * default exports and two prop-name mismatches, each one found only when the user
 * pasted the console error. The extension does not have to ask anybody: it wrote those
 * files minutes ago and can read the exports straight out of them. So every dictation
 * carries the real export list of the files already on disk.
 *
 * @module agent/dictation
 */

const logger = require('../utils/logger');

/** A dictated file is one file. Beyond this, the reply is prose that happens to contain code. */
const MAX_CODE_CHARS = 24000;

/** Shorter than this and the model answered with a shrug rather than a file. */
const MIN_CODE_CHARS = 40;

/** Long enough for a component with its styling; short enough that a runaway reply ends. */
const NUM_PREDICT = 2400;

/** One file's worth of writing, on a CPU-only machine, with headroom. */
const TIMEOUT_MS = 300000;

/** How many sibling files' contracts ride along. Past this the prompt is a directory listing. */
const MAX_RELATED = 8;

/**
 * How much project background a dictation carries.
 *
 * Was 700, which was right when the spec was *only* background — the folder tree and
 * the prose around it, competing with the instruction. It now leads with the
 * requirements this particular file has to satisfy, gathered by `core/fileSpec`, and
 * those are not background: they are the difference between a row component that
 * handles Escape and one that does not.
 *
 * The order the caller assembles it in matters, because the cut is from the tail:
 * requirements first, then the surrounding prose, then the current contents of a file
 * being rewritten. Whatever gets trimmed, the requirements survive.
 */
const MAX_SPEC_CHARS = 1200;

/** How much per-file requirement text rides along. It leads the prompt, so it is paid first. */
const MAX_REQUIREMENT_CHARS = 1000;

/**
 * Fenced code blocks, with or without a language tag.
 *
 * Non-greedy so the first complete block wins: a model that writes the file and then
 * adds "you can test it with:" and a second block must not have the two spliced
 * together.
 */
const FENCE = /```[a-zA-Z0-9+#.-]*[ \t]*\r?\n([\s\S]*?)```/;

/** An unterminated fence — the reply was cut off mid-file by the token budget. */
const OPEN_FENCE = /```[a-zA-Z0-9+#.-]*[ \t]*\r?\n([\s\S]*)$/;

/**
 * Lines that mean a reply is prose about a file rather than the file.
 *
 * Checked only when there is no fence at all. A model that answers "Here is the
 * component:" and then the code is handled by the fence; a model that answers "I would
 * suggest using a library for this" must not have that written to disk as JavaScript.
 */
const PROSE_OPENER = /^(?:here(?:'s| is)|sure|certainly|okay|ok\b|i (?:will|would|can|have)|this (?:file|component|hook)|to (?:create|write|implement)|note that|below is)/i;

/**
 * Pull the file out of a reply.
 *
 * @param {string} reply
 * @returns {{code: string | null, reason: string}}
 */
function extractCode(reply) {
  const text = String(reply || '');
  if (!text.trim()) return { code: null, reason: 'the model replied with nothing' };

  const fenced = FENCE.exec(text);
  if (fenced) {
    const code = fenced[1].replace(/\s+$/, '');
    if (code.trim().length < MIN_CODE_CHARS) return { code: null, reason: 'the code block was empty' };
    return { code: code.slice(0, MAX_CODE_CHARS), reason: '' };
  }

  // An opening fence with no closing one is a reply the token budget cut in half. The
  // half that exists is a truncated file, and writing a truncated file is worse than
  // writing none: it compiles about half the time and fails somewhere else.
  const open = OPEN_FENCE.exec(text);
  if (open) return { code: null, reason: 'the reply was cut off before the code block ended' };

  // No fence anywhere. Accept it only when the whole reply reads as source, which is a
  // real case — some models ignore the fence instruction and simply answer with code.
  const trimmed = text.trim();
  const firstLine = trimmed.split('\n')[0].trim();
  if (PROSE_OPENER.test(firstLine)) return { code: null, reason: 'the model explained the file instead of writing it' };
  const looksLikeCode = /^(?:import |export |const |let |var |function |class |\/\*|\/\/|#|<|\{|@|from |require\()/m.test(
    trimmed
  );
  if (!looksLikeCode || trimmed.length < MIN_CODE_CHARS) {
    return { code: null, reason: 'the reply was not a file' };
  }
  return { code: trimmed.slice(0, MAX_CODE_CHARS), reason: '' };
}

/**
 * What a module offers to whatever imports it.
 *
 * Regex rather than a parser, and that is the right trade here: the consumer is a
 * sentence in a prompt, so a missed export costs a hint and a false one costs a
 * slightly wrong hint. Neither is load-bearing, and neither justifies a dependency.
 *
 * @param {string} source
 * @returns {{default: string, named: string[]}}
 */
function exportsOf(source) {
  const text = String(source || '');
  /** @type {Set<string>} */
  const named = new Set();

  // export function useTodos / export const TodoItem / export class X
  for (const match of text.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    named.add(match[1]);
  }
  // export { a, b as c }
  for (const match of text.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/i).pop();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) named.add(name);
    }
  }

  let byDefault = '';
  const defaultDeclared = /^\s*export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/m.exec(text);
  const defaultNamed = /^\s*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m.exec(text);
  if (defaultDeclared) byDefault = defaultDeclared[1];
  else if (defaultNamed) byDefault = defaultNamed[1];
  else if (/^\s*export\s+default\b/m.test(text)) byDefault = 'default';

  return { default: byDefault, named: [...named] };
}

/**
 * The import contract for files that already exist, as lines for the prompt.
 *
 * @param {Array<{path: string, source: string}>} files
 * @returns {string}
 */
function renderContracts(files) {
  const lines = [];
  for (const file of (files || []).slice(-MAX_RELATED)) {
    const found = exportsOf(file.source);
    const parts = [];
    if (found.default) parts.push(`default export \`${found.default}\``);
    if (found.named.length) parts.push(`named exports ${found.named.map((n) => `\`${n}\``).join(', ')}`);
    lines.push(`- ${file.path} — ${parts.length ? parts.join('; ') : 'no exports found'}`);
  }
  if (!lines.length) return '';
  return (
    'Files that already exist in this project, and exactly what each one exports. ' +
    'Import from them using these names — do not guess, and do not rewrite them:\n' +
    lines.join('\n')
  );
}

/**
 * Compose the request for one file.
 *
 * Everything in it is either the user's own words or something read off the disk. The
 * one thing the prompt does not contain is a suggestion about *what the file should
 * do beyond what was asked* — a small model handed an example writes the example.
 *
 * @param {object} options
 * @param {string} options.path
 * @param {string} [options.purpose]      What the request says this file is for.
 * @param {string} [options.requirements] What the request asks this file to do, gathered
 *   from every section that mentions it. See `core/fileSpec`.
 * @param {string} [options.spec]         The section of the request this file belongs to.
 * @param {string} [options.constraints]  Rules that hold across the whole request.
 * @param {Array<{path: string, source: string}>} [options.related]
 * @param {string} [options.previousError] Why the last attempt at this file was rejected.
 * @returns {string}
 */
function buildPrompt(options) {
  const blocks = [];
  blocks.push(`Write the complete contents of the file ${options.path}.`);

  if (options.purpose) blocks.push(`What this file is for: ${options.purpose}`);

  // What the request asks *this file* to do, gathered from wherever in the request it
  // was written — see `core/fileSpec`. Stated before the background and never labelled
  // as background, because it is the specification: a row component told about Escape
  // and blur is a different component from one that was not.
  if (options.requirements) {
    blocks.push(
      `What this file has to do, taken from the request:\n${String(options.requirements).slice(0, MAX_REQUIREMENT_CHARS)}`
    );
  }

  // The spec is capped hard, and it is capped for a reason worth stating.
  //
  // The first version of this passed the item's whole section, which for the benchmark
  // brief is the folder tree — fifteen filenames. The model read the tree and wrote
  // whichever file it liked: asked for `tailwind.config.js` it returned a
  // `package.json`, and asked for `postcss.config.js` it returned the App component.
  // Nothing was wrong with the files it wrote; they were answers to a different
  // question. A list of other filenames in front of a 0.8B model competes directly with
  // the one filename in the instruction, and recency decides it.
  //
  // So the spec is background, it is short, and the path is restated last.
  if (options.spec) {
    const spec = String(options.spec).trim();
    blocks.push(
      'Background on the project, for context only — do not write any other file from ' +
        `it:\n---\n${spec.length > MAX_SPEC_CHARS ? `${spec.slice(0, MAX_SPEC_CHARS)}…` : spec}\n---`
    );
  }
  if (options.constraints) blocks.push(`Rules for the whole project:\n${options.constraints}`);

  const contracts = renderContracts(options.related);
  if (contracts) blocks.push(contracts);

  if (options.previousError) {
    blocks.push(`Your last attempt at this file was rejected: ${options.previousError}\nWrite it again, in full.`);
  }

  blocks.push(
    `The file to write is ${options.path}, and only that file. ` +
      'Reply with its complete contents inside one ``` code block, and nothing else. ' +
      'No explanation before or after. The file must be complete and runnable on its own — ' +
      'no "..." placeholders, no "rest of the code here", no TODO comments standing in for real code.'
  );

  return blocks.join('\n\n');
}

/**
 * Extensions whose content is recognisable enough to check against the path.
 *
 * This is the mechanical half of the fix above. Telling the model which file to write
 * makes it write the right one *most* of the time; checking that what came back is the
 * kind of file that was asked for makes the remaining times visible instead of writing
 * a `package.json` over a `tailwind.config.js`.
 *
 * Each test is deliberately weak — "is this JSON", "does this contain code" — because a
 * strong one would start rejecting unusual but valid files, and the failure it exists to
 * catch is not subtle.
 *
 * @type {Array<{match: RegExp, ok: (code: string) => boolean, want: string}>}
 */
const KIND_CHECKS = [
  {
    match: /\.json$/i,
    ok: (code) => {
      try {
        JSON.parse(code);
        return true;
      } catch {
        return false;
      }
    },
    want: 'JSON',
  },
  {
    match: /\.(?:js|jsx|mjs|cjs|ts|tsx)$/i,
    // The interesting half is the negative: a JSON document is a valid answer to some
    // question, and never to "write me this module".
    ok: (code) => {
      const text = code.trim();
      if (text.startsWith('{') || text.startsWith('[')) {
        try {
          JSON.parse(text);
          return false;
        } catch {
          /* not JSON after all — an object literal in a module body is fine */
        }
      }
      return /\b(?:import|export|require|function|const|let|var|class|=>)\b/.test(text);
    },
    want: 'JavaScript or TypeScript',
  },
  {
    match: /\.css$/i,
    ok: (code) => !/^\s*import\s+\w+\s+from\s+['"]react/m.test(code) && /[{@]/.test(code),
    want: 'CSS',
  },
  { match: /\.html?$/i, ok: (code) => /<\w+/.test(code), want: 'HTML' },
];

/**
 * Is this the kind of file that was asked for?
 *
 * @param {string} filePath
 * @param {string} code
 * @returns {{ok: boolean, reason: string}}
 */
function matchesPath(filePath, code) {
  const check = KIND_CHECKS.find((candidate) => candidate.match.test(String(filePath)));
  if (!check) return { ok: true, reason: '' };
  if (check.ok(String(code))) return { ok: true, reason: '' };
  return { ok: false, reason: `the reply is not ${check.want}, which is what ${filePath} has to be` };
}

/**
 * Ask for one file, and return what can be written.
 *
 * @param {object} options
 * @param {import('../core/ollamaClient').OllamaClient} options.client
 * @param {string} options.model
 * @param {string} options.path
 * @param {string} [options.purpose]
 * @param {string} [options.spec]
 * @param {string} [options.constraints]
 * @param {Array<{path: string, source: string}>} [options.related]
 * @param {string} [options.previousError]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, code: string, reason: string, durationMs: number}>}
 */
async function dictate(options) {
  const started = Date.now();
  const prompt = buildPrompt(options);

  let raw = '';
  try {
    const response = await options.client.chat(
      {
        model: options.model,
        messages: [{ role: 'user', content: prompt }],
        // No `format`. That is the entire point of this module: the JSON grammar is
        // what a 1B model fails, and there is nothing to constrain here anyway — the
        // reply is a file, and a file is not JSON.
        //
        // No `think` either. A reasoning trace on a hybrid model consumes the budget
        // before the file is written, which `plannerAgent` and `reactLoop` both
        // measured the hard way.
        think: false,
        options: { temperature: 0.1, num_predict: NUM_PREDICT },
      },
      { timeoutMs: TIMEOUT_MS, signal: options.signal }
    );
    raw = (response && response.message && response.message.content) || '';
  } catch (err) {
    const reason = /** @type {Error} */ (err).message || 'the model call failed';
    logger.warn(`Dictation of ${options.path} failed: ${reason}`);
    return { ok: false, code: '', reason, durationMs: Date.now() - started };
  }

  const { code, reason } = extractCode(raw);
  const durationMs = Date.now() - started;
  if (!code) {
    logger.info(`Dictation of ${options.path} produced nothing usable: ${reason}.`);
    return { ok: false, code: '', reason, durationMs };
  }

  const kind = matchesPath(options.path, code);
  if (!kind.ok) {
    logger.info(`Dictation of ${options.path} answered a different question: ${kind.reason}.`);
    return { ok: false, code: '', reason: kind.reason, durationMs };
  }

  logger.info(`Dictated ${options.path}: ${code.length} chars in ${(durationMs / 1000).toFixed(1)}s.`);
  return { ok: true, code, reason: '', durationMs };
}

module.exports = {
  dictate,
  extractCode,
  matchesPath,
  exportsOf,
  renderContracts,
  buildPrompt,
  MAX_CODE_CHARS,
  MIN_CODE_CHARS,
  NUM_PREDICT,
  MAX_RELATED,
  MAX_SPEC_CHARS,
  MAX_REQUIREMENT_CHARS,
};
