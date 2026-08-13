'use strict';

/**
 * Activation entrypoint.
 *
 * Phase 1 wires the foundation: settings, logging, the loopback-only Ollama client,
 * model discovery, tier classification, and the status bar. The chat tab, agent
 * loop, and security layer land in later phases and hang off the same singletons
 * created here.
 *
 * @module extension
 */

const vscode = require('vscode');

const logger = require('./utils/logger');
const {
  createClient,
  assertLoopbackEndpoint,
  TIMEOUTS_BEFORE_UNRESPONSIVE,
} = require('./core/ollamaClient');
const { ModelDiscovery, pickRecommendation } = require('./core/modelDiscovery');
const modelCapability = require('./core/modelCapability');
const { StatusBar } = require('./features/statusBar');
const { PermissionModes } = require('./security/permissionModes');
const { PermissionGate } = require('./security/permissionGate');
const { AuditLog } = require('./security/auditLog');
const { IgnoreRules } = require('./security/ignoreRules');
const { TurnQueue } = require('./core/turnQueue');
const { DEFAULT_ALLOWED_BINARIES } = require('./security/scriptRunner');
const { MemoryStore, nextSessionId, listSessions } = require('./core/memoryStore');
const { OutcomeLedger } = require('./core/outcomeLedger');
const { FactStore } = require('./core/factStore');
const { FileHistory } = require('./core/fileHistory');
const earnedHints = require('./agent/earnedHints');
const { ContextFilesManager } = require('./core/contextFilesManager');
const { ContextTranslator } = require('./core/contextTranslator');
const { ChatTab } = require('./features/chatTab');
const codeActions = require('./features/codeActions');
const testGenerator = require('./features/testGenerator');
const inlineCompletion = require('./features/inlineCompletion');
const diffApply = require('./features/diffApply');
const modelManager = require('./features/modelManager');
const { SessionsProvider } = require('./features/sessionsView');
const { TranscriptStore } = require('./core/transcriptStore');

/** Workspace-state key holding models the user has waved off the ">7B" nudge for. */
const DISMISSED_RECOMMENDATIONS_KEY = 'hirayacoder.dismissedRecommendations';

/** Open chat tabs by session id — one tab per session, never two onto one memory file. */
/** @type {Map<number, ChatTab>} */
const openChatTabs = new Map();

/** The activity bar list, so any command that changes the sessions can refresh it. */
/** @type {import('./features/sessionsView').SessionsProvider | null} */
let sessionsProvider = null;

/**
 * The session whose tab the user last had focused.
 *
 * "Show Session Memory" has to mean the conversation on screen. It used to mean the
 * session activation happened to open, which was the right answer only for the first
 * tab of a window and silently wrong for every one after it.
 *
 * @type {number | null}
 */
let lastActiveSessionId = null;

/**
 * @typedef {object} Settings
 * @property {string} endpoint
 * @property {number} requestTimeoutMs
 * @property {string} selectedModel
 * @property {number} liteTierMaxParams
 * @property {number} todoMinParams
 * @property {Record<string, 'A' | 'B'>} tierOverrides
 * @property {number} recommendAboveParams
 * @property {import('./core/modelCapability').ThinkingCapacity} thinkingCapacity
 * @property {'agent' | 'plan' | 'ask'} mode
 * @property {{autoEdit: boolean, autoApproveScripts: boolean}} permissions
 * @property {boolean} statusBarEnabled
 * @property {{enabled: boolean, hintThreshold: number}} adaptation
 * @property {boolean} stepSessions   Experimental; see `agent/stepBrief`.
 * @property {import('./utils/logger').LogLevel} logLevel
 */

/**
 * Read the full settings block.
 *
 * @returns {Settings}
 */
function readSettings() {
  const cfg = vscode.workspace.getConfiguration('hirayacoder');
  return {
    endpoint: cfg.get('ollama.endpoint', 'http://127.0.0.1:11434'),
    requestTimeoutMs: cfg.get('ollama.requestTimeoutMs', 300000),
    selectedModel: cfg.get('model.selected', ''),
    liteTierMaxParams: cfg.get('model.liteTierMaxParams', 3),
    todoMinParams: cfg.get('model.todoMinParams', 2),
    tierOverrides: cfg.get('model.tierOverrides', {}),
    recommendAboveParams: cfg.get('model.recommendAboveParams', 7),
    thinkingCapacity: cfg.get('thinkingCapacity', 'medium'),
    mode: cfg.get('mode', 'agent'),
    permissions: {
      autoEdit: cfg.get('permissions.autoEdit', false),
      autoApproveScripts: cfg.get('permissions.autoApproveScripts', false),
      alwaysConfirmDeletes: cfg.get('permissions.alwaysConfirmDeletes', true),
    },
    extraAllowedBinaries: cfg.get('scripts.allowedBinaries', []),
    scriptTimeoutMs: cfg.get('scripts.timeoutMs', 120000),
    protectedPaths: cfg.get('security.protectedPaths', ['.git', '.hirayacoder']),
    statusBarEnabled: cfg.get('statusBar.enabled', true),
    adaptation: {
      enabled: cfg.get('adaptation.enabled', true),
      hintThreshold: cfg.get('adaptation.hintThreshold', earnedHints.DEFAULT_THRESHOLD),
    },
    stepSessions: cfg.get('experimental.stepSessions', false),
    logLevel: cfg.get('logLevel', 'info'),
  };
}

/**
 * The workspace folder the agent is confined to. Multi-root workspaces use the
 * first folder; everything else in the security layer resolves against this one
 * path, so it must be decided in exactly one place.
 *
 * @returns {string | null}
 */
function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
}

/**
 * Holds the wired-up singletons other phases build on.
 */
class HirayaCoder {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    this.context = context;
    this.settings = readSettings();
    this.statusBar = new StatusBar(context);
    this.statusBar.setVisible(this.settings.statusBarEnabled);

    /** @type {import('./core/ollamaClient').OllamaClient | null} */
    this.client = null;
    /** @type {ModelDiscovery | null} */
    this.discovery = null;
    /** @type {import('./core/modelCapability').Capability | null} */
    this.capability = null;
    /** @type {string | null} */
    this.activeModel = null;
    /** @type {string | null} */
    this.configError = null;

    /**
     * One model turn at a time, shared by every tab.
     *
     * Ollama holds one model resident on the hardware this targets, so two tabs running
     * at once made it unload and reload between them — the second turn stalled, and the
     * first stalled behind it long enough that the user pressed Stop. Every "Request
     * aborted." in the evaluation logs is that.
     */
    this.turns = new TurnQueue();

