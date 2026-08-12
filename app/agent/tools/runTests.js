'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * Only `package.json` at the gate-resolved workspace root is read here. */

/**
 * Run the project's test suite.
 *
 * A thin convenience over `run_script` whose real value is *discovering* the right
 * command. A 1B model asked to "run the tests" guesses `npm test` regardless of
 * whether the project is Python, Rust, or Go, and then reports a confusing failure.
 * Reading the manifest is deterministic and gets it right.
 *
 * The discovered command still goes through the identical permission path — this
 * tool is a shortcut for the model, never for the gate.
 *
 * @module agent/tools/runTests
 */

const fs = require('fs');
const path = require('path');

const runScript = require('./runScript');

/**
 * Work out how this project runs its tests.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<{command: string, reason: string} | null>}
 */
async function detectTestCommand(workspaceRoot) {
  try {
    const manifest = JSON.parse(await fs.promises.readFile(path.join(workspaceRoot, 'package.json'), 'utf8'));
    const scripts = manifest && typeof manifest.scripts === 'object' ? manifest.scripts : null;
    if (scripts && typeof scripts.test === 'string' && scripts.test.trim()) {
      return { command: 'npm test', reason: 'package.json defines a "test" script' };
    }
    // A Node project without a test script: saying so beats running `npm test` and
    // reporting its "no test specified" error as if it were a real failure.
    if (manifest) return null;
  } catch {
    /* not a Node project, or no manifest */
  }

  const candidates = [
    { file: 'pytest.ini', command: 'pytest', reason: 'pytest.ini is present' },
    { file: 'pyproject.toml', command: 'pytest', reason: 'pyproject.toml is present' },
    { file: 'Cargo.toml', command: 'cargo test', reason: 'Cargo.toml is present' },
    { file: 'go.mod', command: 'go test ./...', reason: 'go.mod is present' },
    { file: 'pom.xml', command: 'mvn test', reason: 'pom.xml is present' },
    { file: 'build.gradle', command: 'gradle test', reason: 'build.gradle is present' },
  ];

  for (const candidate of candidates) {
    try {
      await fs.promises.access(path.join(workspaceRoot, candidate.file));
      return { command: candidate.command, reason: candidate.reason };
    } catch {
      /* try the next one */
    }
  }

  return null;
}

/**
 * @param {object} _args
 * @param {import('../toolRegistry').ToolContext} context
 * @returns {Promise<import('../toolRegistry').ToolResult>}
 */
module.exports = async function runTests(_args, context) {
  const detected = await detectTestCommand(context.workspaceRoot);

  if (!detected) {
    return {
      ok: false,
      observation:
        'No test command could be found for this project (no "test" script in package.json, and no pytest, cargo, go, maven, or gradle setup). Use run_script if you know the right command.',
    };
  }

  const result = await runScript({ command: detected.command }, context);
  return {
    ...result,
    observation: `Running the tests with \`${detected.command}\` (${detected.reason}).\n${result.observation}`,
  };
};

module.exports.detectTestCommand = detectTestCommand;
