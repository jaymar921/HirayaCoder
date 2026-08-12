'use strict';

/**
 * The chat tab: a webview panel in the editor group, one per session.
 *
 * ## The trust boundary runs through this file
 *
 * The webview renders and collects clicks. Everything that touches the machine —
 * reading a file, choosing a model, running the agent — happens here, in the
 * extension host. Messages arriving from the webview are *requests*, validated like
 * any other untrusted input, never instructions to be carried out as sent.
 *
 * Concretely: the webview never sends a path to read. It sends "the user clicked
 * attach", and this side opens VS Code's own file picker. That way a compromised
 * webview cannot name a file, only ask for a dialog the user must answer.
 *
 * @module features/chatTab
 */

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const logger = require('../utils/logger');
const { AgentSession, ChangeSet } = require('../agent/agentSession');
const { readImage, modelSupportsImages } = require('./imageContext');

/** Bytes of entropy behind the CSP nonce. */
const NONCE_BYTES = 16;

/**
 * A fresh nonce per panel load.
 *
 * The CSP allows exactly one script tag, identified by this value. It has to be
 * unguessable and it has to change every load, or the allowance becomes permanent.
 *
 * @returns {string}
 */
function makeNonce() {
  return require('crypto').randomBytes(NONCE_BYTES).toString('base64');
}

/**
 * One chat tab.
 */
class ChatTab {
  /**
   * @param {object} options
   * @param {vscode.ExtensionContext} options.context
   * @param {object} options.app        The activated singletons from extension.js.
   * @param {number} options.sessionId
   */
  constructor(options) {
    this.context = options.context;
    this.app = options.app;
    this.sessionId = options.sessionId;

    /** @type {vscode.WebviewPanel | null} */
    this.panel = null;
    /** @type {AgentSession | null} */
    this.session = null;
    /** @type {Array<{role: string, text: string}>} */
    this.history = [];
    /** @type {Array<import('./imageContext').AttachedImage>} */
    this.pendingImages = [];
    this.mode = this.app.settings.mode || 'agent';
    this.thinkingCapacity = this.app.settings.thinkingCapacity || 'medium';
  }