    /** @type {import('./core/modelDiscovery').ModelRecord[]} */
    this.models = [];
    /** Memory stores by session id, so two open tabs never share one file. */
    /** @type {Map<number, MemoryStore>} */
    this.memories = new Map();

    /** @type {MemoryStore | null} */
    this.memory = null;
    /** @type {ContextFilesManager | null} */
    this.contextFiles = null;

    /** @type {OutcomeLedger | null} */
    this.ledger = null;
    /** @type {FactStore | null} */
    this.facts = null;
    /** @type {FileHistory | null} */
    this.fileHistory = null;

    this.buildClient();
    this.buildSecurityLayer();
    this.buildLedger();
    this.buildSession();
  }

  /**
   * The workspace's outcome ledger, which every chat tab shares.
   *
   * One per workspace rather than one per session: what the extension learns is about
   * a *model in this project*, and splitting the evidence per chat tab would mean a
   * model had to earn the same hint again in every new conversation.
   */
  buildLedger() {
    const root = workspaceRoot();
    this.ledger = root ? new OutcomeLedger(root) : null;
    // Workspace scope, like the ledger and for the same reason: what a session finds
    // out about this machine — that there is no JDK behind `javac`, say — is a fact
    // about the project, not about the conversation that happened to discover it. Held
    // per session it would be rediscovered from scratch in every new tab, which is
    // exactly what the evaluation sessions did, twice, at the cost of a whole run each.
    this.facts = root ? new FactStore(root) : null;
    // Workspace scope again, and for a third reason: "what did it change" is a question
    // about the project, and a user asking it a week later will not remember which chat
    // tab did the work.
    this.fileHistory = root ? new FileHistory(root) : null;
  }

  /** The workspace folder, or null when none is open. */
  get workspaceRoot() {
    return workspaceRoot();
  }

  /** @returns {vscode.Uri | undefined} */
  get workspaceUri() {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri : undefined;
  }

  /**
   * Installed models, refreshing first if the list has never been fetched.
   *
   * @returns {Promise<import('./core/modelDiscovery').DiscoveredModel[]>}
   */
  async listModels() {
    if (this.models.length === 0) await this.refresh();
    return this.models;
  }

  /**
   * Switch the active model and do not resolve until it actually is the active model.
   *
   * `setModel` only writes the setting. Adopting it happens in `onConfigChange`,
   * which the listener invokes fire-and-forget — so a caller that repainted straight
   * after this resolved read the *previous* `activeModel` and drew the dropdown back
   * to where it started. Clicking again appeared to work only because the listener
   * had caught up in the meantime.
   *
   * Reading the settings here rather than waiting for the listener matters too:
   * `_refresh` picks the active model out of `this.settings.selectedModel`, so
   * refreshing before that field is adopted would re-select the old model from the
   * new list.
   *
   * @param {string} name
   * @returns {Promise<void>}
   */
  async selectModel(name) {
    await this.setModel(name);
    this.settings = readSettings();
    await this.refresh({ force: true });
  }

  /**
   * The memory store for one chat tab.
   *
   * Each tab is its own session with its own `session<N>.txt`, so the stores are
   * cached per id — building a second one for the same session would give two
   * writers the same file and an interleaved result.
   *
   * @param {number} sessionId
   * @returns {MemoryStore | null}
   */
  memoryFor(sessionId) {
    const root = workspaceRoot();
    if (!root) return null;
    if (!this.memories.has(sessionId)) {
      this.memories.set(sessionId, new MemoryStore(root, sessionId));
    }
    return this.memories.get(sessionId) || null;
  }

  /**
   * Create the per-session memory and context stores.
   *
   * One session per chat tab is the eventual model; until the chat tab exists,
   * activation opens a single session so the memory loop is exercisable.
   *
   * @param {number} [sessionId] Resume a specific session instead of starting one.
   */
  buildSession(sessionId) {
    const root = workspaceRoot();
    if (!root) {
      this.memory = null;
      this.contextFiles = null;
      return;
    }

    const id = sessionId || nextSessionId(root);
    this.memory = this.memoryFor(id);
    this.contextFiles = new ContextFilesManager(root);
    void this.contextFiles.load();
    logger.info(`Session ${id} ready (memory: ${this.memory.filePath}).`);
  }

  /**
   * The translator that condenses one session's work into *that session's* memory.
   *
   * Per session, not per extension. There used to be a single `app.translator` bound to
   * whichever session activation happened to open, while each chat tab was given its
   * own memory store to recall from — so a tab recalled from its own file and wrote its
   * new notes into a different one. Open session 2 from the sidebar while activation
   * had reserved session 4, and session 2's work was remembered into `session4.txt`.
   *
   * Built fresh per call rather than cached: it is three fields over the shared,
   * cached `MemoryStore`, so there is nothing to keep warm and no stale copy to
   * invalidate when the model changes.
   *
   * @param {number} sessionId
   * @returns {ContextTranslator | null}
   */
  translatorFor(sessionId) {
    const store = this.memoryFor(sessionId);
    if (!this.client || !store || !this.activeModel) return null;

    return new ContextTranslator({
      client: this.client,
      memoryStore: store,
      model: this.activeModel,
    });
  }

  /**
   * Assemble the security layer. Every later phase's tool reaches the filesystem
   * and the shell exclusively through `this.gate`.
   */
  buildSecurityLayer() {
    const root = workspaceRoot();

    this.modes = new PermissionModes({
      initial: this.settings.permissions,
      persist: async (state) => {
        const cfg = vscode.workspace.getConfiguration('hirayacoder');
        await cfg.update('permissions.autoEdit', state.autoEdit, vscode.ConfigurationTarget.Workspace);
        await cfg.update(
          'permissions.autoApproveScripts',
          state.autoApproveScripts,
          vscode.ConfigurationTarget.Workspace
        );
      },
      onChange: () => this.statusBar.update({ permissions: this.modes.snapshot() }),
    });

    if (!root) {
      // Without a workspace there is nothing to confine the agent to, so the gate
      // is deliberately left null and every tool call will refuse.
      this.auditLog = null;
      this.gate = null;
      logger.warn('No workspace folder is open — file and script actions are unavailable.');
      return;
    }

    this.auditLog = new AuditLog(root);
    // Consulted before every read. Held on the app rather than built inside the gate so
    // the session-long "yes, you may read this one" grants survive a settings change
    // that rebuilds the gate — otherwise changing an unrelated setting would silently
    // re-prompt for a file the user had already allowed.
    this.ignoreRules = this.ignoreRules || new IgnoreRules(root);

    this.gate = new PermissionGate({
      workspaceRoot: root,
      modes: this.modes,
      auditLog: this.auditLog,
      ignoreRules: this.ignoreRules,
      confirm: (request) => confirmAction(request),
      allowedBinaries: [...DEFAULT_ALLOWED_BINARIES, ...this.settings.extraAllowedBinaries],
      protectedPrefixes: this.settings.protectedPaths,
      alwaysConfirmDeletes: this.settings.permissions.alwaysConfirmDeletes,
    });
  }

  /**
   * Ollama's reachability changed.
   *
   * Fired on the *transition*, never per request, so a healthy server costs nothing and
   * a flapping one leaves a short readable trail. Three things happen here and they are
   * deliberately different in loudness:
   *
   *  - The ledger gets a line, always. That is the record that answers "was it slow
   *    last Tuesday, or was it me?" weeks later.
   *  - The status bar updates, because it is already the place that shows connection.
   *  - A notification appears **only** for the states a user can act on, and only on
   *    the way into one. A toast every time a laptop wakes up would train them to
   *    dismiss the one that matters.
   *
   * @param {ReturnType<import('./core/ollamaClient').OllamaClient['healthSnapshot']>} health
   * @param {string} previous
   */
  onOllamaHealthChange(health, previous) {
    if (this.ledger) {
      void this.ledger.recordHealth({
        model: this.activeModel || undefined,
        state: health.state,
        wasState: previous,
        ms: health.lastLatencyMs === null ? undefined : health.lastLatencyMs,
      });
    }

    this.statusBar.update({
      connection: health.state === 'up' ? 'online' : 'offline',
      error: health.state === 'up' ? undefined : health.lastError || `Ollama is ${health.state}.`,
    });

    if (!health.needsRestart) {
      // Recovery is worth saying once, and only to someone who saw the failure.
      if (previous === 'down' || previous === 'unresponsive') {
        vscode.window.setStatusBarMessage('$(check) HirayaCoder: Ollama is responding again.', 5000);
      }
      return;
    }

    const detail =
      health.state === 'down'
        ? `Nothing is listening on ${this.settings.endpoint}. Start it with \`ollama serve\`.`
        : `Ollama accepted the connection but did not answer ${TIMEOUTS_BEFORE_UNRESPONSIVE} requests in a row. It is probably wedged — restarting it usually fixes this.`;

    void vscode.window.showWarningMessage(`HirayaCoder: Ollama is ${health.state}. ${detail}`, 'Show Logs').then((choice) => {
      if (choice === 'Show Logs') void vscode.commands.executeCommand('hirayacoder.showLogs');
    });
  }

  /**
   * (Re)create the client from current settings. A non-loopback endpoint fails here
   * rather than at request time, so the status bar can explain it immediately.
   */
  buildClient() {
    try {
      assertLoopbackEndpoint(this.settings.endpoint);
      this.configError = null;
      if (this.client) {
        this.client.reconfigure({ endpoint: this.settings.endpoint, timeoutMs: this.settings.requestTimeoutMs });
      } else {
        this.client = createClient({ endpoint: this.settings.endpoint, timeoutMs: this.settings.requestTimeoutMs });
        this.client.onHealthChange = (health, previous) => this.onOllamaHealthChange(health, previous);
        this.discovery = new ModelDiscovery(this.client);
      }
      if (this.discovery) this.discovery.invalidate();
    } catch (err) {
      this.configError = /** @type {Error} */ (err).message;
      logger.error(this.configError);
      this.statusBar.update({ connection: 'offline', error: this.configError });
    }
  }

  /**
   * Probe Ollama, refresh the model list, classify the active model, and repaint.
   *
   * Refreshes are serialized rather than allowed to overlap. One model change
   * produces two of them — `selectModel` awaits one directly, and the configuration
   * listener fires another for the same write — and two `/api/tags` round-trips
   * racing each other can settle in either order, so the later-finishing one installs
   * whichever `settings.selectedModel` it captured. That is half of the two-click
   * model switch; the other half is `selectModel` not adopting the new setting first.
   *
   * @param {{force?: boolean, notifyRecommendation?: boolean}} [opts]
   * @returns {Promise<void>}
   */
  async refresh(opts = {}) {
    const run = () => this._refresh(opts);
    // Both arms run `run`: a failed refresh must not stall every refresh after it.
    this._refreshQueue = (this._refreshQueue || Promise.resolve()).then(run, run);
    return this._refreshQueue;
  }

  /**
   * One refresh pass. Never call directly — go through `refresh`.
   *
   * @param {{force?: boolean, notifyRecommendation?: boolean}} opts
   * @returns {Promise<void>}
   * @private
   */
  async _refresh(opts) {
    if (this.configError || !this.client || !this.discovery) {
      this.statusBar.update({ connection: 'offline', error: this.configError || 'Client not initialized.' });
      return;
    }

    this.statusBar.update({ connection: 'connecting' });

    const ping = await this.client.ping();
    if (!ping.reachable) {
      logger.warn(`Ollama unreachable: ${ping.error}`);
      this.statusBar.update({ connection: 'offline', error: ping.error });
      return;
    }

    /** @type {import('./core/modelDiscovery').DiscoveredModel[]} */
    let models = [];
    try {
      models = await this.discovery.list({ force: opts.force });
    } catch (err) {
      const message = /** @type {Error} */ (err).message;
      logger.error('Model discovery failed:', message);
      this.statusBar.update({ connection: 'offline', error: message });
      return;
    }

    // Kept so the chat tab can populate its dropdown and check vision support
    // without a second round-trip to Ollama.
    this.models = models;

    // Fall back to the first installed model when nothing is configured, so a fresh
    // install is usable without a settings trip.
    const configured = this.settings.selectedModel;
    const selected =
      models.find((m) => m.name === configured) || (configured ? null : models[0]) || null;

    this.activeModel = selected ? selected.name : null;
    this.capability = selected
      ? modelCapability.classify(
          {
            name: selected.name,
            params: selected.params,
            supportsTools: selected.supportsTools,
            supportsThinking: selected.supportsThinking,
            contextLength: selected.contextLength,
          },
          {
            liteTierMaxParams: this.settings.liteTierMaxParams,
            tierOverrides: this.settings.tierOverrides,
            todoMinParams: this.settings.todoMinParams,
          }
        )
      : null;

    if (this.capability) {
      logger.info(
        `Active model ${this.capability.model}: Tier ${this.capability.tier} ` +
          `(${this.capability.strategy} loop) — ${this.capability.reason}`
      );
    }

    // Nothing to rebuild for the model change: `translatorFor` reads `activeModel` at
    // the moment a turn starts, so it cannot be left pointing at the previous model.

    this.statusBar.update({
      connection: 'online',
      ollamaVersion: ping.version,
      model: this.activeModel,
      capability: this.capability,
      modelCount: models.length,
      thinkingCapacity: this.settings.thinkingCapacity,
      mode: this.settings.mode,
      permissions: this.settings.permissions,
      error: undefined,
    });

    if (models.length === 0) {
      void this.promptNoModels();
      return;
    }

    if (opts.notifyRecommendation) void this.maybeRecommend(models);
  }

  /**
   * First-run state with nothing pulled. The welcome screen shows this inline once
   * the chat tab exists; until then a notification carries the same guidance.
   */
  async promptNoModels() {
    const pull = 'Copy pull command';
    const choice = await vscode.window.showWarningMessage(
      'HirayaCoder: no Ollama models found. Run `ollama pull llama3.2:1b` to get started.',
      pull
    );
    if (choice === pull) {
      await vscode.env.clipboard.writeText('ollama pull llama3.2:1b');
      vscode.window.showInformationMessage('Copied `ollama pull llama3.2:1b` to your clipboard.');
    }
  }

  /**
   * One-time, dismissible nudge when a meaningfully larger model is installed.
   * Never switches the model on its own.
   *
   * @param {import('./core/modelDiscovery').DiscoveredModel[]} models
   */
  async maybeRecommend(models) {
    const dismissed = new Set(this.context.globalState.get(DISMISSED_RECOMMENDATIONS_KEY, []));
    const recommendation = pickRecommendation(models, this.activeModel || '', {
      recommendAboveParams: this.settings.recommendAboveParams,
      dismissed,
    });
    if (!recommendation) return;

    const switchTo = `Switch to ${recommendation.model}`;
    const dismiss = "Don't show again";
    const choice = await vscode.window.showInformationMessage(recommendation.message, switchTo, dismiss);

    if (choice === switchTo) {
      await this.setModel(recommendation.model);
    } else if (choice === dismiss) {
      dismissed.add(recommendation.model);
      await this.context.globalState.update(DISMISSED_RECOMMENDATIONS_KEY, Array.from(dismissed));
    }
  }

  /**
   * @param {string} name
   */
  async setModel(name) {
    await vscode.workspace
      .getConfiguration('hirayacoder')
      .update('model.selected', name, vscode.ConfigurationTarget.Global);
    // The configuration listener triggers the refresh.
  }

  /**
   * React to a settings change.
   *
   * @param {vscode.ConfigurationChangeEvent} event
   */
  async onConfigChange(event) {
    if (!event.affectsConfiguration('hirayacoder')) return;

    const previous = this.settings;
    this.settings = readSettings();
    logger.setLevel(this.settings.logLevel);
    this.statusBar.setVisible(this.settings.statusBarEnabled);

    // Adopt permission changes made directly in settings.json rather than through
    // the menu. `hydrate` deliberately does not write back, so this cannot loop.
    this.modes.hydrate(this.settings.permissions);

    if (
      event.affectsConfiguration('hirayacoder.scripts') ||
      event.affectsConfiguration('hirayacoder.security')
    ) {
      this.buildSecurityLayer();
    }

    if (
      previous.endpoint !== this.settings.endpoint ||
      previous.requestTimeoutMs !== this.settings.requestTimeoutMs
    ) {
      this.buildClient();
      if (this.configError) {
        vscode.window.showErrorMessage(this.configError);
        return;
      }
    }

    await this.refresh({ force: true });
  }

  dispose() {
    // Status bar item is registered in context.subscriptions; nothing else holds
    // OS resources yet. Later phases dispose panels and running child processes here.
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  const channel = vscode.window.createOutputChannel('HirayaCoder');
  context.subscriptions.push(channel);
  logger.attach(channel);

  const app = new HirayaCoder(context);
  logger.setLevel(app.settings.logLevel);
  logger.info('HirayaCoder activating — offline mode, local Ollama only.');

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      void app.onConfigChange(event);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hirayacoder.showLogs', () => channel.show(true)),

    vscode.commands.registerCommand('hirayacoder.refreshModels', async () => {
      await app.refresh({ force: true, notifyRecommendation: true });
      if (app.activeModel) {
        vscode.window.showInformationMessage(`HirayaCoder: refreshed. Active model: ${app.activeModel}.`);
      }
    }),

    vscode.commands.registerCommand('hirayacoder.selectModel', () => selectModelCommand(app)),

    vscode.commands.registerCommand('hirayacoder.showStatus', () => showStatusCommand(app)),

    vscode.commands.registerCommand('hirayacoder.permissions', () => permissionsCommand(app)),

    vscode.commands.registerCommand('hirayacoder.showAuditLog', () => showAuditLogCommand(app)),

    vscode.commands.registerCommand('hirayacoder.showFileHistory', () => showFileHistoryCommand(app)),

    vscode.commands.registerCommand('hirayacoder.showAdaptation', () => showAdaptationCommand(app)),

    vscode.commands.registerCommand('hirayacoder.resetAdaptation', () => resetAdaptationCommand(app)),

    vscode.commands.registerCommand('hirayacoder.showMemory', () => showMemoryCommand(app)),

    vscode.commands.registerCommand('hirayacoder.clearMemory', () => clearMemoryCommand(app)),

    vscode.commands.registerCommand('hirayacoder.attachContextFile', () => attachContextFileCommand(app)),

    vscode.commands.registerCommand('hirayacoder.openChat', () => openChatCommand(context, app)),

    // Invoked by the activity bar list, which supplies the id. Falls back to the
    // ordinary picker if it is ever called without one.
    vscode.commands.registerCommand('hirayacoder.openSession', (sessionId) => {
      if (typeof sessionId !== 'number') return openChatCommand(context, app);
      return openSession(context, app, sessionId);
    }),

    vscode.commands.registerCommand('hirayacoder.refreshSessions', () => {
      if (sessionsProvider) sessionsProvider.refresh();
    }),

    vscode.commands.registerCommand('hirayacoder.pullModel', () => modelManager.pullModelCommand(app))
  );

  // Editor-side features. Each one funnels into the same chat session rather than
  // running its own agent, so the permission gate and audit log see every action
  // regardless of which entry point started it.
  sessionsProvider = new SessionsProvider(() => workspaceRoot());
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('hirayacoder.sessions', sessionsProvider),
    sessionsProvider
  );

  diffApply.register(context);
  codeActions.register(context, (task, opts) => sendToChat(context, app, task, opts));
  testGenerator.register(context, (task, opts) => sendToChat(context, app, task, opts));
  inlineCompletion.register(context, {
    getClient: () => app.client,
    getModel: () => app.activeModel,
    isEnabled: () => vscode.workspace.getConfiguration('hirayacoder').get('inlineCompletion.enabled', false),
    // A chat turn already has the model saturated; competing for it would slow the
    // response the user is actually watching.
    isBusy: () => [...openChatTabs.values()].some((tab) => tab.session !== null),
  });

  context.subscriptions.push({ dispose: () => app.dispose() });

  void app.refresh({ force: true, notifyRecommendation: true });

  // Exposed for integration tests and for later phases to reach the singletons.
  return { app };
}

