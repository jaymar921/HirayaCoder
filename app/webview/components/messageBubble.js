/**
 * Message bubbles, the agent trace, and the TODO checklist.
 *
 * All model-supplied text goes through `markdown.render`, which builds nodes rather
 * than HTML — see that module for why. Anything added here that takes model text must
 * do the same or use `textContent`.
 */

import { render } from './markdown.js';

/**
 * @param {'user' | 'assistant' | 'error'} role
 * @param {string} [text]
 * @returns {{el: HTMLElement, body: HTMLElement}}
 */
export function createMessage(role, text) {
  const el = document.createElement('article');
  el.className = `msg ${role}`;

  const label = document.createElement('div');
  label.className = 'msg-role';
  label.textContent = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'HirayaCoder';

  const body = document.createElement('div');
  body.className = 'msg-body';
  if (text !== undefined) body.appendChild(render(text));

  el.appendChild(label);
  el.appendChild(body);
  return { el, body };
}

/**
 * Attach thumbnails of the images sent with a message.
 *
 * @param {HTMLElement} body
 * @param {Array<{name: string, dataUri: string}>} images
 */
export function appendImages(body, images) {
  if (!images || images.length === 0) return;
  const row = document.createElement('div');
  row.className = 'chips';
  for (const image of images) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const thumb = document.createElement('img');
    thumb.className = 'chip-thumb';
    // A data: URI built by the host from a file the user picked. CSP allows data:
    // for images and nothing else, so this cannot become a network fetch.
    thumb.src = image.dataUri;
    thumb.alt = '';
    const name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = image.name;
    chip.appendChild(thumb);
    chip.appendChild(name);
    row.appendChild(chip);
  }
  body.appendChild(row);
}

/**
 * The collapsible step trace inside an assistant message.
 *
 * Collapsed by default: a fifteen-step session would otherwise bury the answer the
 * user actually asked for. The summary line carries enough to decide whether to open
 * it.
 */
export class TraceView {
  constructor() {
    this.el = document.createElement('details');
    this.el.className = 'trace';

    this.summary = document.createElement('summary');
    this.summary.textContent = 'Steps';
    this.el.appendChild(this.summary);

    this.list = document.createElement('div');
    this.el.appendChild(this.list);

    this.count = 0;
    /** @type {Map<number, HTMLElement>} */
    this.rows = new Map();
  }

  /**
   * @param {number} step
   * @param {{action: string, path?: string, command?: string, query?: string}} action
   */
  addAction(step, action) {
    const row = document.createElement('div');
    row.className = 'step is-active';

    const n = document.createElement('span');
    n.className = 'step-n';
    n.textContent = String(step);

    const name = document.createElement('span');
    name.className = 'step-action';
    name.textContent = action.action;

    const target = document.createElement('span');
    target.className = 'step-target';
    target.textContent = action.path || action.command || action.query || '';

    row.appendChild(n);
    row.appendChild(name);
    row.appendChild(target);
    this.list.appendChild(row);
    this.rows.set(step, row);
    this.count = Math.max(this.count, step);
    this._retitle();
  }

  /**
   * @param {number} step
   * @param {{ok: boolean, observation: string}} result
   */
  addResult(step, result) {
    const row = this.rows.get(step);
    if (!row) return;
    row.classList.remove('is-active');

    const outcome = document.createElement('span');
    outcome.className = `step-result ${result.ok ? 'ok' : 'failed'}`;
    outcome.textContent = result.ok ? 'ok' : 'failed';
    // The observation can be a whole file; the title is the affordance for seeing
    // more without letting it dominate the trace.
    outcome.title = String(result.observation || '').slice(0, 400);
    row.appendChild(outcome);
    this._retitle();
  }

  /** @private */
  _retitle() {
    const failed = this.list.querySelectorAll('.step-result.failed').length;
    this.summary.textContent =
      failed > 0 ? `Steps (${this.count}, ${failed} failed)` : `Steps (${this.count})`;
  }
}

// `done-with-warning` reads as done, because it is — the files changed. The caveat
// lives in the mark and in the hover text, not in a different word for "finished".
const TODO_MARKS = {
  done: '✔',
  'done-with-warning': '✔',
  failed: '✕',
  active: '▸',
  pending: '○',
  skipped: '–',
};

/**
 * Render the TODO list and its progress.
 *
 * @param {Array<{text: string, status: string, outcome?: string}>} items
 * @returns {HTMLElement}
 */
export function renderTodos(items) {
  const list = document.createElement('ul');
  list.className = 'todo-list';

  for (const item of items) {
    const row = document.createElement('li');
    row.className = `todo-item ${item.status}`;

    const mark = document.createElement('span');
    mark.className = 'todo-mark';
    mark.textContent = TODO_MARKS[item.status] || '○';

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = item.text;
    if (item.outcome) text.title = item.outcome;

    row.appendChild(mark);
    row.appendChild(text);
    list.appendChild(row);
  }

  return list;
}

/**
 * Render a change set as a compact, colour-coded summary.
 *
 * @param {Array<{kind: string, path: string, added?: number, removed?: number}>} changes
 * @returns {HTMLElement}
 */
export function renderChanges(changes) {
  const wrapper = document.createElement('div');
  wrapper.className = 'todo-list';

  for (const change of changes) {
    const row = document.createElement('div');
    row.className = 'todo-item';

    const mark = document.createElement('span');
    mark.className = 'todo-mark';
    mark.textContent = change.kind === 'delete' ? '✕' : change.kind === 'create' ? '+' : '±';

    const name = document.createElement('span');
    name.className = 'todo-text';
    name.textContent = change.path;

    row.appendChild(mark);
    row.appendChild(name);

    if (change.kind !== 'delete') {
      const stat = document.createElement('span');
      stat.className = 'step-result';
      const add = document.createElement('span');
      add.className = 'diff-add';
      add.textContent = `+${change.added || 0}`;
      const del = document.createElement('span');
      del.className = 'diff-del';
      del.textContent = ` -${change.removed || 0}`;
      stat.appendChild(add);
      stat.appendChild(del);
      row.appendChild(stat);
    }

    wrapper.appendChild(row);
  }

  return wrapper;
}
