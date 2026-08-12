'use strict';

/**
 * The one declaration of what tools exist, shared by both loop strategies.
 *
 * `nativeToolLoop` renders these as Ollama function schemas; `reactLoop` renders
 * the same entries as the action list in its JSON prompt. Having one source means a
 * tool cannot exist on one tier and not the other, and — more importantly — that
 * mode filtering happens in exactly one place.
 *
 * ## Mode filtering is structural
 *
 * `PROMPT.md` is emphatic that Ask and Plan must not merely *gate* mutations; the
 * tools must be absent from what the model is offered. `forMode()` is where that
 * happens. In Plan mode `write_file` is not in the returned array, so it is not in
 * the schema sent to the model, not in the action list in the prompt, and not
 * dispatchable by the executor. A Plan-mode model asking to write gets a refusal
 * from the parser, not a permission prompt.
 *
 * The permission gate still refuses mutations outside Agent mode, but that is a
 * backstop for a loop bug — not the mechanism.
 *
 * @module agent/toolRegistry
 */

const readFile = require('./tools/readFile');
const writeFile = require('./tools/writeFile');
const deleteFile = require('./tools/deleteFile');
const listFiles = require('./tools/listFiles');
const searchWorkspace = require('./tools/searchWorkspace');
const runScript = require('./tools/runScript');
const runTests = require('./tools/runTests');

/**
 * @typedef {object} ToolDefinition
 * @property {string} name          The action name, e.g. 'write_file'.
 * @property {string} description   Shown to the model.
 * @property {object} parameters    JSON Schema for the arguments.
 * @property {boolean} mutating     True if it can change the workspace or run code.
 * @property {(args: object, context: ToolContext) => Promise<ToolResult>} handler
 */

/**
 * @typedef {object} ToolContext
 * @property {string} workspaceRoot
 * @property {import('../security/permissionGate').PermissionGate} gate
 * @property {string} [sessionId]
 * @property {'agent' | 'plan' | 'ask'} mode
 * @property {import('../agent/agentSession').ChangeSet} [changeSet]
 * @property {number} [maxObservationTokens]
 * @property {AbortSignal} [signal]
 */

/**
 * @typedef {object} ToolResult
 * @property {boolean} ok
 * @property {string} observation   Fed back to the model as the next turn's input.
 * @property {string} [error]
 * @property {object} [detail]      Structured data for the UI, never for the model.
 */

/** @type {ToolDefinition[]} */
const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace. Use this before editing a file you have not seen.',
    mutating: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path, e.g. src/app.js' },
      },
      required: ['path'],
    },
    handler: readFile,
  },
  {
    name: 'list_files',
    description: 'List files and folders in the workspace, to find out what exists.',
    mutating: false,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative folder to list. Omit for the workspace root.' },
      },
      required: [],
    },
    handler: listFiles,
  },
  {
    name: 'search_workspace',
    description: 'Search the workspace for a string and get back matching files and lines.',
    mutating: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
      },
      required: ['query'],
    },
    handler: searchWorkspace,
  },
  {
    name: 'write_file',
    description:
      'Create or replace a file. "code" must be the COMPLETE new contents of the file — not a diff, not a fragment, not a description of the change. If the file already exists, read_file it first.',
    mutating: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        code: { type: 'string', description: 'The complete new contents of the file.' },
      },
      required: ['path', 'code'],
    },
    handler: writeFile,
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the workspace. Only when the task clearly calls for it.',
    mutating: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
      },
      required: ['path'],
    },
    handler: deleteFile,
  },
  {
    name: 'run_script',
    description:
      'Run a single shell command such as `npm install` or `npm run build`. One command only — no chaining with && or |.',
    mutating: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run, e.g. npm install' },
      },
      required: ['command'],
    },
    handler: runScript,
  },
  {
    name: 'run_tests',
    description: "Run the project's test suite.",
    mutating: true,
    parameters: { type: 'object', properties: {}, required: [] },
    handler: runTests,
  },
];

/** @type {Map<string, ToolDefinition>} */
const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

/**
 * The tools available in a given mode.
 *
 * @param {'agent' | 'plan' | 'ask'} mode
 * @returns {ToolDefinition[]}
 */
function forMode(mode) {
  if (mode === 'ask') return [];
  if (mode === 'plan') return TOOLS.filter((tool) => !tool.mutating);
  return [...TOOLS];
}

/**
 * Action names available in a mode, for the parser and the ReAct prompt.
 * `done` is always available — a session must be able to end.
 *
 * @param {'agent' | 'plan' | 'ask'} mode
 * @returns {Set<string>}
 */
function actionsForMode(mode) {
  const names = forMode(mode).map((tool) => tool.name);
  names.push('done');
  return new Set(names);
}

/**
 * Render tools in Ollama's native function-calling format (Tier A).
 *
 * @param {'agent' | 'plan' | 'ask'} mode
 * @returns {object[]}
 */
function toOllamaTools(mode) {
  return forMode(mode).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Render the action list for the Tier B prompt.
 *
 * @param {'agent' | 'plan' | 'ask'} mode
 * @returns {string}
 */
function describeForPrompt(mode) {
  const lines = forMode(mode).map((tool) => `- "${tool.name}": ${tool.description}`);
  lines.push('- "done": Finish. Provide a "summary" of what you did or what you need.');
  return lines.join('\n');
}

/**
 * Look up a tool, honoring the active mode.
 *
 * Returns null for a tool that exists but is not offered in this mode, so the
 * executor cannot dispatch it even if a loop bug lets the name through.
 *
 * @param {string} name
 * @param {'agent' | 'plan' | 'ask'} mode
 * @returns {ToolDefinition | null}
 */
function get(name, mode) {
  const tool = BY_NAME.get(name);
  if (!tool) return null;
  if (mode === 'ask') return null;
  if (mode === 'plan' && tool.mutating) return null;
  return tool;
}

module.exports = {
  TOOLS,
  forMode,
  actionsForMode,
  toOllamaTools,
  describeForPrompt,
  get,
};
