'use strict';

/**
 * Gathering a request's requirements for one file.
 *
 * Written from the measurement that produced the module: on the benchmark brief, the
 * step that writes `TodoItem.jsx` — the file that owns toggle, edit and delete — was
 * handed a prompt containing no mention of Escape, blur or double-click, because those
 * live in a section three headings away that names no files.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fileSpec = require('../../app/core/fileSpec');
const requestPlan = require('../../app/core/requestPlan');
const fileTree = require('../../app/core/fileTree');

const BRIEF = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'prompts', 'todo-glass-app.md'), 'utf8');

describe('fileSpec.words', () => {
  it('splits an identifier into the words inside it', () => {
    assert.deepStrictEqual(fileSpec.words('TodoItem'), ['todo', 'item']);
    assert.deepStrictEqual(fileSpec.words('ContactForm'), ['contact', 'form']);
  });

  it('drops the words that carry no signal', () => {
    // `use` and `app` are everywhere; `list` and `form` are the words that connect a
    // component to its requirement and must survive.
    assert.deepStrictEqual(fileSpec.words('useTodos'), ['todos']);
    assert.ok(fileSpec.words('ContactList').includes('list'));
  });
});

describe('fileSpec.stem', () => {
  it('collapses singular and plural', () => {
    assert.strictEqual(fileSpec.stem('contacts'), fileSpec.stem('contact'));
    assert.strictEqual(fileSpec.stem('entries'), 'entry');
  });

  it('leaves a word ending in double-s alone', () => {
    assert.strictEqual(fileSpec.stem('address'), 'address');
  });
});

describe('fileSpec.bulletsOf', () => {
  it('keeps a wrapped bullet as one requirement', () => {
    const text = ['- Delete a todo, with a fade-out', '  transition that lasts 200ms', '- Add a todo'].join('\n');
    const chunks = fileSpec.bulletsOf(text);
    assert.strictEqual(chunks.length, 2);
    assert.match(chunks[0], /200ms/);
  });

  it('leaves an unbulleted paragraph whole', () => {
    const text = 'Escape the note text before it goes into the HTML.\nNotes come from the user.';
    assert.deepStrictEqual(fileSpec.bulletsOf(text), [text]);
  });
});

describe('fileSpec.forFile — the benchmark brief', () => {
  const plan = requestPlan.fromRequest(BRIEF);
  const structure = plan.items.find((item) => fileTree.hasTree(item.detail));
  const files = new Map(fileTree.files(structure.detail).map((file) => [file.path.split('/').pop(), file]));

  /** @param {string} name */
  function specFor(name) {
    const file = files.get(name);
    return fileSpec.forFile({ path: file.path, purpose: file.purpose, requirements: plan.requirements });
  }

  it('gives the row component the behaviour it owns', () => {
    // The whole point of the module, in one assertion.
    const spec = specFor('TodoItem.jsx').text;
    assert.match(spec, /Escape/);
    assert.match(spec, /double-click/);
    assert.match(spec, /blur/);
    assert.match(spec, /Delete Todo/);
  });

  it('gives the input component the add behaviour and not the delete behaviour', () => {
    const spec = specFor('TodoInput.jsx').text;
    assert.match(spec, /Add Todo/);
    assert.match(spec, /ignore empty/);
    assert.strictEqual(/Clear Completed/.test(spec), false);
  });

  it('gives the clear button both clear actions and their confirmation', () => {
    const spec = specFor('ClearButton.jsx').text;
    assert.match(spec, /Clear Completed/);
    assert.match(spec, /Clear All/);
    assert.match(spec, /click-to-confirm/);
  });

  it('gives the counter the counter requirement', () => {
    assert.match(specFor('TodoStats.jsx').text, /live count of remaining/);
  });

  it('gives the composition root everything, because everything is wired into it', () => {
    // `App.jsx` shares no vocabulary with any single requirement — its purpose is
    // "Composes layout + components" — so matching on words gave it nothing at all,
    // which is exactly wrong for the file that shipped Vite's counter demo twice.
    const spec = specFor('App.jsx');
    assert.ok(spec.matched > 5, `composition root matched only ${spec.matched}`);
    assert.ok(spec.text.length > 0);
  });

  it('does not hand every file the same nine requirements', () => {
    // The project's own subject word — `todo` here, `contact` in the CMS brief — is in
    // every filename and every requirement, so before the frequency filter each of the
    // five components received an identical selection.
    const item = specFor('TodoItem.jsx').text;
    const input = specFor('TodoInput.jsx').text;
    assert.notStrictEqual(item, input);
  });

  it('keeps each file inside its budget', () => {
    for (const name of files.keys()) {
      const file = files.get(name);
      const spec = fileSpec.forFile({
        path: file.path,
        purpose: file.purpose,
        requirements: plan.requirements,
        maxChars: 400,
      });
      assert.ok(spec.text.length <= 400, `${name} came back at ${spec.text.length}`);
    }
  });
});

describe('fileSpec.forFile — when there is nothing to gather', () => {
  it('returns nothing rather than guessing', () => {
    const spec = fileSpec.forFile({ path: 'src/thing.js', purpose: '', requirements: '' });
    assert.strictEqual(spec.text, '');
    assert.strictEqual(spec.matched, 0);
  });

  it('returns nothing for a file the requirements never mention', () => {
    const requirements = [
      '- Add a note, with the text trimmed before it is stored anywhere at all',
      '- Remove a note by its id, quietly when the id is not there to be found',
      '- List every note that has not been archived by somebody at some point',
      '- Escape the text before rendering it into the page, without exception',
      '- Show the id beside each note so that a bug report is able to name one',
    ].join('\n');
    const spec = fileSpec.forFile({ path: 'src/telemetry/uploader.js', purpose: '', requirements });
    assert.strictEqual(spec.text, '');
  });
});

describe('fileSpec.isComposition', () => {
  it('recognises the file the others are assembled into', () => {
    assert.strictEqual(fileSpec.isComposition('src/App.jsx', 'Composes layout + components'), true);
    assert.strictEqual(fileSpec.isComposition('src/App.jsx', ''), true);
    assert.strictEqual(fileSpec.isComposition('src/Screen.jsx', 'Assembles the panels'), true);
  });

  it('does not treat an ordinary component as one', () => {
    assert.strictEqual(fileSpec.isComposition('src/components/TodoItem.jsx', 'Single todo row'), false);
    assert.strictEqual(fileSpec.isComposition('src/hooks/useTodos.js', 'All todo state logic'), false);
  });
});
