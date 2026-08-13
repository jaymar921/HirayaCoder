'use strict';

/**
 * Parses one structured action out of whatever a model actually emits.
 *
 * On Tier B this is the narrowest point in the whole system: every action a 1B
 * model takes arrives as a single JSON object through here, and small models are
 * unreliable JSON writers even with Ollama's `format: "json"` constraint. They wrap
 * output in markdown fences, prepend "Sure!", emit trailing prose, use single
 * quotes, or produce two objects when asked for one.
 *
 * Two rules govern everything below:
 *
 *  1. **Recover shape, never invent intent.** Stripping a code fence or ignoring
 *     trailing commentary is recovering shape — the model's decision is untouched.
 *     Guessing that a bare string means `read_file`, or defaulting a missing `path`,
 *     would be inventing intent, and the invented action would then run against the
 *     user's filesystem. A response that cannot be read is a failure, not a puzzle.
 *  2. **Failure is an ordinary outcome.** An unparseable turn resolves to a `done`
 *     action carrying the raw text, so the session ends with the model's words shown
 *     to the user rather than throwing inside the loop.
 *
 * @module core/outputParser
 */

const logger = require('../utils/logger');

/**
 * Every action a Tier B model may emit. The registry is the source of truth for
 * what is *offered* in a given mode; this is the set the parser will recognize at
 * all.
 */
const ACTIONS = new Set([
  'read_file',
  'list_files',
  'search_workspace',
  'write_file',
  'delete_file',
  'create_folder',
  'delete_folder',
  'run_script',
  'run_tests',
  'done',
]);

/** Fields required for each action, beyond `action` itself. */
const REQUIRED_FIELDS = new Map([
  ['read_file', ['path']],
  ['write_file', ['path', 'code']],
  ['delete_file', ['path']],
  ['create_folder', ['path']],
  ['delete_folder', ['path']],
  ['search_workspace', ['query']],
  ['run_script', ['command']],
  ['list_files', []],
  ['run_tests', []],
  ['done', []],
]);

/**
 * Fields an action accepts but does not demand.
 *
 * They need declaring for the same reason the required ones do: schema-constrained
 * decoding will not emit a property the schema does not mention, so an optional field
 * left out here is a field the model on Tier B can never set. `recursive` is the whole
 * safety interlock on `delete_folder` — the tool refuses a non-empty folder without it
 * — so a model that cannot express it would be permanently unable to remove one.
 */
const OPTIONAL_FIELDS = new Map([
  ['delete_folder', ['recursive']],
  // Same reasoning as `recursive`: without `cwd` declared here, a Tier B model has no
  // way to say "run this in the folder I just scaffolded" and falls back to the one
  // phrasing that is guaranteed to be refused, `cd app && npm run build`.
  ['run_script', ['cwd']],
]);

/** Keys that must never be copied out of parsed JSON onto an object. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Longest plausible path. Real ones are far shorter; this only has to be below the
 * length at which a model has clearly written a sentence instead.
 */
const MAX_PATH_LENGTH = 200;

/**
 * @typedef {object} ParsedAction
 * @property {string} action
 * @property {string} [path]
 * @property {string} [query]
 * @property {string} [code]
 * @property {string} [command]
 * @property {string} [cwd]
 * @property {boolean} [recursive]
 * @property {string} [thought]
 * @property {string} [summary]
 */

/**
 * @typedef {object} ParseResult
 * @property {boolean} ok
 * @property {ParsedAction} action   Always present; a `done` action on failure.
 * @property {string} [error]        Why parsing failed, phrased for the user.
 * @property {string} raw
 */

/**
 * Pull the first balanced JSON object out of arbitrary text.
 *
 * A brace-counting scan rather than a regex, because regexes cannot match nested
 * braces — and `code` payloads are full of them. String state is tracked so a brace
 * inside a string literal doesn't end the object early.
 *
 * @param {string} text
 * @returns {string | null}
 */
function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    // Numeric index into a string.
    // eslint-disable-next-line security/detect-object-injection
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/**
 * Strip the wrappers models put around JSON.
 *
 * @param {string} text
 * @returns {string}
 */
function stripWrappers(text) {
  let cleaned = String(text == null ? '' : text).trim();

  // ```json … ``` or ``` … ```
  const fence = /^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i.exec(cleaned);
  if (fence) cleaned = fence[1].trim();

  return cleaned;
}

/**
 * Copy a parsed object's own string fields, refusing prototype-polluting keys.
 *
 * `JSON.parse` itself is safe, but copying `__proto__` from the result onto a new
 * object is not — and this object's fields are model-controlled.
 *
 * @param {Record<string, unknown>} source
 * @returns {Record<string, unknown>}
 */
function pickSafeFields(source) {
  /** @type {Record<string, unknown>} */
  const safe = Object.create(null);
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_KEYS.has(key)) {
      logger.warn(`Ignored forbidden key "${key}" in model output.`);
      continue;
    }
    // `key` is screened against FORBIDDEN_KEYS above and the target is a
    // null-prototype object, which is the entire point of this function.
    // eslint-disable-next-line security/detect-object-injection
    safe[key] = source[key];
  }
  return safe;
}

