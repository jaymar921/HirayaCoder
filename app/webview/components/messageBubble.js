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
 * Seconds, rounded the way a person reads a stopwatch.
 *
 * Sub-second turns are the cached ones and would otherwise read "0s", which looks like
 * a bug rather than like a fast answer.
 *
 * Exported for the unit suite. `appendRunMeta` needs a document and is covered by the
 * integration tests; this part is arithmetic and is worth pinning cheaply.
 *
 * @param {number} ms
 * @returns {string}
 */
export function seconds(ms) {
  if (ms < 950) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m ${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * Which model produced this reply, and how long it took.
 *
 * ## Why this is on every reply rather than in the status line
 *
 * The status line is per-tab and is overwritten by the next turn, so it can say what is
 * happening but never what happened. On this hardware a model swap is the main lever
 * anyone has — a task is one to five minutes and the only way to make it faster is to
 * run something smaller — and choosing between them means comparing replies that are
 * minutes and several messages apart. Attached to the reply, the comparison is just
 * scrolling.
 *
 * A second model is named only when a *different* one read an attached image. That is
 * not decoration: it is where the extra twenty seconds went, and without it the headline
 * number looks like the coding model got slower.
 *
 * @param {HTMLElement} body
 * @param {{model?: string, ms?: number | null, vision?: {model: string, ms: number} | null}} meta
 */
export function appendRunMeta(body, meta) {
  if (!meta || (!meta.model && typeof meta.ms !== 'number')) return;

  const line = document.createElement('div');
  line.className = 'run-meta';

  const name = document.createElement('span');
  name.className = 'run-meta-model';
  // Model names come from Ollama. Data, not markup.
  name.textContent = meta.model || 'unknown model';
  line.appendChild(name);

  if (typeof meta.ms === 'number') {
    const dot = document.createElement('span');
    dot.className = 'run-meta-sep';
    dot.textContent = '•';
    line.appendChild(dot);

    const took = document.createElement('span');
    took.textContent = seconds(meta.ms);
    line.appendChild(took);
  }

  if (meta.vision && meta.vision.model) {
    const via = document.createElement('span');
    via.className = 'run-meta-via';
    via.textContent = `+ ${meta.vision.model} read the image, ${seconds(meta.vision.ms || 0)}`;
    line.appendChild(via);
  }

  body.appendChild(line);
}

/**
 * What the vision model read out of the attached images.
 *
 * ## Why this is on screen at all, rather than only in the log
 *
 * Everything the reply says about a picture is downstream of this paragraph. When the
 * answer is wrong, there are two very different causes — the describer misread the
 * image, or it read it correctly and the answering model went wrong afterwards — and
 * they need opposite fixes. Without the description on screen the two are
 * indistinguishable, and the user's only move is to try again and hope.
 *
 * Collapsed by default and styled like the agent trace, because it is the same kind of
 * thing: evidence for the answer, not the answer.
 *
 * @param {HTMLElement} body
 * @param {string} model
 * @param {Array<{name: string, description: string}>} descriptions
 */
export function appendVisionNote(body, model, descriptions) {
  if (!descriptions || descriptions.length === 0) return;

  const box = document.createElement('details');
  box.className = 'trace vision-note';

  const summary = document.createElement('summary');
  summary.textContent =
    descriptions.length === 1
      ? `What ${model} saw in ${descriptions[0].name}`
      : `What ${model} saw in ${descriptions.length} images`;
  box.appendChild(summary);

  for (const entry of descriptions) {
    if (descriptions.length > 1) {
      const name = document.createElement('div');
      name.className = 'vision-name';
      name.textContent = entry.name;
      box.appendChild(name);
    }
    const text = document.createElement('p');
    text.className = 'vision-text';
    // Model output. `textContent`, never markup — see the note at the top of this file.
    text.textContent = entry.description;
    box.appendChild(text);
  }

  body.appendChild(box);
}

/**
 * What each tool call is called, in the language of the thing it does.
 *
 * The trace used to print the tool name verbatim — `read_file`, `run_script`. That is
 * the identifier the model is required to emit, and showing it to the user leaks an
 * implementation detail into the one surface that is supposed to explain the run. A
 * step reading "Reading src/App.jsx" needs no glossary.
 *
 * A Map rather than an object literal, because the key is model output. A plain
 * `ACTION_VERBS[name]` lookup reaches the prototype, so a model emitting the action
 * `"constructor"` gets `Function` back — truthy, so it survives the `||` fallback — and
 * the panel renders a function's source as the name of a step. A Map has no prototype
 * keys to find.
 */
const ACTION_VERBS = new Map([
  ['read_file', 'Reading'],
  ['write_file', 'Editing'],
  ['list_files', 'Listing'],
  ['search_workspace', 'Searching'],
  ['run_script', 'Running'],
  ['run_tests', 'Testing'],
  ['delete_file', 'Deleting'],
  ['create_folder', 'Creating folder'],
  ['delete_folder', 'Removing folder'],
]);

/** Longest status message shown before it is cut; the title carries the rest. */
const MAX_STATUS_CHARS = 110;

/**
 * One step as the three things the panel shows: what, to what, and why.
 *
 * Split out from the rendering because this is the part with decisions in it, and the
 * webview's DOM assembly is not reachable from the unit suite — see the header of
 * `test/unit/webviewComponents.test.js`. Building the nodes from this is trivial and
 * uninteresting; choosing the words is not.
 *
 * @param {{action: string, path?: string, command?: string, query?: string, thought?: string}} action
 * @returns {{verb: string, target: string, status: string, full: string}}
 */
export function describeStep(action) {
  const name = String((action && action.action) || '');
  // Collapsed rather than trimmed: a `thought` arrives as free text from the model and
  // routinely contains newlines, which would break a single-line row into several.
  const full = String((action && action.thought) || '').replace(/\s+/g, ' ').trim();

  return {
    verb: ACTION_VERBS.get(name) || name,
    target: String((action && (action.path || action.command || action.query)) || ''),
    status: full.length > MAX_STATUS_CHARS ? `${full.slice(0, MAX_STATUS_CHARS - 1)}…` : full,
    full,
  };
}

/**
 * The live step panel inside an assistant message.
 *
 * ## Why it opens while the run is happening
 *
 * It used to be collapsed always, on the reasoning that a fifteen-step session would
 * bury the answer. That is right once there *is* an answer and wrong until then. The
 * 0.7.0 sessions measured 42 seconds per step on a 4B model and 88 minutes for one
 * task — so for minutes at a time the panel showed a single thinking indicator, and
 * the user's first sight of a run going wrong was the summary at the end. The steps
 * are the only evidence available while it is still worth interrupting.
 *
 * So it opens when the first step arrives and collapses on `finish`, unless the user
 * has touched it — `_userToggled` exists to make sure a panel someone deliberately
 * opened is never shut on them.
 *
 * ## Why each row carries a status message
 *
 * A row is three things: what is being done, what it is being done to, and why. The
 * "why" is the model's own stated reason for the step, which the loops already capture
 * as `thought` and which nothing was showing. Without it a trace of eight reads of the
 * same file looks identical to eight reads of different ones.
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
    /** Set once the user opens or closes it themselves; we stop deciding after that. */
    this._userToggled = false;
    // The `toggle` event is the obvious hook and the wrong one: it also fires when
    // `open` is assigned in code, and it fires asynchronously, so a "this was us" flag
    // set around the assignment is not reliably cleared before it arrives. A click on
    // the summary is unambiguous — nothing but a person produces one.
    this.summary.addEventListener('click', () => {
      this._userToggled = true;
    });
  }

  /**
   * @param {number} step
   * @param {{action: string, path?: string, command?: string, query?: string, thought?: string}} action
   */
  addAction(step, action) {
    const described = describeStep(action);

    const row = document.createElement('div');
    row.className = 'step is-active';

    const n = document.createElement('span');
    n.className = 'step-n';
    n.textContent = String(step);

    const name = document.createElement('span');
    name.className = 'step-action';
    name.textContent = described.verb;

    const target = document.createElement('span');
    target.className = 'step-target';
    target.textContent = described.target;

    row.appendChild(n);
    row.appendChild(name);
    row.appendChild(target);

    // The model's stated reason for the step. Model output — data, never markup.
    if (described.status) {
      const status = document.createElement('span');
      status.className = 'step-status';
      status.textContent = described.status;
      status.title = described.full;
      row.appendChild(status);
    }

    this.list.appendChild(row);
    this.rows.set(step, row);
    this.count = Math.max(this.count, step);
    // Opened on the first step rather than at construction: a conversational turn
    // builds a TraceView and never adds to it, and an empty open panel reads as a
    // promise of work that is not coming.
    if (!this._userToggled) this.el.open = true;
    this._retitle();
  }

  /**
   * The run is over: stop showing the panel expanded, and stop marking a step active.
   *
   * A step left `is-active` after a cancelled or failed run keeps the accent on a step
   * that is not running, which is the one thing the accent is for.
   */
  finish() {
    for (const row of this.rows.values()) row.classList.remove('is-active');
    if (!this._userToggled) this.el.open = false;
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