/**
 * A session number nothing has claimed — on disk, or by a tab open in this window.
 *
 * Both of a session's files are written lazily, so the open tabs are the only record
 * of a session that exists but has not been used yet.
 *
 * @param {string} root
 * @returns {number}
 */
function newSessionId(root) {
  return nextSessionId(root, { reserved: [...openChatTabs.keys()] });
}

/**
 * Send a task from an editor feature into a chat tab.
 *
 * Reuses an open tab where there is one, so a Refactor and a Fix on the same file
 * land in the same conversation and share its memory. Only when nothing is open does
 * it start a session — an editor action should not silently create a new memory file
 * every time it is used.
 *
 * *Which* open tab is the one the user was last looking at. Taking the first entry of
 * the map meant that with several sessions open, a Refactor could land in whichever tab
 * happened to be opened earliest — a conversation the user was not watching.
 *
 * @param {vscode.ExtensionContext} context
 * @param {HirayaCoder} app
 * @param {string} task
 * @param {{mode: string}} opts
 */
async function sendToChat(context, app, task, opts) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('HirayaCoder: open a folder first.');
    return;
  }

  let tab =
    (lastActiveSessionId !== null ? openChatTabs.get(lastActiveSessionId) : undefined) ||
    [...openChatTabs.values()][0];
  if (!tab) {
    // Through `openSession` rather than building the tab here, so an editor-started
    // session is registered, tracked, and listed exactly like one opened from the
    // command. The second copy of this wiring was already drifting: it never refreshed
    // the activity bar.
    const sessionId = newSessionId(root);
    openSession(context, app, sessionId);
    tab = openChatTabs.get(sessionId);
    if (!tab) return;
  } else {
    tab.reveal();
    lastActiveSessionId = tab.sessionId;
  }

  await tab.runExternalTask(task, opts.mode);
}

