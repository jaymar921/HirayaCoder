'use strict';

/**
 * The briefs the real-world benchmark can run, and how each one is graded.
 *
 * One brief is one product a user asked for. Everything that differs between them lives
 * here — where the project goes, which files the request named, how it is built, and how
 * the finished thing is driven — so `bench-realworld.js` stays a harness rather than a
 * pile of special cases.
 *
 * ## Required files are the request's own list
 *
 * Each `requiredFiles` list is copied from the folder tree in the prompt beside it. It
 * is a presence check and nothing more: a file being there says nothing about what is in
 * it, which is exactly the lesson of the 0.9.0 baseline — a project passed every
 * file-presence check with `App.jsx` holding Vite's counter demo.
 *
 * @module tools/lib/briefs
 */

/**
 * @typedef {object} Brief
 * @property {string} id
 * @property {string} label
 * @property {string} promptFile   Under `tools/prompts/`.
 * @property {string} appDir       Where the project is expected, relative to the workspace.
 * @property {'node' | 'maven'} toolchain
 * @property {string[]} requiredFiles
 * @property {string} probe        Which feature probe grades it.
 * @property {string[][]} [extraGates]  Commands run as gates beyond install and build.
 */

/** @type {Brief[]} */
const BRIEFS = [
  {
    id: 'todo',
    label: 'React TODO app, glassy blue',
    promptFile: 'todo-glass-app.md',
    appDir: 'todo-glass-app',
    toolchain: 'node',
    probe: 'browser-todo',
    requiredFiles: [
      'index.html',
      'package.json',
      'vite.config.js',
      'src/main.jsx',
      'src/App.jsx',
      'src/index.css',
      'src/hooks/useTodos.js',
      'src/components/TodoInput.jsx',
      'src/components/TodoItem.jsx',
      'src/components/TodoList.jsx',
      'src/components/TodoStats.jsx',
      'src/components/ClearButton.jsx',
      'README.md',
    ],
  },
  {
    id: 'cms',
    label: 'React contact manager, with tests',
    promptFile: 'cms-contacts-app.md',
    appDir: 'cms-app',
    toolchain: 'node',
    probe: 'browser-contacts',
    // The brief asks for a test suite and says not to report success with failing
    // checks, so the suite is a gate rather than a footnote.
    extraGates: [['npm', 'run', 'test']],
    // No `index.html` here, unlike the TODO brief: this prompt's tree does not draw one.
    // A required file the request never asks for fails every model for something nobody
    // requested, which is why `test/unit/briefs.test.js` checks this list against the
    // prompt rather than trusting it.
    requiredFiles: [
      'package.json',
      'vite.config.js',
      'src/main.jsx',
      'src/App.jsx',
      'src/index.css',
      'src/hooks/useContacts.js',
      'src/utils/validation.js',
      'src/components/contacts/ContactList.jsx',
      'src/components/contacts/ContactCard.jsx',
      'src/components/contacts/ContactForm.jsx',
      'src/components/contacts/ConfirmDialog.jsx',
      'tests/useContacts.test.js',
      'README.md',
    ],
  },
  {
    id: 'pos',
    label: 'Java Swing point of sale',
    promptFile: 'pos-java-swing.md',
    appDir: 'pos-app',
    toolchain: 'maven',
    probe: 'java-service',
    requiredFiles: [
      'pom.xml',
      'README.md',
      'src/main/java/com/pos/app/Main.java',
      'src/main/java/com/pos/app/model/Product.java',
      'src/main/java/com/pos/app/repository/ProductRepository.java',
      'src/main/java/com/pos/app/repository/FileProductRepository.java',
      'src/main/java/com/pos/app/service/ProductService.java',
      'src/main/java/com/pos/app/ui/MainFrame.java',
      'src/test/java/com/pos/app/service/ProductServiceTest.java',
    ],
  },
];

/** @param {string} id */
function byId(id) {
  return BRIEFS.find((brief) => brief.id === id) || null;
}

module.exports = { BRIEFS, byId };
