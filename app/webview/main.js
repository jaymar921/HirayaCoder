/**
 * The chat tab's client half.
 *
 * It owns the DOM and nothing else: no filesystem, no Ollama, no decisions about what
 * is allowed. Everything consequential is a message to the extension host, which is
 * the side that can enforce anything. A compromised webview should be able to render
 * nonsense and no more.
 */

import { createMessage, appendImages, TraceView, renderTodos, renderChanges } from './components/messageBubble.js';
import { ThinkingIndicator } from './components/thinkingIndicator.js';
import { renderPlanChecklist } from './components/planChecklist.js';
import { render } from './components/markdown.js';

const vscode = acquireVsCodeApi();

const el = {
  messages: document.getElementById('messages'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  composer: document.getElementById('composer'),
  chips: document.getElementById('chips'),
  model: document.getElementById('model'),
  tierBadge: document.getElementById('tier-badge'),
  mode: document.getElementById('mode'),
  thinking: document.getElementById('thinking'),
  permissions: document.getElementById('permissions'),
  permSummary: document.getElementById('perm-summary'),
  addFile: document.getElementById('add-file'),
  addImage: document.getElementById('add-image'),
  status: document.getElementById('status'),
  sessionBadge: document.getElementById('session-badge'),
};

/** @type {{running: boolean, mode: string, indicator: ThinkingIndicator | null, trace: TraceView | null, body: HTMLElement | null}} */
const state = {
  running: false,
  mode: 'agent',
  indicator: null,
  trace: null,
  body: null,
};

/* ------------------------------------------------------------------ welcome */

function showWelcome() {
  const welcome = document.createElement('div');
  welcome.className = 'welcome';
  welcome.id = 'welcome';

  const glyph = document.createElement('div');
  glyph.className = 'welcome-glyph';

  const heading = document.createElement('h1');
  heading.textContent = 'Kumusta, coder! What are we building today?';

  const blurb = document.createElement('p');
  blurb.textContent =
    'Everything runs on your machine through Ollama. Nothing you type or open leaves this laptop.';

  const tips = document.createElement('div');
  tips.className = 'welcome-tips';
  for (const tip of ['Add a file with +', 'Wrap code in `backticks`', 'Plan mode drafts before it edits']) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = tip;
    tips.appendChild(chip);
  }

  welcome.appendChild(glyph);
  welcome.appendChild(heading);
  welcome.appendChild(blurb);
  welcome.appendChild(tips);
  el.messages.appendChild(welcome);
}

function clearWelcome() {
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();
}

/* ------------------------------------------------------------------- chips */

/** @type {Array<{kind: 'file' | 'image', name: string, path: string, dataUri?: string}>} */
let attachments = [];

function renderChips() {
  el.chips.replaceChildren();
  for (const item of attachments) {
    const chip = document.createElement('span');
    chip.className = 'chip';

    if (item.kind === 'image' && item.dataUri) {
      const thumb = document.createElement('img');
      thumb.className = 'chip-thumb';
      thumb.src = item.dataUri;
      thumb.alt = '';
      chip.appendChild(thumb);
    }

    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = item.name;
    name.title = item.path;
    chip.appendChild(name);

    const remove = document.createElement('button');
    remove.className = 'chip-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', () => {
      attachments = attachments.filter((a) => a !== item);
      renderChips();
      vscode.postMessage({ type: 'detach', path: item.path, kind: item.kind });
    });
    chip.appendChild(remove);

    el.chips.appendChild(chip);
  }
}

/* ---------------------------------------------------------------- composing */

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
}

function setRunning(running) {
  state.running = running;
  el.send.textContent = running ? 'Stop' : 'Send';
  el.input.disabled = false;
  el.addFile.disabled = running;
  el.addImage.disabled = running || el.addImage.dataset.unsupported === 'true';
}

function submit() {
  if (state.running) {
    vscode.postMessage({ type: 'cancel' });
    return;
  }

  const text = el.input.value.trim();
  if (!text) return;

  clearWelcome();

  const images = attachments.filter((a) => a.kind === 'image');
  const { el: node, body } = createMessage('user', text);
  appendImages(body, images.map((i) => ({ name: i.name, dataUri: i.dataUri })));
  el.messages.appendChild(node);

  vscode.postMessage({ type: 'send', text });

  el.input.value = '';
  autoGrow();
  // Images belong to the message that was just sent; files stay attached, since
  // they are context for the conversation rather than for one turn.
  attachments = attachments.filter((a) => a.kind !== 'image');
  renderChips();
  scrollToEnd();
}

function scrollToEnd() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

/* ------------------------------------------------------------- host events */

function startAssistantMessage() {
  clearWelcome();
  const { el: node, body } = createMessage('assistant');
  state.body = body;
  state.trace = new TraceView();
  state.indicator = new ThinkingIndicator();
  body.appendChild(state.indicator.el);
  el.messages.appendChild(node);
  scrollToEnd();
}

function finishAssistantMessage() {
  if (state.indicator) {
    state.indicator.dispose();
    state.indicator = null;
  }
}

