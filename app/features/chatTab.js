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
const { budgetsFor } = require('../core/modelCapability');
const { TranscriptStore } = require('../core/transcriptStore');
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
   * @param {() => void} [options.onPanelActive] This tab took focus.
   * @param {() => void} [options.onRetire]      This tab is finished with; forget it.
   */
  constructor(options) {
    this.context = options.context;
    this.app = options.app;
    this.sessionId = options.sessionId;
    this.onPanelActive = options.onPanelActive || (() => {});
    this.onRetire = options.onRetire || (() => {});
    /** Set once `onRetire` has fired, so it cannot fire twice. */
    this._retired = false;
    /**
     * When the panel was closed out from under a turn that was still running.
     *
     * A closed tab used to cancel the turn. That is the right answer for a queued one
     * and the wrong answer for a running one: a two-minute step budget on CPU inference
     * means the agent is regularly mid-build when someone closes the wrong tab, and
     * everything it had done was thrown away at the moment it could least afford it.
     * Now the run continues headless — the permission dialogs are VS Code modals, not
     * webview panels, so it can still ask — and the transcript records the outcome for
     * whenever the session is reopened.
     *
     * @type {number | null}
     */
    this._detachedAt = null;

    /**
     * The question this tab is currently blocked on, if any.
     *
     * The run holding the other end of `resolve` cannot proceed until it is called, so
     * every path that removes the card has to settle it — see `_cancelClarification`.
     *
     * @type {{id: string, resolve: (answer: object | null) => void} | null}
     */
    this._pendingClarification = null;

    /** @type {vscode.WebviewPanel | null} */
    this.panel = null;
    /** @type {AgentSession | null} */
    this.session = null;
    /**
     * True from the moment a turn is accepted until it finishes — including the stretch
     * where it is queued behind another tab and `session` is still null. Both halves
     * count as busy, or a second message sent during the wait would queue behind the
     * first message from the same tab.
     *
     * @type {boolean}
     */
    this._starting = false;
    /**
     * Cancels a turn that is still waiting for the shared lane. Distinct from
     * `session.cancel()`, which can only stop a turn that has actually begun.
     *
     * @type {AbortController | null}
     */
    this._queueAbort = null;
    /**
     * The visible conversation. Display state only — the model is given `memory` and a
     * freshly built context, never this. That is what makes it safe to persist
     * verbatim, and why restoring it changes what a reopened tab looks like rather
     * than how the agent behaves.
     *
     * @type {Array<{role: string, text: string}>}
     */
    this.history = [];

    // A session outlives the tab it was opened from: its memory file stays on disk and
    // the activity bar lists it. Before this, resuming one produced an empty panel —
    // the notes were still there, but everything the user had actually read was gone.
    this.transcript = this.app.workspaceRoot
      ? new TranscriptStore(this.app.workspaceRoot, this.sessionId)
      : null;
    /** @type {Array<import('./imageContext').AttachedImage>} */
    this.pendingImages = [];
    this.mode = this.app.settings.mode || 'agent';
    this.thinkingCapacity = this.app.settings.thinkingCapacity || 'medium';
    /**
     * Experimental step sessions, per tab.
     *
     * Seeded from the setting and then owned by the tab, like `mode` and
     * `thinkingCapacity`: the header toggle changes this conversation, not the user's
     * global preference. Someone trying the feature on one task should not find it on
     * in every other window.
     */
    this.stepSessions = this.app.settings.stepSessions === true;
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

    // The editor tab otherwise shows VS Code's generic webview glyph, which makes a
    // HirayaCoder tab indistinguishable from any other panel at a glance. The
    // full-colour tile is used rather than the activity bar's monochrome glyph: tab
    // icons are not recoloured by the theme, so the flat one would read as a smudge.
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'docs', 'assets', 'icon-128.png');

    this.panel.webview.html = this._html(this.panel.webview, mediaRoot);
    // Wired per panel rather than once per tab: a session that kept running after its
    // tab was closed gets a *second* panel when it is reopened, and that one needs the
    // same handlers or the tab is never cleaned up.
    const panel = this.panel;
    panel.onDidDispose(() => this._dispose(panel), null, this.context.subscriptions);
    panel.onDidChangeViewState(
      () => {
        if (panel.active) this.onPanelActive();
      },
      null,
      this.context.subscriptions
    );
    panel.webview.onDidReceiveMessage((message) => this._onMessage(message), null, this.context.subscriptions);

    return this.panel;
  }

  /** Is this tab in the middle of a turn — queued or running? */
  isBusy() {
    return Boolean(this.session || this._starting);
  }

  /** Is this session running with nobody watching it? */
  isDetached() {
    return this._detachedAt !== null && this.panel === null;
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
        // Both, and in this order. A turn still queued has no session to cancel, and a
        // running one has a spent queue controller — aborting it is a no-op.
        if (this._queueAbort) this._queueAbort.abort();
        if (this.session) this.session.cancel();
        return undefined;
      case 'mode':
        this.mode = ['agent', 'plan', 'ask'].includes(message.mode) ? message.mode : 'agent';
        return undefined;
      case 'thinking':
        this.thinkingCapacity = ['low', 'medium', 'high'].includes(message.capacity)
          ? message.capacity
          : 'medium';
        return this._postStatus();
      case 'step-sessions':
        this.stepSessions = message.enabled === true;
        logger.info(`Step sessions ${this.stepSessions ? 'on' : 'off'} for session ${this.sessionId}.`);
        return this._postStatus();
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
      case 'clarify':
        return this._answerClarification(message);
      default:
        logger.warn(`Ignored unknown webview message: ${String(type)}`);
        return undefined;
    }
  }

  /** @private */
  _post(message) {
    if (this.panel) this.panel.webview.postMessage(message);
  }

  /**
   * Put a question to the user and wait for the card to come back answered.
   *
   * ## The two ways this must not hang
   *
   * A run is blocked while this promise is pending, so every way out of the panel has
   * to resolve it. Closing the tab disposes the panel, which fires `onDidDispose` and
   * settles this as cancelled (see `_retire`); pressing Stop aborts the session, which
   * lands in the same place. Without both, a user who closes a tab mid-question leaves
   * an agent session pinned on a promise nothing will ever resolve — holding its lane
   * in the turn queue against every other tab.
   *
   * Only one question can be outstanding at a time, which is a property of the caller:
   * `agentSession` asks and awaits inside a single loop step. A second arriving while
   * one is pending is a bug, so the first is cancelled rather than silently dropped.
   *
   * @param {import('../agent/clarification').Clarification} request
   * @returns {Promise<import('../agent/clarification').ClarificationAnswer | null>}
   * @private
   */
  _askUser(request) {
    if (!this.panel) return Promise.resolve(null);

    if (this._pendingClarification) {
      logger.warn('A second question arrived while one was still open; cancelling the first.');
      this._pendingClarification.resolve({ id: this._pendingClarification.id, cancelled: true });
    }

    return new Promise((resolve) => {
      this._pendingClarification = { id: request.id, resolve };
      this._post({ type: 'clarify', request });
    });
  }

  /**
   * The user answered — or the card was dismissed.
   *
   * @param {object} message
   * @private
   */
  _answerClarification(message) {
    const pending = this._pendingClarification;
    if (!pending) {
      logger.warn('An answer arrived with no question outstanding; ignoring it.');
      return;
    }
    // Ids are matched so a stale card from a previous turn cannot answer the current
    // question. The webview is trusted to render, never to decide what it is replying to.
    if (message.id && message.id !== pending.id) {
      logger.warn('An answer arrived for a question that is no longer open; ignoring it.');
      return;
    }

    this._pendingClarification = null;
    pending.resolve({
      id: pending.id,
      optionId: typeof message.optionId === 'string' ? message.optionId : undefined,
      text: typeof message.text === 'string' ? message.text : undefined,
      cancelled: message.cancelled === true,
    });
  }

  /**
   * Settle any outstanding question as cancelled.
   *
   * Called from every path that takes the panel away from the user mid-run. Safe to
   * call when nothing is pending.
   *
   * @private
   */
  _cancelClarification() {
    if (!this._pendingClarification) return;
    logger.info('A question was still open when the session ended; treating it as cancelled.');
    const pending = this._pendingClarification;
    this._pendingClarification = null;
    pending.resolve({ id: pending.id, cancelled: true });
  }

  /** @private */
  async _sendInit() {
    // Restored before the first paint, so a resumed session shows its conversation
    // rather than the welcome screen.
    if (this.transcript && this.history.length === 0) {
      this.history = (await this.transcript.load()).slice();
    }

    const models = await this.app.listModels();
    this._post({
      type: 'init',
      sessionId: this.sessionId,
      mode: this.mode,
      thinkingCapacity: this.thinkingCapacity,
      stepSessions: this.stepSessions,
      permissions: this.app.modes.snapshot(),
      models,
      activeModel: this.app.activeModel,
      capability: this.app.capability,
      history: this.history,
    });
    this._postVision();
    this._postStatus();

    // Reopened onto a turn that never stopped. The webview has just painted a finished
    // conversation, so without this it shows an idle composer over a session that is
    // still writing files — and the user's next message is refused as "a turn is
    // already running in this tab" with nothing on screen to explain why.
    if (this.isBusy()) {
      this._detachedAt = null;
      this._post({ type: 'start' });
      this._post({
        type: 'status',
        text: this.session
          ? 'This turn kept running while the tab was closed. Still working…'
          : 'This turn is waiting for another session to finish.',
      });
    }
  }

  /**
   * The one-line budget summary in the composer hint.
   *
   * Deliberately the numbers the header does *not* already carry. Model name and
   * tier are in the dropdown and the badge; what a user cannot otherwise see is how
   * many steps this combination of tier and thinking capacity allows, and whether
   * the model is trusted with a TODO list. Both explain a run stopping early, which
   * is the question a small model provokes most often.
   *
   * @private
   */
  _postStatus() {
    const capability = this.app.capability;
    if (!capability) return;

    const budgets = budgetsFor(capability.tier, this.thinkingCapacity);
    const context =
      budgets.promptTokenTarget >= 1000
        ? `~${Math.round(budgets.promptTokenTarget / 100) / 10}k ctx`
        : `~${budgets.promptTokenTarget} ctx`;

    // The step-session note only appears where it can actually apply. On a model that
    // cannot hold a TODO list there is no list to run step-wise, and saying "step
    // sessions" under a model that will never use them is worse than saying nothing.
    const steps = this.stepSessions && capability.canPlanTodos ? ' · step sessions' : '';

    this._post({
      type: 'status',
      text: `${budgets.maxSteps} steps · ${context}${capability.canPlanTodos ? ' · TODO lists' : ''}${steps}`,
    });
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
    this._postStatus();
  }

  /**
   * The permissions menu.
   *
   * Delegated to `hirayacoder.permissions` rather than reimplemented here. This tab
   * used to render its own quick pick and apply the result with `modes.toggle(id)` —
   * a method `PermissionModes` has never had, so every click threw a TypeError into
   * an unhandled rejection and both permissions were unreachable from the chat tab
   * for as long as it has existed. Auto-approve-scripts in particular could be
   * clicked indefinitely with nothing happening and no error shown.
   *
   * A second implementation is also the wrong shape for this setting: enabling
   * auto-approve-scripts requires a deliberate confirmation, which `permissionModes`
   * enforces by demanding a confirm callback, and the duplicate had none to give.
   * One menu, one enforcement path.
   *
   * @private
   */
  async _showPermissionMenu() {
    await vscode.commands.executeCommand('hirayacoder.permissions');
    this._post({ type: 'permissions', permissions: this.app.modes.snapshot() });
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
    if (this.session || this._starting) {
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

    // A turn already running in *this* tab. Refused rather than queued: a second
    // message to the same conversation almost always means the user thought the first
    // had failed, and running both in sequence answers a question they have already
    // moved on from. Queuing across tabs is different — see below.
    //
    // Without this, `this.session` was simply overwritten and the first session ran on
    // orphaned: uncancellable, still posting into this panel, and clearing
    // `this.session` for both when it finished.
    if (this.session || this._starting) {
      this._post({
        type: 'error',
        message: 'A turn is already running in this tab. Wait for it, or press Stop first.',
      });
      return;
    }

    // Snapshotted before the new message joins it: what goes to the model is the
    // conversation *up to* this turn, and the turn itself arrives as the task.
    const conversation = this.history.slice();

    this.history.push({ role: 'user', text });
    if (this.transcript) this.transcript.append('user', text);
    this._post({ type: 'start' });

    const images = this.pendingImages.slice();
    this.pendingImages = [];

    // Set between the guard above and the queue below, so a message sent while this
    // tab is still waiting for the lane is refused rather than queued behind itself.
    this._starting = true;
    // Cancels the wait as well as the turn. Stop, pressed on a tab that has not started
    // yet, has to take it out of the queue — otherwise the tab sits there until an
    // unrelated turn in another window finishes.
    this._queueAbort = new AbortController();

    /** @type {(() => void) | null} */
    let releaseLane = null;
    try {
      releaseLane = await this.app.turns.acquire({
        label: `session ${this.sessionId}`,
        signal: this._queueAbort.signal,
        onWait: ({ activeLabel }) => {
          // The one thing that must not happen is a tab that looks frozen. Ollama holds
          // one model at a time, so this wait can be a minute or more on CPU.
          this._post({
            type: 'status',
            text: `Waiting for ${activeLabel} to finish — one model turn runs at a time.`,
          });
        },
      });
    } catch {
      // Cancelled while queued. The user pressed Stop; nothing ran.
      this._starting = false;
      this._queueAbort = null;
      this.history.push({ role: 'assistant', text: 'Stopped before this turn started.' });
      this._post({ type: 'done', summary: 'Stopped before this turn started.', changes: [] });
      this._postStatus();
      return;
    }

    this.session = new AgentSession({
      client: this.app.client,
      model: this.app.activeModel,
      capability: this.app.capability,
      gate: this.app.gate,
      workspaceRoot: this.app.workspaceRoot,
      memory: this.app.memoryFor(this.sessionId),
      // Shared across tabs, like the ledger: a missing toolchain is a fact about the
      // machine, not about this conversation.
      facts: this.app.facts,
      history: this.app.fileHistory,
      // This tab's own translator. A shared one wrote every tab's notes into whichever
      // session the extension happened to open at activation.
      translator: this.app.translatorFor(this.sessionId),
      contextFiles: this.app.contextFiles,
      thinkingCapacity: this.thinkingCapacity,
      sessionId: String(this.sessionId),
      scriptTimeoutMs: this.app.settings.scriptTimeoutMs,
      // Shared across tabs: what a model has earned is a fact about this project, not
      // about this conversation.
      ledger: this.app.ledger,
      adaptation: this.app.settings.adaptation,
      // Detected once at activation and shared, like the ledger and for the same reason:
      // the operating system is a fact about the machine, not about this conversation.
      environment: this.app.environment,
      stepSessions: this.stepSessions,
      images: images.map((image) => image.base64),
      // How the session reaches the user when it is stuck or the request was
      // ambiguous. Bound to this tab, so the question appears in the conversation it
      // came from rather than in whichever tab happens to be focused.
      onClarify: (request) => this._askUser(request),
    });

    try {
      const result = await this.session.run(text, {
        mode: this.mode,
        editor: this._editorContext(),
        // `history` was display state only until 0.4.0 — written to disk, restored into
        // the panel on reopen, and never shown to the model. That is why the agent could
        // not answer "can you remember our first conversation?" except by searching the
        // workspace: the conversation was the one thing it had no access to.
        conversation,
        onEvent: (event) => this._onAgentEvent(event),
      });

      this.history.push({ role: 'assistant', text: result.summary });
      if (this.transcript) this.transcript.append('assistant', result.summary);
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
      // A turn that threw, or finished while a question was somehow still open, must
      // not leave the card up with nothing behind it.
      this._cancelClarification();
      this.session = null;
      this._starting = false;
      this._queueAbort = null;
      // Released before the status post, so the next tab starts the moment this turn
      // is done rather than after the UI has caught up.
      if (releaseLane) releaseLane();
      // Finished with nobody watching. The transcript already has the result, so
      // reopening the session shows it; the tab object itself has no further use.
      if (!this.panel) {
        logger.info(`Session ${this.sessionId} finished while its tab was closed. The transcript has the result.`);
        this._retire();
      }
      // The status line is used for in-flight notes as well as the budget summary — a
      // step retry writes into it — so it is put back once the turn is over. Otherwise
      // "Retrying step 1…" sits under the composer for the rest of the conversation.
      this._postStatus();
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
      // Both ends of an item redraw the checklist: one marks the row active, the
      // other records how it finished. Without this the list sat at "all pending"
      // for the whole run and only filled in from `result.todos` at the end — on a
      // multi-minute session, no sign of which item was being worked on.
      case 'todo-item':
      case 'todo-item-done':
        return event.items ? this._post({ type: 'todo-progress', items: event.items }) : undefined;
      // A step being run a second time looks identical to one running slowly — same
      // spinner, same trace, minutes apart on CPU inference. Saying why turns an
      // apparent hang into visible progress.
      case 'todo-item-retry':
        return this._post({
          type: 'status',
          text: `Retrying step ${event.index}: ${String(event.reason || 'it did not land').slice(0, 120)}`,
        });
      // The card itself is posted by `_askUser`, which needs the promise. This only
      // moves the status line, so a run that is waiting on someone does not look like a
      // run that has hung.
      case 'clarification':
        return this._post({ type: 'status', text: 'Waiting for your answer…' });
      case 'clarification-answered':
        return this._post({ type: 'status', text: `You chose: ${String(event.label || '').slice(0, 80)}` });
      // How the request was read, when that differed from what was typed. Shown as it
      // happens rather than only in the summary — a user watching the agent open
      // `main.js` after they typed `mian.js` should not have to wait until the end to
      // find out why.
      case 'interpretation':
        return this._post({ type: 'status', text: String(event.note || '').slice(0, 160) });
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

  /**
   * The panel was closed.
   *
   * @param {vscode.WebviewPanel} [panel] The panel that closed, if it was one of ours.
   * @private
   */
  _dispose(panel) {
    // A stale handler from a panel this tab has already replaced. Reopening a detached
    // session disposes nothing, but VS Code can deliver the old panel's dispose event
    // late, and acting on it would tear down the live one.
    if (panel && this.panel && panel !== this.panel) return;
    this.panel = null;

    // Before anything else. The run below is allowed to continue in the background, and
    // a background run blocked on a card that no longer exists would hold its lane in
    // the turn queue forever — the one way this feature could wedge the whole extension.
    this._cancelClarification();

    if (!this.session) {
      // Nothing has started. A closed tab must not keep the lane: without this, a tab
      // closed while queued would hold its place and every other tab would sit behind a
      // turn that no longer has anywhere to render.
      if (this._queueAbort) this._queueAbort.abort();
      this._retire();
      return;
    }

    // A turn is genuinely in flight. Closing a tab is not the same decision as pressing
    // Stop, and treating it as one threw away long autonomous runs on a misclick. The
    // run keeps going; the only thing lost is the live view of it.
    this._detachedAt = Date.now();
    logger.info(`Session ${this.sessionId}: tab closed mid-turn — the run continues in the background.`);
    void vscode.window
      .showInformationMessage(`HirayaCoder is still working on session ${this.sessionId}.`, 'Reopen', 'Stop')
      .then((choice) => {
        if (choice === 'Reopen') void vscode.commands.executeCommand('hirayacoder.openSession', this.sessionId);
        else if (choice === 'Stop') this.cancel();
      });
  }

  /** Stop whatever this tab is doing, queued or running. */
  cancel() {
    // A session waiting on an answer is not watching its abort signal — it is parked on
    // a promise. Settling the question is what lets it reach the signal at all.
    this._cancelClarification();
    if (this._queueAbort) this._queueAbort.abort();
    if (this.session) this.session.cancel();
  }

  /**
   * Hand this tab back to whoever is tracking it.
   *
   * Called when the panel closes with nothing running, and when a detached run ends —
   * the two ways a tab stops being worth keeping. Idempotent, because both can happen
   * to the same tab in either order.
   *
   * @private
   */
  _retire() {
    if (this._retired) return;
    this._retired = true;
    this._detachedAt = null;
    this.onRetire();
  }
}

module.exports = { ChatTab, makeNonce };
