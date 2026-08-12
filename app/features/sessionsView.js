'use strict';

/**
 * The activity bar view: every chat session in this workspace.
 *
 * The container exists mostly to give HirayaCoder a home in the activity bar, but an
 * empty panel behind an icon is worse than no icon. Sessions are the one thing worth
 * listing there: each is a separate memory file that outlives the tab it was opened
 * from, and before this the only way to find an old one was the command palette's
 * quick-pick — which showed them only while you were already opening a chat.
 *
 * This reads the same `listSessions` the command uses. It owns no state of its own, so
 * it cannot disagree with what is on disk.
 *
 * @module features/sessionsView
 */

const vscode = require('vscode');

const { listSessions } = require('../core/memoryStore');

/** @implements {vscode.TreeDataProvider<SessionItem>} */
class SessionsProvider {
  /**
   * @param {() => string | null} getWorkspaceRoot
   */
  constructor(getWorkspaceRoot) {
    this.getWorkspaceRoot = getWorkspaceRoot;
    this._emitter = new vscode.EventEmitter();
    /** @type {vscode.Event<void>} */
    this.onDidChangeTreeData = this._emitter.event;
  }

  /** Re-read the folder. Called when a session is created, cleared, or resumed. */
  refresh() {
    this._emitter.fire();
  }

  /**
   * @param {SessionItem} element
   * @returns {vscode.TreeItem}
   */
  getTreeItem(element) {
    return element;
  }

  /**
   * @returns {SessionItem[]}
   */
  getChildren() {
    const root = this.getWorkspaceRoot();
    // No folder means no memory directory to read. Returning nothing lets the
    // `viewsWelcome` contribution explain that, rather than showing an empty list.
    if (!root) return [];

    return listSessions(root).map((session) => new SessionItem(session));
  }

  dispose() {
    this._emitter.dispose();
  }
}

class SessionItem extends vscode.TreeItem {
  /**
   * @param {{sessionId: number, entries: number, modifiedAt: Date}} session
   */
  constructor(session) {
    super(`Session ${session.sessionId}`, vscode.TreeItemCollapsibleState.None);

    this.sessionId = session.sessionId;
    this.description = `${session.entries} note${session.entries === 1 ? '' : 's'}`;
    this.tooltip = `Last updated ${session.modifiedAt.toLocaleString()}`;
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.contextValue = 'hirayacoder.session';

    // Opens that session's tab rather than starting a new one, which is the whole
    // point of listing them.
    this.command = {
      command: 'hirayacoder.openSession',
      title: 'Open session',
      arguments: [session.sessionId],
    };
  }
}

module.exports = { SessionsProvider, SessionItem };
