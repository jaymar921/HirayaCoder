'use strict';

/**
 * Mocha entry point, running *inside* the VS Code extension host.
 *
 * `@vscode/test-electron` calls `run()` once the host is up, so `require('vscode')`
 * resolves to the real API from here down.
 */

const path = require('path');
const fs = require('fs');

const Mocha = require('mocha');

function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: false,
    // Activation plus a model round-trip against the stub is well under this, but a
    // cold extension host on a slow disk is not instant.
    timeout: 60000,
  });

  const suiteRoot = __dirname;
  for (const file of fs.readdirSync(suiteRoot)) {
    if (file.endsWith('.test.js')) mocha.addFile(path.join(suiteRoot, file));
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) reject(new Error(`${failures} integration test(s) failed.`));
        else resolve();
      });
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { run };
