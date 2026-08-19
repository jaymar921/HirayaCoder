'use strict';

/**
 * A task broken into items the agent works through one at a time.
 *
 * ## Why this exists
 *
 * The three-part benchmark ("edit the function, note it in the README, delete the
 * obsolete file") fails on every model below `gemma4:e2b`, and it does not fail for
 * lack of capability at any individual part — each part alone succeeds. It fails
 * because the model is holding three goals at once in a context window that is also
 * carrying a file, a trace, and its memory. Sub-goals get dropped, merged, or
 * repeated.
 *
 * So the list is held *here* rather than in the model's head. Each item becomes its
 * own focused run: read, think, modify, repeat until that item is satisfied, then the
 * next one. The model is asked to do one thing at a time even when the user asked for
 * three, and the extension keeps track of where it is.
 *
 * ## Why the model does not own the list
 *
 * The model proposes the items; it never mutates them afterwards. Letting a model
 * mark its own work complete reproduces the failure this exists to fix — the same
 * models that claim a declined delete succeeded would happily tick off an item they
 * never did. Completion is decided from what the run actually produced: files
 * changed, steps succeeded, how the loop stopped.
 *
 * @module agent/todoList
 */

const logger = require('../utils/logger');

/** Below this, a "list" is just the task restated, and the overhead buys nothing. */
const MIN_ITEMS = 2;

/** Above this, a small model loses the thread regardless of how the list is held. */
const MAX_ITEMS = 6;

/**
 * `done-with-warning` means the work landed and no step failed, but the model never
 * closed the item off. It counts as completed — the files changed — while staying
 * visibly distinct from an item the run finished cleanly. See `judgeItem`.
 *
 * @typedef {'pending' | 'active' | 'done' | 'done-with-warning' | 'failed' | 'skipped'} TodoStatus
 */

/**
 * @typedef {object} TodoItem
 * @property {string} text
 * @property {string} [detail]
 *   The span of the request this item came from, when the list was read from the
 *   request's own structure rather than proposed by the model. The `text` is the
 *   instruction; this is the spec behind it, and it is what the step running the item
 *   is shown *instead of* the whole request. See `core/requestPlan` and `agent/stepBrief`.
 * @property {TodoStatus} status
 * @property {string} [outcome]  Why it ended the way it did, in plain language.
 * @property {number} [steps]    Steps the item consumed.
 * @property {string[]} [changedPaths]
 *   Files this item created or edited. Recorded because the checklist is the only thing
 *   that crosses between items, and "item 3 is done" is not the fact item 6 needs —
 *   "item 3 wrote src/hooks/useTodos.js" is. See `agent/stepBrief`.
 * @property {number} [attempts] How many times it was run, including the retry.
 */

class TodoList {
  /**
   * @param {Array<string | {text: string, detail?: string}>} items
   *   A plain string per item, as the model's planner produces, or `{text, detail}`
   *   when the list was read from the request's own structure — see `core/requestPlan`.
   *   `detail` is the span of the request this item came from, and it is the item's
   *   spec: the step that runs it is shown that rather than the whole request.
   */
  constructor(items) {
    /** @type {TodoItem[]} */
    this.items = items.slice(0, MAX_ITEMS).map((entry) => {
      const text = typeof entry === 'string' ? entry : entry.text;
      const detail = typeof entry === 'string' ? '' : String(entry.detail || '');
      return { text: String(text).trim(), detail, status: 'pending' };
    });
    if (this.items.length > 0) this.items[0].status = 'active';

    /**
     * Every change made to the list after it was planned, in order.
     *
     * The list is the one thing in a run that both the user and the model treat as
     * settled — it is shown once, ticked off as it goes, and read back in the summary.
     * So when it changes mid-run because the user was asked something, that has to be
     * visible: a checklist that quietly grew an item reads afterwards as a model that
     * did work nobody asked for.
     *
     * @type {Array<{kind: 'reworded' | 'dropped', detail: string, at: number}>}
     */
    this.changes = [];
  }

  /** @returns {boolean} */
  static isWorthKeeping(items) {
    return Array.isArray(items) && items.length >= MIN_ITEMS;
  }

  /** @returns {TodoItem | null} The item being worked on. */
  current() {
    return this.items.find((item) => item.status === 'active') || null;
  }

  /** @returns {number} 1-based position of the active item. */
  position() {
    const index = this.items.findIndex((item) => item.status === 'active');
    return index === -1 ? this.items.length : index + 1;
  }

  /**
   * Close the active item and open the next.
   *
   * @param {TodoStatus} status
   * @param {string} [outcome]
   * @param {number} [steps]
   * @param {{changedPaths?: string[], attempts?: number}} [evidence]
   *   What the item produced, for the items that come after it.
   * @returns {TodoItem | null} The next item, or null when the list is finished.
   */
  finishCurrent(status, outcome, steps, evidence = {}) {
    const active = this.current();
    if (!active) return null;

    active.status = status;
    if (outcome) active.outcome = outcome;
    if (typeof steps === 'number') active.steps = steps;
    if (Array.isArray(evidence.changedPaths) && evidence.changedPaths.length > 0) {
      active.changedPaths = [...evidence.changedPaths];
    }
    if (typeof evidence.attempts === 'number') active.attempts = evidence.attempts;
    logger.info(`TODO item ${this.position()}/${this.items.length} → ${status}: ${active.text}`);

    const next = this.items.find((item) => item.status === 'pending');
    if (next) {
      next.status = 'active';
      // Both ends of every item, and not just the closing one. A long run reads in the
      // output channel as a wall of tool calls with no boundaries in it, and the first
      // question about any of them is which item was being worked on at the time.
      logger.info(`TODO item ${this.position()}/${this.items.length} starting: ${next.text}`);
      return next;
    }
    return null;
  }

