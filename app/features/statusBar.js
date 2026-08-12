'use strict';

/**
 * Offline-first status bar item.
 *
 * Surfaces, at a glance: whether the local Ollama instance is reachable, which
 * model is active, and which tier it classified into. Later phases extend the same
 * item with thinking capacity, mode, live step count, and permission indicators —
 * the state shape already carries those fields.
 *
 * @module features/statusBar
 */

const vscode = require('vscode');

/**
 * @typedef {object} StatusState
 * @property {'connecting' | 'online' | 'offline'} connection
 * @property {string | null} model
 * @property {import('../core/modelCapability').Capability | null} capability
 * @property {string} [ollamaVersion]
 * @property {string} [error]
 * @property {number} [modelCount]
 * @property {import('../core/modelCapability').ThinkingCapacity} [thinkingCapacity]
 * @property {'agent' | 'plan' | 'ask'} [mode]
 * @property {{step: number, maxSteps: number} | null} [progress]
 * @property {{autoEdit: boolean, autoApproveScripts: boolean}} [permissions]
 */

class StatusBar {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'hirayacoder.showStatus';
    context.subscriptions.push(this.item);

    /** @type {StatusState} */
    this.state = { connection: 'connecting', model: null, capability: null };
    this.visible = true;
  }

  /**
   * Merge a partial state update and repaint.
   *
   * @param {Partial<StatusState>} patch
   */
  update(patch) {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  /**
   * @param {boolean} visible
   */
  setVisible(visible) {
    this.visible = visible;
    this.render();
  }

  render() {
    if (!this.visible) {
      this.item.hide();
      return;
    }

    const s = this.state;

    if (s.connection === 'connecting') {
      this.item.text = '$(sync~spin) HirayaCoder';
      this.item.tooltip = 'Connecting to your local Ollama instance…';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    if (s.connection === 'offline') {
      this.item.text = '$(debug-disconnect) HirayaCoder: offline';
      this.item.tooltip = new vscode.MarkdownString(
        `**Ollama is not reachable.**\n\n${s.error || ''}\n\n` +
          'Start it with `ollama serve`, then click here to retry.'
      );
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.show();
      return;
    }

    const model = s.model || 'no model';
    const badge = s.capability ? ` · ${s.capability.label}` : '';
    const progress = s.progress ? ` · ${s.progress.step}/${s.progress.maxSteps}` : '';
    this.item.text = `$(sparkle) ${model}${badge}${progress}`;
    this.item.backgroundColor = undefined;
    this.item.tooltip = this.buildTooltip();
    this.item.show();
  }

  /**
   * @returns {vscode.MarkdownString}
   * @private
   */
  buildTooltip() {
    const s = this.state;
    const lines = ['**HirayaCoder** — fully offline, local Ollama only', ''];

    lines.push(`Ollama: connected${s.ollamaVersion ? ` (v${s.ollamaVersion})` : ''}`);
    if (typeof s.modelCount === 'number') {
      lines.push(`Installed models: ${s.modelCount}`);
    }
    lines.push(`Model: \`${s.model || 'none selected'}\``);

    if (s.capability) {
      const c = s.capability;
      const size = c.params === null ? 'unknown size' : `${c.params}B`;
      lines.push(`Tier: **${c.tier}** (${c.label}) · ${size} · ${c.strategy} loop`);
      lines.push('', `_${c.reason}_`);
    }

    if (s.thinkingCapacity) lines.push('', `Thinking: ${s.thinkingCapacity}`);
    if (s.mode) lines.push(`Mode: ${s.mode}`);
    if (s.permissions) {
      lines.push(
        `Edits: ${s.permissions.autoEdit ? 'auto' : 'approve'} · ` +
          `Scripts: ${s.permissions.autoApproveScripts ? 'auto' : 'approve'}`
      );
    }

    lines.push('', 'Click for connection details.');

    const md = new vscode.MarkdownString(lines.join('\n'));
    md.isTrusted = false;
    return md;
  }
}

module.exports = { StatusBar };