/**
 * Open a chat tab, resuming a session or starting a new one.
 *
 * Tabs are tracked by session id so re-running the command reveals the existing tab
 * rather than opening a second view onto the same memory file.
 *
 * @param {vscode.ExtensionContext} context
 * @param {HirayaCoder} app
 */
async function openChatCommand(context, app) {
  const root = workspaceRoot();
  if (!root) {
    vscode.window.showWarningMessage('HirayaCoder: open a folder first — the agent works inside a workspace.');
    return;
  }

  const existing = listSessions(root);
  /** @type {number} */
  let sessionId;

  if (existing.length === 0) {
    sessionId = newSessionId(root);
  } else {
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(add) New session', id: -1, detail: 'Start with empty memory' },
        ...existing.map((session) => ({
          label: `$(comment-discussion) Session ${session.sessionId}`,
          id: session.sessionId,
          // A session that has been talked to but has produced nothing worth
          // remembering is a real session, and now appears here. "0 remembered
          // fact(s)" would read as an empty slot rather than a conversation.
          detail:
            session.entries === 0
              ? 'No notes yet'
              : `${session.entries} remembered fact${session.entries === 1 ? '' : 's'}`,
        })),
      ],
      { title: 'HirayaCoder', placeHolder: 'Resume a session or start a new one' }
    );
    if (!picked) return;
    sessionId = picked.id === -1 ? newSessionId(root) : picked.id;
  }

  openSession(context, app, sessionId);
}

