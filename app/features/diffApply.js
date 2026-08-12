'use strict';

/**
 * Showing a change before it lands.
 *
 * The permission gate decides *whether* a write is allowed; this decides what the
 * user sees while deciding. They are separate on purpose — the gate must work
 * headlessly for tests and for auto-apply mode, and it must not depend on a webview
 * being open.
 *
 * ## Why VS Code's own diff viewer
 *
 * The temptation is to render a diff inside the chat panel, and for a summary that is
 * right. But for *reviewing* a change, the editor already has a diff view the user
 * knows, with their syntax highlighting, their whitespace settings, and their
 * keybindings. Reimplementing it in a webview produces something worse that also has
 * to be maintained. So the inline summary stays in chat, and "review" opens the real
 * thing.
 *
 * @module features/diffApply
 */

const path = require('path');
const vscode = require('vscode');

const logger = require('../utils/logger');

/** Scheme for the read-only "proposed content" side of a diff. */
const SCHEME = 'hirayacoder-proposed';

/**
 * Serves the proposed version of a file to the diff viewer.
 *
 * VS Code diffs two URIs, and the right-hand side does not exist on disk yet — that
 * is the entire point. A content provider lets it be shown without writing anything.
 */
class ProposedContentProvider {
  constructor() {
    /** @type {Map<string, string>} */
    this.contents = new Map();
    this._emitter = new vscode.EventEmitter();
    this.onDidChange = this._emitter.event;
  }

  /**
   * @param {vscode.Uri} uri
   * @returns {string}
   */
  provideTextDocumentContent(uri) {
    return this.contents.get(uri.toString()) || '';
  }

  /**
   * @param {vscode.Uri} uri
   * @param {string} content
   */
  set(uri, content) {
    this.contents.set(uri.toString(), content);
    this._emitter.fire(uri);
  }

  /** @param {vscode.Uri} uri */
  clear(uri) {
    this.contents.delete(uri.toString());
  }

  dispose() {
    this.contents.clear();
    this._emitter.dispose();
  }
}

/** @type {ProposedContentProvider | null} */
let provider = null;

/**
 * Register the content provider. Call once during activation.
 *
 * @param {vscode.ExtensionContext} context
 * @returns {ProposedContentProvider}
 */
function register(context) {
  if (provider) return provider;
  provider = new ProposedContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
    provider
  );
  return provider;
}

/**
 * Open a side-by-side diff of a proposed change.
 *
 * @param {object} change
 * @param {string} change.path        Workspace-relative path, for the title.
 * @param {string} change.absolute
 * @param {string | null} change.before  Null for a new file.
 * @param {string} change.after
 * @returns {Promise<void>}
 */
async function showDiff(change) {
  if (!provider) {
    logger.warn('diffApply.showDiff called before register(); skipping the preview.');
    return;
  }

  const proposed = vscode.Uri.parse(`${SCHEME}:${change.path}`);
  provider.set(proposed, change.after);

  // A new file has nothing to compare against, so an empty left-hand side is
  // honest — it reads as "all of this is being added", which is what is happening.
  const original =
    change.before === null
      ? vscode.Uri.parse(`${SCHEME}:${change.path}.empty`)
      : vscode.Uri.file(change.absolute);

  if (change.before === null) provider.set(original, '');

  const title =
    change.before === null
      ? `${path.basename(change.path)} (new file)`
      : `${path.basename(change.path)} (proposed)`;

  await vscode.commands.executeCommand('vscode.diff', original, proposed, title, {
    preview: true,
    preserveFocus: false,
  });
}

/**
 * Ask the user about one file change, offering a real diff.
 *
 * Returns the decision, so the caller — the permission gate's confirm handler —
 * stays the single place a yes/no is turned into an action.
 *
 * @param {object} change
 * @param {string} change.path
 * @param {string} change.absolute
 * @param {string | null} change.before
 * @param {string} change.after
 * @param {string} [change.summary]  e.g. "+7 / -5 lines".
 * @returns {Promise<boolean>}
 */
async function confirmChange(change) {
  const isNew = change.before === null;
  const detail = change.summary ? ` (${change.summary})` : '';

  const REVIEW = 'Review diff';
  const APPLY = isNew ? 'Create' : 'Apply';
  const REJECT = 'Reject';

  // Loops so "Review diff" can be chosen without it counting as an answer — the
  // user opens the diff, reads it, and is asked again.
  for (;;) {
    const choice = await vscode.window.showInformationMessage(
      `HirayaCoder wants to ${isNew ? 'create' : 'change'} ${change.path}${detail}`,
      { modal: false },
      REVIEW,
      APPLY,
      REJECT
    );

    if (choice === REVIEW) {
      await showDiff(change);
      continue;
    }
    // Dismissing the prompt is not consent. Anything other than an explicit apply
    // is a refusal.
    return choice === APPLY;
  }
}

module.exports = { register, showDiff, confirmChange, SCHEME, ProposedContentProvider };