/**
 * Coerce a field to a trimmed string, or undefined.
 *
 * Small models occasionally emit a number or a single-element array where a string
 * was asked for. That is a shape problem, not an intent problem, so it is repaired.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') return value[0];
  return undefined;
}

/**
 * Is this string shaped like a file path at all?
 *
 * Deliberately permissive about *where* a path points — confinement to the workspace
 * is pathGuard's job, and duplicating it here would put the same rule in two places.
 * This only rejects values that cannot be a path in any filesystem: prose.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isPlausiblePath(value) {
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_PATH_LENGTH) return false;
  // A newline in a path is always a generation artefact.
  if (/[\n\r]/.test(text)) return false;
  // Narrative connectives no path contains.
  if (/->|\bthen\b|\binstead\b|\bbecause\b/i.test(text)) return false;
  // A parenthetical aside is commentary, not a filename.
  if (/\(.*\)/.test(text)) return false;
  // Real paths do have spaces; a run of words does not.
  if (text.split(/\s+/).length > 4) return false;
  return true;
}

/**
 * Build the `done` action used whenever a turn cannot be understood.
 *
 * @param {string} raw
 * @param {string} error
 * @returns {ParseResult}
 */
function failure(raw, error) {
  logger.warn(`Could not parse model action: ${error}`);
  return {
    ok: false,
    error,
    raw,
    action: {
      action: 'done',
      // The raw text is surfaced verbatim so the user sees what the model said,
      // rather than a generic parse error with the content thrown away.
      summary: String(raw || '').trim().slice(0, 2000) || '(the model returned nothing)',
    },
  };
}

/**
 * Parse one action from a model response.
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {Set<string> | string[]} [opts.allowedActions] Restricts the action set,
 *   e.g. Plan mode offering only read-only actions.
 * @returns {ParseResult}
 */
