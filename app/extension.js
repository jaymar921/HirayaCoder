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
const { createClient, assertLoopbackEndpoint } = require('./core/ollamaClient');
const { ModelDiscovery, pickRecommendation } = require('./core/modelDiscovery');
const modelCapability = require('./core/modelCapability');
const { StatusBar } = require('./features/statusBar');
const { PermissionModes } = require('./security/permissionModes');
const { PermissionGate } = require('./security/permissionGate');
const { AuditLog } = require('./security/auditLog');
const { DEFAULT_ALLOWED_BINARIES } = require('./security/scriptRunner');
const { MemoryStore, nextSessionId, listSessions } = require('./core/memoryStore');
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

    /** @type {import('./core/modelDiscovery').ModelRecord[]} */
    this.models = [];
    /** Memory stores by session id, so two open tabs never share one file. */
    /** @type {Map<number, MemoryStore>} */
    this.memories = new Map();

    /** @type {MemoryStore | null} */
    this.memory = null;
    /** @type {ContextFilesManager | null} */
    this.contextFiles = null;
    /** @type {ContextTranslator | null} */
    this.translator = null;

    this.buildClient();
    this.buildSecurityLayer();
    this.buildSession();
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
   * @param {string} name
   * @returns {Promise<void>}
   */
  async selectModel(name) {
    await this.setModel(name);
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
      this.translator = null;
      return;
    }

    const id = sessionId || nextSessionId(root);
    this.memory = new MemoryStore(root, id);
    this.contextFiles = new ContextFilesManager(root);
    void this.contextFiles.load();
    this.refreshTranslator();
    logger.info(`Session ${id} ready (memory: ${this.memory.filePath}).`);
  }

  /**
   * The translator runs against whichever model is currently selected, so it is
   * rebuilt whenever that changes.
   */
  refreshTranslator() {
    if (!this.client || !this.memory || !this.activeModel) {
      this.translator = null;
      return;
    }
    this.translator = new ContextTranslator({
      client: this.client,
      memoryStore: this.memory,
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
    this.gate = new PermissionGate({
      workspaceRoot: root,
      modes: this.modes,
      auditLog: this.auditLog,
      confirm: (request) => confirmAction(request),
      allowedBinaries: [...DEFAULT_ALLOWED_BINARIES, ...this.settings.extraAllowedBinaries],
      protectedPrefixes: this.settings.protectedPaths,
      alwaysConfirmDeletes: this.settings.permissions.alwaysConfirmDeletes,
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
   * @param {{force?: boolean, notifyRecommendation?: boolean}} [opts]
   * @returns {Promise<void>}
   */
  async refresh(opts = {}) {
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

    // The translator talks to the selected model, so it follows model changes.
    this.refreshTranslator();

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
 * Send a task from an editor feature into a chat tab.
 *
 * Reuses an open tab where there is one, so a Refactor and a Fix on the same file
 * land in the same conversation and share its memory. Only when nothing is open does
 * it start a session — an editor action should not silently create a new memory file
 * every time it is used.
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

  let tab = [...openChatTabs.values()][0];
  if (!tab) {
    const sessionId = nextSessionId(root);
    tab = new ChatTab({ context, app, sessionId });
    openChatTabs.set(sessionId, tab);
    const panel = tab.reveal();
    panel.onDidDispose(() => openChatTabs.delete(sessionId));
  } else {
    tab.reveal();
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
    sessionId = nextSessionId(root);
  } else {
    const picked = await vscode.window.showQuickPick(
      [
        { label: '$(add) New session', id: -1, detail: 'Start with empty memory' },
        ...existing.map((session) => ({
          label: `$(comment-discussion) Session ${session.sessionId}`,
          id: session.sessionId,
          detail: `${session.entries} remembered fact(s)`,
        })),
      ],
      { title: 'HirayaCoder', placeHolder: 'Resume a session or start a new one' }
    );
    if (!picked) return;
    sessionId = picked.id === -1 ? nextSessionId(root) : picked.id;
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
    return;
  }

  const tab = new ChatTab({ context, app, sessionId });
  openChatTabs.set(sessionId, tab);
  const panel = tab.reveal();
  panel.onDidDispose(() => openChatTabs.delete(sessionId));

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

  const approve = request.kind === 'delete' ? 'Delete' : request.kind === 'script' ? 'Run' : 'Apply';
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
      description: state.autoEdit ? 'currently on' : 'currently off — edits require approval',
      detail: 'Applies proposed file writes and deletes without a confirmation click. Path guards still apply.',
      action: 'toggleEdit',
    },
    {
      label: state.autoApproveScripts ? '$(check) Auto Approve Running Scripts' : 'Auto Approve Running Scripts',
      description: state.autoApproveScripts ? 'currently on' : 'currently off — commands require approval',
      detail:
        'Runs proposed commands without a click. Highest-risk setting. Commands that reach the network or publish code still always ask.',
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
 * Open this session's memory file. It is deliberately plain text and
 * user-editable — being able to read and correct what the agent "remembers" is
 * the point of not storing it as JSON.
 *
 * @param {HirayaCoder} app
 */
async function showMemoryCommand(app) {
  if (!app.memory) {
    vscode.window.showWarningMessage('HirayaCoder: no workspace folder is open, so there is no session memory.');
    return;
  }

  const entries = await app.memory.readAll();
  if (entries.length === 0) {
    vscode.window.showInformationMessage(
      `HirayaCoder: session ${app.memory.sessionId} has no memory yet — it fills in as the agent works.`
    );
    return;
  }

  await app.memory.flush();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(app.memory.filePath));
  await vscode.window.showTextDocument(document, { preview: true });
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

  const items = sessions.map((session) => ({
    label: `Session ${session.sessionId}${session.sessionId === app.memory.sessionId ? ' (current)' : ''}`,
    description: `${session.entries} entr${session.entries === 1 ? 'y' : 'ies'}`,
    detail: `Last updated ${session.modifiedAt.toLocaleString()}`,
    sessionId: session.sessionId,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Clear session memory',
    placeHolder: 'This permanently deletes what the agent remembers for that session.',
  });
  if (!picked) return;

  const confirm = 'Clear it';
  const choice = await vscode.window.showWarningMessage(
    `Clear the memory for session ${picked.sessionId}?`,
    { modal: true, detail: 'The agent will no longer recall anything from earlier in that session.' },
    confirm
  );
  if (choice !== confirm) return;

  const store =
    picked.sessionId === app.memory.sessionId ? app.memory : new MemoryStore(workspaceRoot(), picked.sessionId);
  await store.clear();

  // The conversation goes with it. Leaving the transcript behind would show the user
  // an exchange the agent has been made to forget — two different answers on screen to
  // "what happened in this session".
  await new TranscriptStore(workspaceRoot(), picked.sessionId).clear();

  const openTab = openChatTabs.get(picked.sessionId);
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
  ]
    .filter(Boolean)
    .join('\n\n');

  const change = 'Change model';
  const choice = await vscode.window.showInformationMessage('HirayaCoder is connected.', { modal: true, detail }, change);
  if (choice === change) await vscode.commands.executeCommand('hirayacoder.selectModel');
}

function deactivate() {
  logger.info('HirayaCoder deactivated.');
}

module.exports = { activate, deactivate, readSettings };