/**
 * Reveal a session's tab, creating it if it is not already open.
 *
 * Tabs are tracked by session id so two entry points — the command's quick-pick and
 * the activity bar list — can never open two views onto the same memory file.
 *
 * @param {vscode.ExtensionContext} context
 * @param {HirayaCoder} app
 * @param {number} sessionId
 */
function openSession(context, app, sessionId) {
  const open = openChatTabs.get(sessionId);
  if (open) {
    open.reveal();
    lastActiveSessionId = sessionId;
    return;
  }

  // Both handlers belong to the tab rather than to a panel, because a session that
  // kept running after its tab was closed opens a *second* panel when it is reopened.
  // Wired to the first panel only, the tab would never be forgotten and focus would
  // stop following it.
  const tab = new ChatTab({
    context,
    app,
    sessionId,
    // Which session the memory commands mean is decided by which tab the user is
    // looking at, so it has to follow focus rather than be sampled when a command runs
    // — by then the quick-pick has taken focus and every panel reports inactive.
    onPanelActive: () => {
      lastActiveSessionId = sessionId;
    },
    onRetire: () => {
      openChatTabs.delete(sessionId);
      if (lastActiveSessionId === sessionId) lastActiveSessionId = null;
    },
  });
  openChatTabs.set(sessionId, tab);
  tab.reveal();
  lastActiveSessionId = sessionId;

  // A brand-new session has no memory file until something is remembered, so the list
  // would not show it otherwise.
  if (sessionsProvider) sessionsProvider.refresh();
}

/**
 * Quick-pick over installed models, annotated with tier and size.
 *
 * @param {HirayaCoder} app
 */
