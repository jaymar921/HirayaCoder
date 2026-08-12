'use strict';

/**
 * A minimal `vscode` module for unit tests.
 *
 * The real one only exists inside a running editor, so any feature module that
 * requires it is untestable outside the integration suite unless it is stubbed.
 * Rather than restructure those modules to hide the dependency — which would
 * complicate production code for the benefit of tests — the module loader is taught
 * to resolve `vscode` to this object.
 *
 * Only what the tests actually touch is implemented. Anything missing surfaces as a
 * clear TypeError rather than a silent wrong answer.
 */

const Module = require('module');

const stub = {
  EventEmitter: class {
    constructor() {
      this.event = () => ({ dispose() {} });
    }
    fire() {}
    dispose() {}
  },
  Uri: {
    parse: (value) => ({ toString: () => value, scheme: String(value).split(':')[0] }),
    file: (value) => ({ toString: () => `file://${value}`, fsPath: value }),
    joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join('/') }),
  },
  Range: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
    intersection() {
      return null;
    }
  },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  CodeAction: class {
    constructor(title, kind) {
      this.title = title;
      this.kind = kind;
    }
  },
  CodeActionKind: { RefactorRewrite: 'refactor.rewrite', Empty: '' },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  InlineCompletionItem: class {
    constructor(text, range) {
      this.insertText = text;
      this.range = range;
    }
  },
  ProgressLocation: { Notification: 15 },
  ViewColumn: { Active: -1 },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  languages: {
    registerCodeActionsProvider: () => ({ dispose() {} }),
    registerInlineCompletionItemProvider: () => ({ dispose() {} }),
    getDiagnostics: () => [],
  },
  window: {
    activeTextEditor: undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    createWebviewPanel: () => ({ webview: {}, onDidDispose() {}, reveal() {} }),
    withProgress: async (_options, task) => task({ report() {} }, { onCancellationRequested() {} }),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    asRelativePath: (uri) => String(uri && uri.fsPath ? uri.fsPath : uri),
    findFiles: async () => [],
    fs: { readFile: async () => Buffer.from('{}') },
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
  },
};

/** Install the stub. Call once, before requiring anything that needs `vscode`. */
function install() {
  const original = Module._load;
  if (Module._load.__hirayaStubbed) return stub;

  /** @param {string} request */
  const patched = function load(request, parent, isMain) {
    if (request === 'vscode') return stub;
    return original.call(this, request, parent, isMain);
  };
  patched.__hirayaStubbed = true;
  Module._load = patched;
  return stub;
}

module.exports = { install, stub };
