'use strict';

/**
 * Editor quick actions: Explain, Refactor, Document, Fix.
 *
 * Each one is a pre-written prompt aimed at the current selection, handed to the chat
 * tab. They are shortcuts, not a second agent — the same session, memory, permission
 * gate, and audit trail apply, because a "quick" action that edits a file with
 * different rules than the chat would be a hole in the permission model.
 *
 * ## Explain is Ask, the rest are Agent
 *
 * "Explain this" should never edit anything, so it runs in Ask mode where the tools
 * do not exist. Refactor, Document, and Fix are edits by definition and run in Agent
 * mode against the normal gate. Choosing the mode here — rather than letting the
 * model infer intent from the wording — is what keeps "explain" from turning into a
 * rewrite.
 *
 * @module features/codeActions
 */

const vscode = require('vscode');

/**
 * The actions offered, keyed by command id suffix.
 *
 * Prompts name the file and language explicitly because the selection alone is
 * often a fragment, and a model handed twelve lines with no context will invent the
 * surrounding file.
 */
const ACTIONS = new Map([
  [
    'explain',
    {
      title: 'Explain',
      mode: 'ask',
      kind: vscode.CodeActionKind ? vscode.CodeActionKind.Empty : undefined,
      build: ({ relativePath, language, selection }) =>
        `Explain this ${language} from ${relativePath}. Say what it does, then anything ` +
        `surprising or risky about it. Do not rewrite it.\n\n\`\`\`${language}\n${selection}\n\`\`\``,
    },
  ],
  [
    'refactor',
    {
      title: 'Refactor',
      mode: 'agent',
      build: ({ relativePath, language, selection }) =>
        `Refactor this selection in ${relativePath} for clarity, keeping behaviour identical. ` +
        `Read the file first, then apply the change.\n\n\`\`\`${language}\n${selection}\n\`\`\``,
    },
  ],
  [
    'document',
    {
      title: 'Add documentation',
      mode: 'agent',
      build: ({ relativePath, language, selection }) =>
        `Add documentation comments to this selection in ${relativePath}, in the style already ` +
        `used in that file. Explain why, not what the code plainly says. Change nothing else.` +
        `\n\n\`\`\`${language}\n${selection}\n\`\`\``,
    },
  ],
  [
    'fix',
    {
      title: 'Fix',
      mode: 'agent',
      build: ({ relativePath, language, selection, diagnostics }) => {
        const problems =
          diagnostics.length > 0
            ? `\n\nThe editor reports:\n${diagnostics.map((d) => `- ${d}`).join('\n')}`
            : '';
        return (
          `Fix the problem in this selection from ${relativePath}. Read the file first, ` +
          `then apply the smallest change that fixes it.${problems}` +
          `\n\n\`\`\`${language}\n${selection}\n\`\`\``
        );
      },
    },
  ],
]);

/**
 * Gather what the prompts need from the editor.
 *
 * @param {vscode.TextEditor} editor
 * @returns {{relativePath: string, language: string, selection: string, diagnostics: string[]} | null}
 */
function describeSelection(editor) {
  const selection = editor.document.getText(editor.selection);
  if (!selection.trim()) return null;

  const diagnostics = vscode.languages
    .getDiagnostics(editor.document.uri)
    .filter((d) => d.range.intersection(editor.selection))
    .filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
    .map((d) => d.message)
    .slice(0, 5);

  return {
    relativePath: vscode.workspace.asRelativePath(editor.document.uri, false),
    language: editor.document.languageId,
    selection,
    diagnostics,
  };
}

/**
 * Offers the actions in the lightbulb menu when there is a selection.
 */
class HirayaCodeActionProvider {
  /**
   * @param {vscode.TextDocument} _document
   * @param {vscode.Range | vscode.Selection} range
   * @returns {vscode.CodeAction[]}
   */
  provideCodeActions(_document, range) {
    // Nothing selected means nothing to act on; offering the actions anyway
    // produces a menu entry that fails when clicked.
    if (range.isEmpty) return [];

    /** @type {vscode.CodeAction[]} */
    const actions = [];
    for (const [id, action] of ACTIONS) {
      const item = new vscode.CodeAction(`HirayaCoder: ${action.title}`, vscode.CodeActionKind.RefactorRewrite);
      item.command = { command: `hirayacoder.${id}`, title: action.title };
      actions.push(item);
    }
    return actions;
  }
}

/**
 * Register the provider and one command per action.
 *
 * @param {vscode.ExtensionContext} context
 * @param {(task: string, opts: {mode: string}) => Promise<void>} sendToChat
 * @returns {vscode.Disposable[]}
 */
function register(context, sendToChat) {
  /** @type {vscode.Disposable[]} */
  const disposables = [
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new HirayaCodeActionProvider(),
      { providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite] }
    ),
  ];

  for (const [id, action] of ACTIONS) {
    disposables.push(
      vscode.commands.registerCommand(`hirayacoder.${id}`, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showInformationMessage('HirayaCoder: open a file first.');
          return;
        }

        const described = describeSelection(editor);
        if (!described) {
          vscode.window.showInformationMessage(`HirayaCoder: select the code you want to ${action.title.toLowerCase()}.`);
          return;
        }

        await sendToChat(action.build(described), { mode: action.mode });
      })
    );
  }

  context.subscriptions.push(...disposables);
  return disposables;
}

module.exports = { register, describeSelection, HirayaCodeActionProvider, ACTIONS };