async function selectModelCommand(app) {
  if (!app.discovery) {
    vscode.window.showErrorMessage(app.configError || 'HirayaCoder is not connected to Ollama.');
    return;
  }

  /** @type {import('./core/modelDiscovery').DiscoveredModel[]} */
  let models;
  try {
    // Always re-poll: models can be pulled outside the extension at any time.
    models = await app.discovery.list({ force: true });
  } catch (err) {
    vscode.window.showErrorMessage(`HirayaCoder: ${/** @type {Error} */ (err).message}`);
    return;
  }

  if (models.length === 0) {
    await app.promptNoModels();
    return;
  }

  const items = models.map((model) => {
    const capability = modelCapability.classify(
      {
        name: model.name,
        params: model.params,
        supportsTools: model.supportsTools,
        supportsThinking: model.supportsThinking,
        contextLength: model.contextLength,
      },
      {
        liteTierMaxParams: app.settings.liteTierMaxParams,
        tierOverrides: app.settings.tierOverrides,
        todoMinParams: app.settings.todoMinParams,
      }
    );
    return {
      label: model.name === app.activeModel ? `$(check) ${model.name}` : model.name,
      description:
        `${model.paramsLabel} · ${capability.label} (Tier ${capability.tier})` +
        // Surfaced in the picker because it changes how the model behaves on a
        // multi-part request, not just how fast it is.
        (capability.canPlanTodos ? ' · TODO' : ''),
      detail: capability.reason,
      modelName: model.name,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'HirayaCoder — select a model',
    placeHolder: 'All models run the full agent loop; the tier only changes how actions are produced.',
    matchOnDescription: true,
  });

  if (picked) await app.setModel(picked.modelName);
}

/**
 * The confirmation dialog behind every gated action.
 *
 * Modal on purpose: an approval that scrolls past in a notification toast is not an
 * approval. The destructive affordance is reserved for deletes and elevated-risk
 * commands so the styling still means something when it appears.
 *
 * @param {import('./security/permissionGate').ConfirmRequest} request
 * @returns {Promise<boolean>}
 */
async function confirmAction(request) {
  // A write arrives with both versions of the file, so the answer can be given
  // against the actual diff rather than a line count. Anything else — a delete, a
  // command, or a write whose content did not survive the trip — falls through to
  // the plain modal below.
  if (request.kind === 'write' && typeof request.after === 'string' && request.absolute) {
    return diffApply.confirmChange({
      path: request.path,
      absolute: request.absolute,
      before: request.before === undefined ? null : request.before,
      after: request.after,
      summary: request.detail,
    });
  }

  const approve =
    request.kind === 'delete'
      ? 'Delete'
      : request.kind === 'script'
        ? 'Run'
        : request.kind === 'read'
          ? 'Read'
          : 'Apply';
  const detail =
    request.risk === 'elevated'
      ? `⚠ ${request.detail}`
      : request.detail || '';

  const choice = await vscode.window.showWarningMessage(
    request.title,
    { modal: true, detail },
    approve
  );
  return choice === approve;
}

/**
 * The permissions menu — all four states visible at once, never hidden in settings.
 *
 * @param {HirayaCoder} app
 */
async function permissionsCommand(app) {
  const state = app.modes.snapshot();

  const items = [
    {
      label: state.autoEdit ? '$(check) Auto Edit' : 'Auto Edit',
      description: state.autoEdit ? 'currently on' : 'currently off — every write asks first',
      // Names the prompt it governs. The two toggles are independent and each covers
      // exactly one kind of action, which was not obvious from the labels: a user who
      // turned on Auto Approve Running Scripts reasonably expected the Create/Apply
      // dialogs to stop, and they are the other toggle's.
      detail:
        'Covers file writes and deletes — the Create/Apply prompts. Does NOT cover terminal commands; those are Auto Approve Running Scripts, below. Path guards and folder-delete confirmations still apply.',
      action: 'toggleEdit',
    },
    {
      label: state.autoApproveScripts ? '$(check) Auto Approve Running Scripts' : 'Auto Approve Running Scripts',
      description: state.autoApproveScripts ? 'currently on' : 'currently off — every command asks first',
      detail:
        'Covers terminal commands only — npm, javac, python. Does NOT cover file writes; those are Auto Edit, above. Highest-risk setting. Commands that reach the network or publish code still always ask.',
      action: 'toggleScripts',
    },
    {
      label: '$(shield) Reset to safest',
      description: 'approve edits + approve scripts',
      detail: 'Turns both automatic modes off.',
      action: 'reset',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `HirayaCoder Permissions — ${app.modes.badges().edits} · ${app.modes.badges().scripts}`,
    placeHolder: 'Edits and scripts are independent toggles.',
  });
  if (!picked) return;

  if (picked.action === 'toggleEdit') {
    await app.modes.setAutoEdit(!state.autoEdit);
  } else if (picked.action === 'reset') {
    await app.modes.reset();
  } else {
    // Enabling requires a deliberate, separate confirmation; disabling never does.
    await app.modes.setAutoApproveScripts(!state.autoApproveScripts, async () => {
      const proceed = 'Enable auto-run';
      const choice = await vscode.window.showWarningMessage(
        'Enable Auto Approve Running Scripts?',
        {
          modal: true,
          detail:
            'Commands the agent proposes will run without asking you first. They stay restricted to the ' +
            'allowed program list and the workspace folder, and everything is still written to the audit log — ' +
            'but you will not get a chance to review each one.\n\n' +
            'Commands that reach the network or publish code will still always ask.',
        },
        proceed
      );
      return choice === proceed;
    });
  }

  const badges = app.modes.badges();
  vscode.window.showInformationMessage(`HirayaCoder — ${badges.edits} · ${badges.scripts}`);
}

/**
 * Open the audit log as a read-only document.
 *
 * @param {HirayaCoder} app
 */
async function showAuditLogCommand(app) {
  if (!app.auditLog) {
    vscode.window.showWarningMessage('HirayaCoder: no workspace folder is open, so there is no audit log.');
    return;
  }

  await app.auditLog.flush();
  const entries = await app.auditLog.read(500);
  if (entries.length === 0) {
    vscode.window.showInformationMessage('HirayaCoder: no actions have been recorded yet.');
    return;
  }

  const lines = entries.map((entry) => {
    const target = entry.path || entry.command || '';
    const reason = entry.reason ? `  — ${entry.reason}` : '';
    return `${entry.ts}  ${String(entry.decision).padEnd(14)} ${String(entry.action).padEnd(12)} ${target}${reason}`;
  });

  const document = await vscode.workspace.openTextDocument({
    content: `HirayaCoder audit log — ${entries.length} most recent actions\n\n${lines.join('\n')}\n`,
    language: 'log',
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

/**
 * Show what the agent has changed, and what each change looked like.
 *
 * Rendered as a diff document rather than a list of paths, because the question this
 * answers is "what did it do to my file", and a path alone answers "which file" and
 * stops there. Newest first: the thing you want is almost always the last thing that
 * happened.
 *
 * @param {HirayaCoder} app
 */
async function showFileHistoryCommand(app) {
  if (!app.fileHistory) {
    vscode.window.showWarningMessage('HirayaCoder: no workspace folder is open, so nothing has been recorded.');
    return;
  }

  await app.fileHistory.flush();
  const entries = await app.fileHistory.recent({ limit: 100 });
  if (entries.length === 0) {
    vscode.window.showInformationMessage('HirayaCoder: the agent has not changed any files in this workspace yet.');
    return;
  }

  const blocks = entries.map((entry) => {
    const what =
      entry.kind === 'delete'
        ? `deleted (${entry.removed} lines)`
        : entry.kind === 'create'
          ? `created (${entry.added} lines)`
          : `edited (+${entry.added} / -${entry.removed})`;

    const header = `${entry.ts}  session ${entry.sessionId || '?'}  ${entry.model || ''}\n${entry.path} — ${what}`;
    return entry.diff ? `${header}\n${entry.diff}` : header;
  });

  const document = await vscode.workspace.openTextDocument({
    content:
      `HirayaCoder file history — ${entries.length} most recent change(s), newest first\n` +
      'Diffs are trimmed to the changed region and capped. Use git for a full history.\n\n' +
      `${blocks.join('\n\n' + '-'.repeat(70) + '\n\n')}\n`,
    language: 'diff',
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

/**
 * Show what the extension has learned about each model in this workspace.
 *
 * The design rule this command exists to satisfy: profiles are advisory, visible, and
 * resettable. A learning layer the user cannot inspect is one they cannot disagree
 * with, and a hint that makes things worse must be as easy to discard as it was to
 * acquire — hence the reset offered at the bottom.
 *
 * @param {HirayaCoder} app
 */
async function showAdaptationCommand(app) {
  if (!app.ledger) {
    vscode.window.showWarningMessage('HirayaCoder: no workspace folder is open, so nothing has been recorded.');
    return;
  }

  await app.ledger.flush();
  const profiles = await app.ledger.profiles();
  if (profiles.size === 0) {
    vscode.window.showInformationMessage(
      'HirayaCoder: no outcomes recorded yet — the profile fills in as the agent works.'
    );
    return;
  }

  const threshold = app.settings.adaptation.hintThreshold;
  const lines = [];
  for (const profile of profiles.values()) {
    const hints = earnedHints.select(profile, { threshold });
    lines.push(`${profile.model}`);
    lines.push(
      `  ${profile.sessions} session(s), ${profile.steps} action(s), ${profile.failures} failed, ` +
        `${profile.sessionsThatChanged} changed files, ${profile.declined} declined by you`
    );

    if (profile.stops.size > 0) {
      const stops = [...profile.stops].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${reason} ×${n}`);
      lines.push(`  Ended: ${stops.join(', ')}`);
    }
    if (profile.trips.size > 0) {
      const trips = [...profile.trips].sort((a, b) => b[1] - a[1]).map(([code, n]) => `${code} ×${n}`);
      lines.push(`  Guards tripped: ${trips.join(', ')}`);
    }

    if (hints.length === 0) {
      lines.push(`  Hints in force: none (a hint is earned at ${threshold} trips of the same guard)`);
    } else {
      lines.push('  Hints in force, added to this model\'s prompt:');
      for (const hint of hints) lines.push(`    - [${hint.key} ×${hint.count}] ${hint.text}`);
    }
    lines.push('');
  }

  const document = await vscode.workspace.openTextDocument({
    content:
      'HirayaCoder — what has been learned in this workspace\n\n' +
      'Built only from what the tools and guards reported, never from what a model said\n' +
      'about itself. Hints adjust how a model is prompted; they never affect permissions,\n' +
      'path confinement, or the allow-list. Run "HirayaCoder: Reset Learned Adaptation" to\n' +
      'discard all of it.\n\n' +
      `${lines.join('\n')}`,
    language: 'log',
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

/**
 * Throw away every recorded outcome, and with it every earned hint.
 *
 * @param {HirayaCoder} app
 */
async function resetAdaptationCommand(app) {
  if (!app.ledger) {
    vscode.window.showWarningMessage('HirayaCoder: no workspace folder is open, so there is nothing to reset.');
    return;
  }

  const confirm = 'Reset';
  const choice = await vscode.window.showWarningMessage(
    'Discard everything HirayaCoder has learned about your models in this workspace? ' +
      'Earned hints go with it. Your audit log and session memory are untouched.',
    { modal: true },
    confirm
  );
  if (choice !== confirm) return;

  await app.ledger.clear();
  logger.info('Outcome ledger cleared; every earned hint has been discarded.');
  vscode.window.showInformationMessage('HirayaCoder: learned adaptation reset.');
}

/**
 * Open this session's memory file. It is deliberately plain text and
 * user-editable — being able to read and correct what the agent "remembers" is
 * the point of not storing it as JSON.
 *
 * @param {HirayaCoder} app
 */
async function showMemoryCommand(app) {
  const store = currentSessionMemory(app);
  if (!store) {
    vscode.window.showWarningMessage('HirayaCoder: no workspace folder is open, so there is no session memory.');
    return;
  }

  const entries = await store.readAll();
  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      `HirayaCoder: session ${store.sessionId} has no memory yet — it fills in as the agent works.`
    );
    return;
  }

  await store.flush();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(store.filePath));
  await vscode.window.showTextDocument(document, { preview: true });
}

/**
 * The memory store the memory commands mean: the session the user is looking at,
 * falling back to the one activation opened when no chat tab is in play.
 *
 * @param {HirayaCoder} app
 * @returns {MemoryStore | null}
 */
function currentSessionMemory(app) {
  if (lastActiveSessionId !== null && openChatTabs.has(lastActiveSessionId)) {
    return app.memoryFor(lastActiveSessionId);
  }
  return app.memory;
}

/**
 * @param {HirayaCoder} app
 */
async function clearMemoryCommand(app) {
  const root = workspaceRoot();
  if (!root || !app.memory) {
    vscode.window.showWarningMessage('HirayaCoder: no workspace folder is open.');
    return;
  }

  const sessions = listSessions(root);
  if (sessions.length === 0) {
    vscode.window.showInformationMessage('HirayaCoder: there is no session memory to clear.');
    return;
  }

  const current = currentSessionMemory(app);
  const items = sessions.map((session) => ({
    label: `Session ${session.sessionId}${current && session.sessionId === current.sessionId ? ' (current)' : ''}`,
    description: `${session.entries} entr${session.entries === 1 ? 'y' : 'ies'}`,
    detail: `Last updated ${session.modifiedAt.toLocaleString()}`,
    sessionId: session.sessionId,
  }));

  // Facts are workspace-scoped, so they are not cleared by clearing any one session —
  // that is the whole point of keeping them separately. The user still needs a way to
  // retract one, because a fact that has become false ("there is no JDK here", after
  // they install one) is worse than no fact: it persists and it is stated to every
  // future turn as settled.
  const changedFiles = app.fileHistory ? (await app.fileHistory.recent({ limit: 500 })).length : 0;
  if (changedFiles > 0) {
    items.push({
      label: 'The record of what files were changed',
      description: `${changedFiles} change(s)`,
      detail: 'Diffs of every write the agent made in this workspace. Clearing this does not undo anything.',
      sessionId: -2,
    });
  }

  const knownFacts = app.facts ? (await app.facts.load()).length : 0;
  if (knownFacts > 0) {
    items.push({
      label: 'Everything this workspace has learned',
      description: `${knownFacts} fact${knownFacts === 1 ? '' : 's'}`,
      detail: 'Facts about this machine and project, shared by every session. Clear this after installing something the agent recorded as missing.',
      sessionId: -1,
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Clear session memory',
    placeHolder: 'This permanently deletes what the agent remembers.',
  });
  if (!picked) return;

  const confirm = 'Clear it';
  const clearingFacts = picked.sessionId === -1;
  const clearingHistory = picked.sessionId === -2;

  /** @type {[string, string]} */
  const [title, detail] = clearingFacts
    ? [
        'Clear what this workspace has learned?',
        'The agent will re-discover things like a missing toolchain the slow way, one failed command at a time.',
      ]
    : clearingHistory
      ? [
          'Clear the record of what files were changed?',
          'Your files are not touched — only the log of what changed and when. The agent will stop being able to tell you what it did earlier.',
        ]
      : [
          `Clear the memory for session ${picked.sessionId}?`,
          'The agent will no longer recall anything from earlier in that session.',
        ];

  const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, confirm);
  if (choice !== confirm) return;

  if (clearingFacts) {
    await app.facts.clear();
    vscode.window.showInformationMessage('HirayaCoder: cleared what this workspace had learned.');
    return;
  }

  if (clearingHistory) {
    await app.fileHistory.clear();
    vscode.window.showInformationMessage('HirayaCoder: cleared the record of file changes.');
    return;
  }

  // The cached store for that session, not a second one onto the same file. A fresh
  // instance clears the file while the one a running tab holds keeps its own entries
  // in memory — and writes them back on its next append, un-forgetting what the user
  // just asked to forget.
  await app.memoryFor(picked.sessionId).clear();

  // The conversation goes with it. Leaving the transcript behind would show the user
  // an exchange the agent has been made to forget — two different answers on screen to
  // "what happened in this session".
  //
  // Through the open tab's own store when there is one, for the same reason as the
  // memory above: a second instance deletes the file while the tab keeps its entries
  // in memory and writes them back on the next message.
  const openTab = openChatTabs.get(picked.sessionId);
  if (openTab && openTab.transcript) {
    await openTab.transcript.clear();
  } else {
    await new TranscriptStore(root, picked.sessionId).clear();
  }
  if (openTab) openTab.history = [];

  vscode.window.showInformationMessage(`HirayaCoder: cleared memory for session ${picked.sessionId}.`);
}

/**
 * Attach a reference file — the command-palette equivalent of the chat tab's `+`.
 *
 * @param {HirayaCoder} app
 */
async function attachContextFileCommand(app) {
  if (!app.contextFiles) {
    vscode.window.showWarningMessage('HirayaCoder: no workspace folder is open.');
    return;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: 'Attach as context',
    defaultUri: vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri : undefined,
  });
  if (!picked || picked.length === 0) return;

  /** @type {string[]} */
  const attached = [];
  /** @type {string[]} */
  const refused = [];
  for (const uri of picked) {
    const result = await app.contextFiles.add(uri.fsPath);
    if (result.ok) {
      attached.push(`${result.file.relativePath} (~${result.file.tokens} tokens${result.file.truncated ? ', excerpt' : ''})`);
    } else {
      refused.push(result.error);
    }
  }

  if (attached.length > 0) {
    vscode.window.showInformationMessage(`HirayaCoder attached: ${attached.join(', ')}.`);
  }
  if (refused.length > 0) {
    vscode.window.showWarningMessage(`HirayaCoder could not attach: ${refused.join(' ')}`);
  }
}

/**
 * Connection detail sheet with a retry.
 *
 * @param {HirayaCoder} app
 */
/**
 * How Ollama has been behaving, in one paragraph.
 *
 * The numbers that matter when a session felt slow and it is not obvious why: what the
 * last call cost, what calls cost on average, and the worst one — because on CPU
 * inference the average hides the model-load spike that is usually the actual
 * complaint. The full per-turn history is in `.hirayacoder/outcomes.jsonl`; this is the
 * glance.
 *
 * Empty until something has been asked of the server, rather than reporting zeros as
 * though they were measurements.
 *
 * @param {HirayaCoder} app
 * @returns {string}
 */
function describeResponsiveness(app) {
  if (!app.client || !app.client.health || app.client.health.requests === 0) return '';

  const health = app.client.healthSnapshot();
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

  const parts = [
    `Ollama is ${health.state}.`,
    `${health.requests} request(s) this session:`,
    `last ${seconds(health.lastLatencyMs || 0)},`,
    `average ${seconds(health.averageLatencyMs || 0)},`,
    `slowest ${seconds(health.slowestMs)}.`,
  ];

  if (health.consecutiveFailures > 0) {
    parts.push(`\n${health.consecutiveFailures} failure(s) in a row — last: ${health.lastError}`);
  }

  return parts.join(' ');
}

async function showStatusCommand(app) {
  const s = app.statusBar.state;

  if (s.connection !== 'online') {
    const retry = 'Retry';
    const logs = 'Show logs';
    const choice = await vscode.window.showWarningMessage(
      `HirayaCoder is offline: ${s.error || 'Ollama is not reachable.'}`,
      retry,
      logs
    );
    if (choice === retry) await app.refresh({ force: true });
    if (choice === logs) await vscode.commands.executeCommand('hirayacoder.showLogs');
    return;
  }

  const capability = app.capability;
  const budgets = capability
    ? modelCapability.budgetsFor(capability.tier, app.settings.thinkingCapacity)
    : null;

  const detail = [
    `Ollama ${s.ollamaVersion || ''} at ${app.settings.endpoint} — ${s.modelCount} model(s) installed.`,
    capability ? `${capability.model}: Tier ${capability.tier} (${capability.label}), ${capability.strategy} loop.` : 'No model selected.',
    capability ? capability.reason : '',
    budgets ? `At ${app.settings.thinkingCapacity} thinking: ${budgets.maxSteps} steps max, ${budgets.memoryRecallEntries === Infinity ? 'full' : budgets.memoryRecallEntries}-entry memory recall.` : '',
    describeResponsiveness(app),
  ]
    .filter(Boolean)
    .join('\n\n');

  const change = 'Change model';
  const choice = await vscode.window.showInformationMessage('HirayaCoder is connected.', { modal: true, detail }, change);
  if (choice === change) await vscode.commands.executeCommand('hirayacoder.selectModel');
}

function deactivate() {
  // A turn survives its tab being closed, but not the window going away: the extension
  // host is about to stop, and a `npm install` left running would be reparented with
  // nothing able to kill it or read its output.
  for (const tab of openChatTabs.values()) {
    if (tab.isBusy()) {
      logger.info(`Stopping session ${tab.sessionId}: the window is closing.`);
      tab.cancel();
    }
  }
  logger.info('HirayaCoder deactivated.');
}

module.exports = { activate, deactivate, readSettings };
