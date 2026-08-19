'use strict';

/**
 * Reading the command a request already wrote out.
 *
 * The bar for acting on one is high, so most of these tests are about *not* matching:
 * a build command is not a scaffold command, a scaffold command for some other folder
 * is about some other folder, and prose describing a command is not a command.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const namedCommands = require('../../app/core/namedCommands');

const prompt = (name) =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'prompts', `${name}.md`), 'utf8');

describe('namedCommands.scaffoldFor', () => {
  it('finds the command the benchmark brief gives for creating the project', () => {
    // Every failure to scaffold in the 0.9.0 sweep was a failure to retype this line.
    assert.strictEqual(
      namedCommands.scaffoldFor(prompt('todo-glass-app'), 'todo-glass-app'),
      'npm create vite@latest todo-glass-app -- --template react'
    );
  });

  it('finds nothing in a request that does not give one', () => {
    // The contacts brief says "scaffold a conventional folder structure" and the Java
    // brief builds with Maven from a pom the agent writes. Neither names a command that
    // creates the directory, and inventing one would be exactly the wrong move.
    assert.strictEqual(namedCommands.scaffoldFor(prompt('cms-contacts-app'), 'cms-app'), '');
    assert.strictEqual(namedCommands.scaffoldFor(prompt('pos-java-swing'), 'pos-app'), '');
  });

  it('does not mistake a build or install command for a scaffold', () => {
    const request = 'Run `npm install`, then `npm run build`, then `npm test` in my-app.';
    assert.strictEqual(namedCommands.scaffoldFor(request, 'my-app'), '');
  });

  it('will not run a scaffold command aimed at a different folder', () => {
    const request = 'For reference, the sibling project was made with `npm create vite@latest other-app`.';
    assert.strictEqual(namedCommands.scaffoldFor(request, 'my-app'), '');
  });

  it('does not match a folder name that is only a prefix of the one in the command', () => {
    const request = 'Scaffold it with `npm create vite@latest my-app-legacy -- --template react`.';
    assert.strictEqual(namedCommands.scaffoldFor(request, 'my-app'), '');
  });

  it('reads a command out of a fenced block, with or without a prompt marker', () => {
    const request = ['Set it up:', '', '```bash', '$ npm create vite@latest shop -- --template react', '```'].join('\n');
    assert.strictEqual(namedCommands.scaffoldFor(request, 'shop'), 'npm create vite@latest shop -- --template react');
  });

  it('ignores a command mentioned only in prose', () => {
    // Unquoted text is a description, and acting on a paraphrase is how the wrong thing
    // gets run.
    const request = 'Create it with npm create vite@latest shop and then install the dependencies.';
    assert.strictEqual(namedCommands.scaffoldFor(request, 'shop'), '');
  });

  it('needs a directory to be asked about', () => {
    assert.strictEqual(namedCommands.scaffoldFor(prompt('todo-glass-app'), ''), '');
  });
});

describe('namedCommands.candidates', () => {
  it('takes code spans and fenced lines, and nothing else', () => {
    const request = ['Run `npm ci` first.', '', '```', 'npm run build', 'npm test', '```', '', 'Then deploy it.'].join('\n');
    assert.deepStrictEqual(namedCommands.candidates(request), ['npm ci', 'npm run build', 'npm test']);
  });

  it('leaves out a code span holding a paragraph', () => {
    const long = '`' + 'x'.repeat(400) + '`';
    assert.deepStrictEqual(namedCommands.candidates(long), []);
  });
});