function parseAction(raw, opts = {}) {
  const text = stripWrappers(raw);
  if (text.length === 0) return failure(raw, 'The model returned an empty response.');

  const json = extractJsonObject(text);
  if (!json) return failure(raw, 'The model did not return a JSON object.');

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return failure(raw, `The model returned malformed JSON: ${/** @type {Error} */ (err).message}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure(raw, 'The model returned JSON that is not an object.');
  }

  const fields = pickSafeFields(/** @type {Record<string, unknown>} */ (parsed));

  const action = asString(fields.action);
  if (!action) return failure(raw, 'The model response has no "action" field.');

  const normalized = action.trim().toLowerCase();
  if (!ACTIONS.has(normalized)) {
    return failure(raw, `The model asked for an unknown action: "${action}".`);
  }

  const allowed = opts.allowedActions
    ? opts.allowedActions instanceof Set
      ? opts.allowedActions
      : new Set(opts.allowedActions)
    : null;
  if (allowed && !allowed.has(normalized) && normalized !== 'done') {
    // Structural, not advisory: in Plan mode these tools were never offered, so a
    // request for one is refused rather than gated later.
    return failure(raw, `The action "${normalized}" is not available in this mode.`);
  }

  /** @type {ParsedAction} */
  const result = { action: normalized };
  const thought = asString(fields.thought);
  if (thought) result.thought = thought.trim();
  const summary = asString(fields.summary);
  if (summary) result.summary = summary.trim();

  for (const field of ['path', 'query', 'command', 'cwd']) {
    // `field` comes from a literal array on the line above.
    // eslint-disable-next-line security/detect-object-injection
    const value = asString(fields[field]);
    // `field` comes from a literal array.
    // eslint-disable-next-line security/detect-object-injection
    if (value !== undefined && value.trim().length > 0) result[field] = value.trim();
  }
  // `code` keeps its whitespace — it is file content.
  const code = asString(fields.code);
  if (code !== undefined) result.code = code;

  // A genuine boolean, and only a genuine boolean. `recursive` authorises removing a
  // subtree, so the string "false" — which small models emit routinely, and which is
  // truthy — must not read as consent. Anything that is not exactly `true` or the
  // string "true" leaves the flag unset, and the tool then refuses a non-empty folder,
  // which is the safe direction to be wrong in.
  if (fields.recursive === true || fields.recursive === 'true') result.recursive = true;

  // An empty `code` is a missing one. Observed on `qwen3.5:2b`, which repeatedly
  // emitted `write_file` with `"code": ""` — without this it reaches the gate and
  // comes back as a confusing "0 characters replacing 40" truncation refusal
  // instead of the plain "you did not include the file content".
  if (normalized === 'write_file' && typeof result.code === 'string' && result.code.trim().length === 0) {
    delete result.code;
  }

  // A path that is really a sentence. Schema-constrained decoding requires `path`
  // for a read, so a model with nothing sensible to put there writes prose instead
  // of omitting the field. Observed on `llama3.2:1b`:
  //
  //   "src/greet.js -> README.md (for comparison and understanding of changes
  //    needed in this file was not possible due to empty name being returned by
  //    read_file function, so I will use src/obsolete.js instead...)"
  //
  // Left alone this is worse than a plain refusal: the value flows into the failure
  // observation, comes back to the model as context, and on the next turn the model
  // copies that text into a file. Rejecting it here keeps it out of the loop
  // entirely — and the error deliberately does NOT quote the value back.
  if (result.path !== undefined && !isPlausiblePath(result.path)) {
    return failure(
      raw,
      'The "path" field was a sentence, not a file path. Give just the path relative to the ' +
        'project root, like "src/app.js", and put your reasoning in "thought".'
    );
  }

  const required = REQUIRED_FIELDS.get(normalized) || [];
  // `field` comes from REQUIRED_FIELDS, a module constant.
  // eslint-disable-next-line security/detect-object-injection
  const missing = required.filter((field) => result[field] === undefined);
  if (missing.length > 0) {
    // Never defaulted. A write_file without a path is not a write to some guessed
    // location; it is a response the extension refuses to act on.
    return failure(raw, `The "${normalized}" action is missing: ${missing.join(', ')}.`);
  }

  return { ok: true, action: result, raw };
}

/** Per-field descriptions, so the schema itself carries the contract. */
const FIELD_SCHEMAS = new Map([
  ['path', { type: 'string', description: 'File path relative to the project root, e.g. "src/app.js".' }],
  ['code', { type: 'string', description: 'The COMPLETE new contents of the file — every line, not just the changed part.' }],
  ['query', { type: 'string', description: 'Text to search for across the project.' }],
  ['command', { type: 'string', description: 'The shell command to run.' }],
  [
    'cwd',
    {
      type: 'string',
      description:
        'Optional folder to run the command in, relative to the project root, e.g. "todo-glass-app". ' +
        'Omit it to run at the root. Never use cd.',
    },
  ],
  [
    'recursive',
    {
      type: 'boolean',
      description: 'Set true only to remove a folder that still has files in it, along with everything inside.',
    },
  ],
]);

/**
 * Build a JSON Schema describing one valid action, for Ollama's `format` field.
 *
 * `format: "json"` alone only guarantees *syntactically* valid JSON — the model is
 * free to invent keys, and small models do. Measured on `qwen3.5:0.8b`, asked to
 * edit an 80-byte file: with bare JSON mode it emitted `write_file` with no `path`
 * and a `code` field containing a *description* of the change rather than the file.
 * Across a whole session it never once produced a usable write. With this schema
 * constraining decoding, three runs out of three produced the right action, the right
 * path, and real file content.
 *
 * `anyOf` gives each action its own required fields, so `code` is mandatory for a
 * write without also being demanded of a read.
 *
 * Note this constrains *shape*, never *intent* — the model still chooses the action,
 * the path, and the content. That is the same line the parser draws.
 *
 * @param {Set<string> | string[]} allowedActions The actions offered in this mode.
 * @returns {object} A JSON Schema.
 */
function actionSchema(allowedActions) {
  const allowed = allowedActions instanceof Set ? allowedActions : new Set(allowedActions);
  // `done` is always available: it is how any session ends.
  const actions = [...ACTIONS].filter((name) => allowed.has(name) || name === 'done');

  const branches = actions.map((name) => {
    const required = REQUIRED_FIELDS.get(name) || [];
    /** @type {Record<string, object>} */
    const properties = {
      thought: { type: 'string', description: 'One sentence on why you are doing this.' },
      action: { type: 'string', const: name },
    };
    for (const field of [...required, ...(OPTIONAL_FIELDS.get(name) || [])]) {
      const schema = FIELD_SCHEMAS.get(field);
      if (schema) properties[String(field)] = schema;
    }
    if (name === 'done') {
      properties.summary = { type: 'string', description: 'What you changed, in plain language.' };
    }
    return {
      type: 'object',
      properties,
      required: ['thought', 'action', ...required, ...(name === 'done' ? ['summary'] : [])],
    };
  });

  return { anyOf: branches };
}

/**
 * Extract tool calls from a Tier A native tool-calling response.
 *
 * Ollama returns these already structured, so this only normalizes shape and
 * applies the same prototype-pollution guard to the argument objects.
 *
 * @param {any} message The `message` object from /api/chat.
 * @returns {Array<{name: string, args: Record<string, unknown>, id?: string}>}
 */
function parseToolCalls(message) {
  if (!message || !Array.isArray(message.tool_calls)) return [];

  /** @type {Array<{name: string, args: Record<string, unknown>, id?: string}>} */
  const calls = [];
  for (const call of message.tool_calls) {
    const fn = call && call.function;
    if (!fn || typeof fn.name !== 'string') continue;

    let args = fn.arguments;
    // Some builds return arguments as a JSON string rather than an object.
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        logger.warn(`Tool call "${fn.name}" had unparseable arguments; skipping.`);
        continue;
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};

    calls.push({ name: fn.name, args: pickSafeFields(args), id: call.id });
  }
  return calls;
}

module.exports = {
  parseAction,
  parseToolCalls,
  actionSchema,
  isPlausiblePath,
  MAX_PATH_LENGTH,
  extractJsonObject,
  stripWrappers,
  ACTIONS,
  REQUIRED_FIELDS,
  OPTIONAL_FIELDS,
};