  /** Create or reveal the panel. */
  reveal() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return this.panel;
    }

    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'app', 'webview');
    this.panel = vscode.window.createWebviewPanel(
      'hirayacoder.chat',
      `HirayaCoder ${this.sessionId}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // The webview may only load from its own folder. Nothing else on disk is
        // reachable, and nothing remote is reachable at all.
        localResourceRoots: [mediaRoot],
      }
    );

    this.panel.webview.html = this._html(this.panel.webview, mediaRoot);
    this.panel.onDidDispose(() => this._dispose(), null, this.context.subscriptions);
    this.panel.webview.onDidReceiveMessage(
      (message) => this._onMessage(message),
      null,
      this.context.subscriptions
    );

    return this.panel;
  }

  /**
   * Build the page, substituting the nonce and asset URIs.
   *
   * @param {vscode.Webview} webview
   * @param {vscode.Uri} mediaRoot
   * @returns {string}
   * @private
   */
  _html(webview, mediaRoot) {
    const indexPath = path.join(mediaRoot.fsPath, 'index.html');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- built from extensionUri.
    const template = fs.readFileSync(indexPath, 'utf8');
    const nonce = makeNonce();

    return template
      .replace(/%NONCE%/g, nonce)
      .replace(/%CSP_SOURCE%/g, webview.cspSource)
      .replace('%STYLE_URI%', String(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'style.css'))))
      .replace('%MAIN_URI%', String(webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'))));
  }

  /**
   * @param {object} message
   * @returns {Promise<void>}
   * @private
   */
  async _onMessage(message) {
    const type = message && message.type;
    switch (type) {
      case 'ready':
        return this._sendInit();
      case 'send':
        return this._run(String(message.text || ''));
      case 'run-plan':
        return this._runPlan(Array.isArray(message.steps) ? message.steps : []);
      case 'cancel':
        if (this.session) this.session.cancel();
        return undefined;
      case 'mode':
        this.mode = ['agent', 'plan', 'ask'].includes(message.mode) ? message.mode : 'agent';
        return undefined;
      case 'thinking':
        this.thinkingCapacity = ['low', 'medium', 'high'].includes(message.capacity)
          ? message.capacity
          : 'medium';
        return undefined;
      case 'model':
        return this._switchModel(String(message.model || ''));
      case 'permissions':
        return this._showPermissionMenu();
      case 'attach-file':
        return this._attachFile();
      case 'attach-image':
        return this._attachImage();
      case 'detach':
        return this._detach(message);
      default:
        logger.warn(`Ignored unknown webview message: ${String(type)}`);
        return undefined;
    }
  }

  /** @private */
  _post(message) {
    if (this.panel) this.panel.webview.postMessage(message);
  }

  /** @private */
  async _sendInit() {
    const models = await this.app.listModels();
    this._post({
      type: 'init',
      sessionId: this.sessionId,
      mode: this.mode,
      thinkingCapacity: this.thinkingCapacity,
      permissions: this.app.modes.snapshot(),
      models,
      activeModel: this.app.activeModel,
      capability: this.app.capability,
      history: this.history,
    });
    this._postVision();
  }

  /** @private */
  _postVision() {
    const active = (this.app.models || []).find((m) => m.name === this.app.activeModel) || null;
    this._post({
      type: 'vision',
      supported: modelSupportsImages(active),
      model: this.app.activeModel,
    });
  }

  /** @private */
  async _switchModel(name) {
    if (!name) return;
    await this.app.selectModel(name);
    this._post({
      type: 'models',
      models: await this.app.listModels(),
      activeModel: this.app.activeModel,
      capability: this.app.capability,
    });
    this._postVision();
  }

  /** @private */
  async _showPermissionMenu() {
    const modes = this.app.modes;
    const snapshot = modes.snapshot();
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: snapshot.autoEdit ? '$(check) Auto-apply edits' : 'Auto-apply edits',
          detail: 'Write and delete without asking. Deletes still confirm.',
          id: 'autoEdit',
        },
        {
          label: snapshot.autoApproveScripts ? '$(check) Auto-approve scripts' : 'Auto-approve scripts',
          detail: 'Run allow-listed commands without asking. Off by default, deliberately.',
          id: 'autoApproveScripts',
        },
      ],
      { title: 'Permissions', placeHolder: 'Toggle a permission' }
    );
    if (!picked) return;

    modes.toggle(picked.id);
    this._post({ type: 'permissions', permissions: modes.snapshot() });
  }

  /**
   * Attach a context file.
   *
   * The picker is opened here rather than accepting a path from the webview — see
   * the note at the top of the file.
   *
   * @private
   */
  async _attachFile() {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
      defaultUri: this.app.workspaceUri,
    });
    if (!picked) return;

    for (const uri of picked) {
      const result = await this.app.contextFiles.add(uri.fsPath);
      if (!result.ok) {
        vscode.window.showWarningMessage(`HirayaCoder: ${result.error}`);
        continue;
      }
      this._post({
        type: 'attached',
        file: { kind: 'file', name: path.basename(uri.fsPath), path: uri.fsPath },
      });
    }
  }

  /** @private */
  async _attachImage() {
    const active = (this.app.models || []).find((m) => m.name === this.app.activeModel) || null;
    if (!modelSupportsImages(active)) {
      // Checked again on this side: the button being disabled is a convenience, not
      // a guarantee, and a text-only model would silently ignore the image.
      vscode.window.showWarningMessage(
        `HirayaCoder: ${this.app.activeModel || 'The selected model'} cannot read images. ` +
          'Switch to a vision model such as gemma4 or qwen3.5.'
      );
      return;
    }

    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach image',
      filters: { Images: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
    });
    if (!picked) return;

    for (const uri of picked) {
      const result = await readImage(uri.fsPath);
      if (!result.ok) {
        vscode.window.showWarningMessage(`HirayaCoder: ${result.error}`);
        continue;
      }
      this.pendingImages.push(result.image);
      this._post({
        type: 'attached',
        file: {
          kind: 'image',
          name: result.image.name,
          path: result.image.path,
          dataUri: result.image.dataUri,
        },
      });
      logger.info(`Attached image ${result.image.name} (${Math.round(result.image.bytes / 1024)} KB).`);
    }
  }

  /** @private */
  _detach(message) {
    if (message.kind === 'image') {
      this.pendingImages = this.pendingImages.filter((image) => image.path !== message.path);
    } else if (message.path) {
      this.app.contextFiles.remove(message.path);
    }
  }

  /**
   * Run a task that came from an editor action rather than the chat box.
   *
   * The prompt is echoed into the transcript as a user message before it runs. An
   * assistant reply appearing with nothing above it reads as the extension acting on
   * its own, and the user needs to see exactly what was asked — these prompts are
   * generated, not typed, so they are the one thing the user did not write.
   *
   * The mode is set for this turn only; the tab's own mode selector is not moved
   * under the user, except where Explain forces Ask, which can only narrow what is
   * possible.
   *
   * @param {string} task
   * @param {string} mode
   * @returns {Promise<void>}
   */
  async runExternalTask(task, mode) {
    if (this.session) {
      vscode.window.showInformationMessage('HirayaCoder: finish or stop the current turn first.');
      return;
    }

    const previousMode = this.mode;
    this.mode = ['agent', 'plan', 'ask'].includes(mode) ? mode : this.mode;
    this._post({ type: 'external-task', text: task });
    try {
      await this._run(task);
    } finally {
      this.mode = previousMode;
    }
  }

  /**
   * Hand an approved plan to Agent mode.
   *
   * The steps sent back are whatever the user left in the checklist, which may not
   * be what the model proposed — that is the whole point of Plan mode being
   * editable. They are treated as a fresh instruction, and the mode is switched
   * explicitly so the next message is not silently still in Plan.
   *
   * @param {string[]} steps
   * @private
   */
  async _runPlan(steps) {
    const cleaned = steps.map((step) => String(step).trim()).filter(Boolean).slice(0, 20);
    if (cleaned.length === 0) return;

    this.mode = 'agent';
    const task = `Carry out this plan:\n${cleaned.map((step, i) => `${i + 1}. ${step}`).join('\n')}`;
    await this._run(task);
  }

  /**
   * Run one turn.
   *
   * @param {string} text
   * @private
   */
  async _run(text) {
    if (!text.trim()) return;
    if (!this.app.capability) {
      this._post({ type: 'error', message: 'No Ollama model is selected. Pick one from the dropdown.' });
      return;
    }

    this.history.push({ role: 'user', text });
    this._post({ type: 'start' });

    const images = this.pendingImages.slice();
    this.pendingImages = [];

    this.session = new AgentSession({
      client: this.app.client,
      model: this.app.activeModel,
      capability: this.app.capability,
      gate: this.app.gate,
      workspaceRoot: this.app.workspaceRoot,
      memory: this.app.memoryFor(this.sessionId),
      translator: this.app.translator,
      contextFiles: this.app.contextFiles,
      thinkingCapacity: this.thinkingCapacity,
      sessionId: String(this.sessionId),
      scriptTimeoutMs: this.app.settings.scriptTimeoutMs,
      images: images.map((image) => image.base64),
    });

    try {
      const result = await this.session.run(text, {
        mode: this.mode,
        editor: this._editorContext(),
        onEvent: (event) => this._onAgentEvent(event),
      });

      this.history.push({ role: 'assistant', text: result.summary });
      this._post({
        type: 'done',
        summary: result.summary,
        todos: result.todos || null,
        changes: result.changeSet instanceof ChangeSet ? result.changeSet.list() : [],
        plan: result.plan || null,
      });
    } catch (err) {
      const message = /** @type {Error} */ (err).message;
      logger.error(`Chat turn failed: ${message}`);
      this._post({ type: 'error', message });
    } finally {
      this.session = null;
    }
  }

  /** @private */
  _onAgentEvent(event) {
    switch (event.type) {
      case 'thinking':
        return this._post({ type: 'thinking', step: event.step, maxSteps: event.maxSteps });
      case 'action':
        return this._post({ type: 'action', step: event.step, action: event.action });
      case 'observation':
        return this._post({
          type: 'observation',
          step: event.step,
          result: { ok: event.result.ok, observation: String(event.result.observation || '').slice(0, 2000) },
        });
      case 'todo':
        return this._post({ type: 'todo', items: event.items });
      case 'todo-item-done':
        return undefined;
      default:
        return undefined;
    }
  }

  /** @private */
  _editorContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    return {
      path: editor.document.uri.fsPath,
      content: editor.document.getText(),
      selection: editor.document.getText(editor.selection),
      language: editor.document.languageId,
    };
  }

  /** @private */
  _dispose() {
    if (this.session) this.session.cancel();
    this.panel = null;
  }
}

module.exports = { ChatTab, makeNonce };