  /**
   * The items that have not been attempted yet, including the active one.
   *
   * Read before `skipRemaining` when a run is stopping early, so the notice can name
   * what will not now happen. Once they are skipped their status no longer says
   * whether they were ever going to be tried.
   *
   * @param {{includeActive?: boolean}} [opts]
   * @returns {string[]}
   */
  remaining(opts = {}) {
    const wanted = opts.includeActive ? ['pending', 'active'] : ['pending'];
    return this.items.filter((item) => wanted.includes(item.status)).map((item) => item.text);
  }

  /**
   * Restate the active item.
   *
   * The original text is kept in the change log rather than overwritten in place: the
   * summary has to be able to say what the item *was*, or a user reading it afterwards
   * cannot tell that their answer is why it succeeded.
   *
   * @param {string} text
   * @returns {boolean}
   */
  replaceCurrent(text) {
    const active = this.current();
    const wanted = String(text || '').trim();
    if (!active || !wanted || wanted === active.text) return false;

    this.changes.push({ kind: 'reworded', detail: `"${active.text}" → "${wanted}"`, at: this.position() });
    logger.info(`Checklist item ${this.position()} reworded: ${active.text} → ${wanted}`);
    active.text = wanted;
    return true;
  }

  /**
   * Close the active item as skipped and move on, leaving the rest of the list alone.
   *
   * Distinct from `skipRemaining`, which gives up on everything. This is the user
   * saying "not that one" — the run continues.
   *
   * @param {string} reason
   * @returns {TodoItem | null} The next item.
   */
  skipCurrent(reason) {
    const active = this.current();
    if (!active) return null;
    this.changes.push({ kind: 'dropped', detail: active.text, at: this.position() });
    return this.finishCurrent('skipped', reason);
  }

  /**
   * What changed about the list after it was planned, in plain language.
   *
   * @returns {string} Empty when the list ran as planned.
   */
  describeChanges() {
    if (this.changes.length === 0) return '';
    const lines = this.changes.map((change) =>
      change.kind === 'reworded'
        ? `- Item ${change.at} reworded: ${change.detail}`
        : `- Item ${change.at} dropped: ${change.detail}`
    );
    return `The checklist changed while it ran:\n${lines.join('\n')}`;
  }

  /** Mark every remaining item as skipped — used when the session is cut short. */
  skipRemaining(reason) {
    for (const item of this.items) {
      if (item.status === 'pending' || item.status === 'active') {
        item.status = 'skipped';
        if (reason) item.outcome = reason;
      }
    }
  }

  /** @returns {boolean} */
  isComplete() {
    return this.items.every((item) => item.status !== 'pending' && item.status !== 'active');
  }

  /**
   * The list as the model sees it.
   *
   * Checkbox syntax rather than prose because it survives truncation legibly and
   * because a model that has seen a million markdown checklists reads it without
   * being taught. The active item is marked and labelled, since "which one am I
   * doing" is the single fact this whole module exists to keep straight.
   *
   * @returns {string}
   */
  render() {
    const lines = this.items.map((item, index) => {
      const mark = {
        done: '[x]',
        'done-with-warning': '[x]',
        failed: '[!]',
        skipped: '[-]',
        active: '[>]',
        pending: '[ ]',
      }[item.status];
      const suffix = item.status === 'active' ? '   <- do this one now' : '';
      return `${mark} ${index + 1}. ${item.text}${suffix}`;
    });
    return `Your TODO list:\n${lines.join('\n')}`;
  }

  /**
   * `done` counts `done-with-warning` too: the files changed, so calling it
   * incomplete in the headline would understate what happened to the workspace. The
   * separate count is there for anything that wants to say how many needed a caveat.
   *
   * @returns {{done: number, warned: number, failed: number, skipped: number, total: number}}
   */
  progress() {
    const count = (status) => this.items.filter((item) => item.status === status).length;
    const warned = count('done-with-warning');
    return {
      done: count('done') + warned,
      warned,
      failed: count('failed'),
      skipped: count('skipped'),
      total: this.items.length,
    };
  }

  /**
   * A plain-language account of the whole list, for the session summary.
   *
   * @returns {string}
   */
  describe() {
    const lines = this.items.map((item, index) => {
      const label = {
        done: 'done',
        'done-with-warning': 'done, with a caveat',
        failed: 'not completed',
        skipped: 'not attempted',
        active: 'unfinished',
        pending: 'not attempted',
      }[item.status];
      return `${index + 1}. ${item.text} — ${label}${item.outcome ? ` (${item.outcome})` : ''}`;
    });
    return lines.join('\n');
  }
}

module.exports = { TodoList, MIN_ITEMS, MAX_ITEMS };