const handlers = {
  init(msg) {
    el.sessionBadge.textContent = `session ${msg.sessionId}`;
    setMode(msg.mode);
    setCapacity(msg.thinkingCapacity);
    updatePermissions(msg.permissions);
    updateModels(msg.models, msg.activeModel, msg.capability);
    if (msg.history && msg.history.length > 0) {
      for (const entry of msg.history) {
        const { el: node } = createMessage(entry.role, entry.text);
        el.messages.appendChild(node);
      }
    } else {
      showWelcome();
    }
  },

  models(msg) {
    updateModels(msg.models, msg.activeModel, msg.capability);
  },

  permissions(msg) {
    updatePermissions(msg.permissions);
  },

  status(msg) {
    el.status.textContent = msg.text || '';
  },

  start() {
    setRunning(true);
    startAssistantMessage();
  },

  thinking(msg) {
    if (state.indicator && msg.step) state.indicator.setStep(msg.step, msg.maxSteps);
  },

  todo(msg) {
    if (!state.body) return;
    state.body.appendChild(renderTodos(msg.items.map((text) => ({ text, status: 'pending' }))));
    scrollToEnd();
  },

  'todo-progress'(msg) {
    if (!state.body) return;
    const existing = state.body.querySelector('.todo-list');
    const fresh = renderTodos(msg.items);
    if (existing) existing.replaceWith(fresh);
    else state.body.appendChild(fresh);
  },

  action(msg) {
    if (!state.trace) return;
    state.trace.addAction(msg.step, msg.action);
    if (!state.trace.el.isConnected && state.body) {
      state.body.appendChild(state.trace.el);
    }
    scrollToEnd();
  },

  observation(msg) {
    if (state.trace) state.trace.addResult(msg.step, msg.result);
  },

  done(msg) {
    finishAssistantMessage();
    setRunning(false);
    if (!state.body) return;

    // A plan renders as an editable checklist instead of a wall of prose, because
    // the point of Plan mode is deciding whether to run it.
    if (msg.plan && msg.plan.length > 0) {
      state.body.appendChild(
        renderPlanChecklist(msg.plan, (steps) => {
          setMode('agent');
          vscode.postMessage({ type: 'run-plan', steps });
        })
      );
    } else if (msg.summary) {
      state.body.appendChild(render(msg.summary));
    }

    if (msg.todos && msg.todos.length > 0) {
      const existing = state.body.querySelector('.todo-list');
      const fresh = renderTodos(msg.todos);
      if (existing) existing.replaceWith(fresh);
      else state.body.appendChild(fresh);
    }
    if (msg.changes && msg.changes.length > 0) state.body.appendChild(renderChanges(msg.changes));
    scrollToEnd();
  },

  error(msg) {
    finishAssistantMessage();
    setRunning(false);
    const { el: node } = createMessage('error', msg.message);
    el.messages.appendChild(node);
    scrollToEnd();
  },

  attached(msg) {
    attachments.push(msg.file);
    renderChips();
  },

  // A task started from the editor (Explain, Refactor, Generate tests). Echoed as a
  // user message so the transcript shows what was actually asked.
  'external-task'(msg) {
    clearWelcome();
    const { el: node } = createMessage('user', msg.text);
    el.messages.appendChild(node);
    scrollToEnd();
  },

  vision(msg) {
    el.addImage.dataset.unsupported = msg.supported ? 'false' : 'true';
    el.addImage.disabled = !msg.supported || state.running;
    el.addImage.title = msg.supported
      ? 'Attach an image'
      : `${msg.model || 'This model'} cannot read images. Pick a vision model such as gemma4 or qwen3.5.`;
    if (!msg.supported) {
      // Images already staged would be silently ignored by a text-only model.
      const dropped = attachments.filter((a) => a.kind === 'image');
      if (dropped.length > 0) {
        attachments = attachments.filter((a) => a.kind !== 'image');
        renderChips();
      }
    }
  },
};

window.addEventListener('message', (event) => {
  const msg = event.data;
  const handler = handlers[msg && msg.type];
  if (handler) handler(msg);
});

/* -------------------------------------------------------------- header bits */

function updateModels(models, active, capability) {
  el.model.replaceChildren();
  for (const model of models || []) {
    const option = document.createElement('option');
    option.value = model.name;
    option.textContent = `${model.name} · ${model.paramsLabel}`;
    if (model.name === active) option.selected = true;
    el.model.appendChild(option);
  }
  if (capability) {
    el.tierBadge.textContent = capability.label;
    el.tierBadge.className = `badge tier-${capability.tier}`;
    el.tierBadge.title = capability.reason;
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const button of el.mode.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  }
}

function setCapacity(capacity) {
  for (const button of el.thinking.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.capacity === capacity));
  }
}

function updatePermissions(permissions) {
  if (!permissions) return;
  el.permSummary.textContent =
    `Edits: ${permissions.autoEdit ? 'Auto' : 'Approve'} · ` +
    `Scripts: ${permissions.autoApproveScripts ? 'Auto' : 'Approve'}`;
}

/* ------------------------------------------------------------------- wiring */

el.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  submit();
});

el.input.addEventListener('input', autoGrow);

el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});

el.mode.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-mode]');
  if (!button) return;
  setMode(button.dataset.mode);
  vscode.postMessage({ type: 'mode', mode: button.dataset.mode });
});

el.thinking.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-capacity]');
  if (!button) return;
  setCapacity(button.dataset.capacity);
  vscode.postMessage({ type: 'thinking', capacity: button.dataset.capacity });
});

el.model.addEventListener('change', () => {
  vscode.postMessage({ type: 'model', model: el.model.value });
});

el.permissions.addEventListener('click', () => vscode.postMessage({ type: 'permissions' }));
el.addFile.addEventListener('click', () => vscode.postMessage({ type: 'attach-file' }));
el.addImage.addEventListener('click', () => vscode.postMessage({ type: 'attach-image' }));

autoGrow();
vscode.postMessage({ type: 'ready' });
