'use strict';

/**
 * "Write tests for this file."
 *
 * A thin feature with one idea worth stating: it looks at how the project already
 * tests things before asking for more. A model that invents a Jest suite for a Mocha
 * project has produced work the user has to undo, and on a local 1–3B model that
 * guess is more likely than not.
 *
 * So the runner is detected from `package.json`, the nearest existing test file is
 * offered as the example to imitate, and the prompt names both. Detection is cheap
 * and deterministic; asking the model to infer it is neither.
 *
 * @module features/testGenerator
 */

const vscode = require('vscode');

/** Test runners recognised from dependencies, most specific first. */
const RUNNERS = [
  { name: 'vitest', deps: ['vitest'] },
  { name: 'jest', deps: ['jest', 'ts-jest'] },
  { name: 'mocha', deps: ['mocha'] },
  { name: 'ava', deps: ['ava'] },
  { name: 'node:test', deps: [] },
];

/** Where projects conventionally keep tests. */
const TEST_GLOBS = '{test,tests,spec,__tests__}/**/*.{test,spec}.{js,mjs,cjs,ts,tsx,jsx}';

/**
 * Which runner is this project using?
 *
 * @param {Record<string, unknown>} packageJson
 * @returns {string}
 */
function detectRunner(packageJson) {
  const deps = {
    ...(packageJson.dependencies || {}),
    ...(packageJson.devDependencies || {}),
  };

  for (const runner of RUNNERS) {
    if (runner.deps.some((dep) => Object.prototype.hasOwnProperty.call(deps, dep))) return runner.name;
  }

  // A `test` script naming a runner counts even when the dependency is global.
  const script = String((packageJson.scripts && packageJson.scripts.test) || '');
  for (const runner of RUNNERS) {
    if (runner.name !== 'node:test' && script.includes(runner.name)) return runner.name;
  }

  return 'node:test';
}

/**
 * Read the project's package.json, if there is one.
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function readPackageJson() {
  const found = await vscode.workspace.findFiles('package.json', '**/node_modules/**', 1);
  if (found.length === 0) return {};
  try {
    const bytes = await vscode.workspace.fs.readFile(found[0]);
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    // A malformed package.json is the project's problem, not a reason to fail here.
    return {};
  }
}

/**
 * Find an existing test to imitate.
 *
 * @returns {Promise<string | null>} Workspace-relative path, or null.
 */
async function findExampleTest() {
  const found = await vscode.workspace.findFiles(TEST_GLOBS, '**/node_modules/**', 1);
  return found.length > 0 ? vscode.workspace.asRelativePath(found[0], false) : null;
}

/**
 * Build the prompt for the active file.
 *
 * @param {object} input
 * @param {string} input.relativePath
 * @param {string} input.language
 * @param {string} input.runner
 * @param {string | null} input.example
 * @param {string} [input.selection]
 * @returns {string}
 */
function buildPrompt(input) {
  const target = input.selection
    ? `the selected code in ${input.relativePath}`
    : `${input.relativePath}`;

  const lines = [
    `Write tests for ${target}.`,
    '',
    `This project uses ${input.runner}. Match that — do not introduce another test framework.`,
  ];

  if (input.example) {
    lines.push(
      `Read ${input.example} first and follow its conventions: same imports, same file layout, ` +
        'same naming.'
    );
  }

  lines.push(
    '',
    'Read the file under test before writing anything. Cover the behaviour that would actually',
    'break — edge cases, empty input, and errors — not one trivial case per function.',
    'Put the tests in the location this project already uses.'
  );

  if (input.selection) {
    lines.push('', `\`\`\`${input.language}\n${input.selection}\n\`\`\``);
  }

  return lines.join('\n');
}

/**
 * Register the command.
 *
 * @param {vscode.ExtensionContext} context
 * @param {(task: string, opts: {mode: string}) => Promise<void>} sendToChat
 * @returns {vscode.Disposable}
 */
function register(context, sendToChat) {
  const disposable = vscode.commands.registerCommand('hirayacoder.generateTests', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('HirayaCoder: open the file you want tests for.');
      return;
    }

    const [packageJson, example] = await Promise.all([readPackageJson(), findExampleTest()]);
    const selection = editor.document.getText(editor.selection);

    await sendToChat(
      buildPrompt({
        relativePath: vscode.workspace.asRelativePath(editor.document.uri, false),
        language: editor.document.languageId,
        runner: detectRunner(packageJson),
        example,
        selection: selection.trim() ? selection : undefined,
      }),
      { mode: 'agent' }
    );
  });

  context.subscriptions.push(disposable);
  return disposable;
}

module.exports = { register, detectRunner, buildPrompt, findExampleTest, RUNNERS };
