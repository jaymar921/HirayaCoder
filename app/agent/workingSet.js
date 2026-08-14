'use strict';

/**
 * What the agent already has, stated as fact rather than asked for as judgement.
 *
 * ## The two failures this exists for
 *
 * Both evaluation sessions of 0.7.0 lost most of their time or all of their output to
 * the same missing thing, at opposite ends of the model range. See
 * `doc/SESSION-ANALYSIS-0.7.0.md` for the counted version.
 *
 * **`qwen3.5:0.8b` never wrote a single file.** Five of its seven sessions ended
 * `repeating`, four of them at exactly two steps: `list_files`, `list_files`,
 * `list_files` — and the repeat guard ended the run. Twelve of its twenty-two total
 * steps were `list_files`.
 *
 * **`qwen3.5:4b` finished the task and spent 88 minutes doing it**, 97% of that inside
 * the model. 73 of its 126 steps were `read_file`, against 21 writes; the audit log has
 * 263 read entries across 25 distinct paths. `App.jsx` was read 28 times and written 4.
 * A binary PNG was read into the prompt 13 times.
 *
 * ## Why the existing hints did not prevent either
 *
 * They fired, correctly, every time. `nextStepHint` already says *"You now know what is
 * in the project"* after a listing and *"Do NOT do it again"* on a repeat, and
 * `reactLoop`'s header documents both. The models did it again anyway.
 *
 * That is the finding, and it is not really about model quality: **every anti-repetition
 * device in the loop is a sentence addressed to the model's judgement, evaluated against
 * a context that no longer contains the thing it is describing.** A hint says "you
 * already have the listing" while the listing itself has scrolled out of the window. The
 * model is being asked to take the loop's word for it, and reaching for the tool is the
 * cheaper way to be sure.
 *
 * So this module does not add a firmer sentence. It keeps the **record**, and renders
 * it back as a standing block: the paths, the commands, the outcomes. A model that can
 * see `src/App.jsx` in a list titled "you have already read these" does not have to
 * decide whether to believe a claim about its own past — the past is in front of it.
 *
 * ## Why one module for both tiers
 *
 * `stepBrief` does something close to this and does it well, but only inside
 * `_runWithTodos`, which requires `canPlanTodos`, which requires ≥ 2B parameters. The
 * model that needs the reminder most is excluded from it by a threshold. This runs off
 * the step trace instead, so it costs nothing to give a 0.8B model the same footing as a
 * 4B one.
 *
 * @module agent/workingSet
 */

const { neutralize } = require('../core/memoryStore');

/** Paths listed in a section before the rest are elided. */
const MAX_PATHS_SHOWN = 10;

/** Commands recalled, most recent last. */
const MAX_COMMANDS_SHOWN = 5;

/** Longest single path rendered; a deep path adds nothing past this. */
const MAX_PATH_CHARS = 80;

/**
 * Actions that fetch something the agent could already be holding.
 *
 * These are the ones worth tracking for redundancy. A write is tracked too, but for the
 * opposite reason — it is evidence that a file *exists*, which is what the next step
 * needs in order to import from it.
 */
const FETCHING_ACTIONS = new Set(['read_file', 'list_files', 'search_workspace']);

/**
 * Reconnaissance: read-only, cheap, and idempotent.
 *
 * Kept separate from `FETCHING_ACTIONS` — which it currently equals — because the two
 * are asked different questions and will not stay equal. This set answers "is repeating
 * this actually harmful?", and the answer governs whether a repeat is worth ending a
 * user's session over. A repeated `run_script` is a different matter: it can install
 * packages, start servers, and cost real time.
 */
const RECON_ACTIONS = new Set(['read_file', 'list_files', 'search_workspace']);

/**
 * @param {string} action
 * @returns {boolean}
 */
function isRecon(action) {
  return RECON_ACTIONS.has(String(action));
}

/**
 * @param {string} path
 * @returns {string}
 */
function shortPath(path) {
  const text = String(path || '').trim();
  if (text.length <= MAX_PATH_CHARS) return text;
  return `…${text.slice(-(MAX_PATH_CHARS - 1))}`;
}

/**
 * @param {string[]} paths
 * @returns {string}
 */
function renderPaths(paths) {
  const shown = paths.slice(-MAX_PATHS_SHOWN).map(shortPath);
  const elided = paths.length - shown.length;
  return elided > 0 ? `${shown.join(', ')} (+${elided} more)` : shown.join(', ');
}

class WorkingSet {
  constructor() {
    /** @type {Map<string, {step: number, bytes: number}>} Read, by path. */
    this.read = new Map();
    /** @type {Map<string, {step: number, created: boolean}>} Written, by path. */
    this.written = new Map();
    /** @type {Map<string, number>} Directories listed, path → times. */
    this.listed = new Map();
    /** @type {Array<{command: string, cwd: string, ok: boolean}>} */
    this.commands = [];
    /** @type {Array<{action: string, path: string, why: string}>} What went wrong. */
    this.struggles = [];
    /** Paths deleted, so the set never claims a gone file still exists. */
    this.deleted = new Set();
  }

  /**
   * Fold one executed step into the record.
   *
   * Called with what the loop already has — the action it sent and the result it got —
   * so nothing here depends on the model describing its own behaviour accurately.
   *
   * @param {import('../core/outputParser').ParsedAction} action
   * @param {import('./toolRegistry').ToolResult} result
   * @param {number} step  1-based index of this step.
   */
  record(action, result, step) {
    const name = String(action && action.action);
    const path = action && action.path ? String(action.path) : '';
    const ok = Boolean(result && result.ok);

    if (!ok) {
      // Only the failures worth restating: a model that is told what it struggled with
      // stops re-attempting it, and the user's spec for the small-model reminder asks
      // for this by name.
      const why = String((result && result.observation) || '')
        .split('\n')[0]
        .trim();
      this.struggles.push({ action: name, path, why });
      return;
    }

    switch (name) {
      case 'read_file':
        if (path) this.read.set(path, { step, bytes: Number(result.bytes) || 0 });
        break;
      case 'list_files':
        // The root is listed as "." or "", and both mean the same folder. Normalising
        // matters because the whole point is recognising the repeat.
        this.listed.set(path || '.', (this.listed.get(path || '.') || 0) + 1);
        break;
      case 'search_workspace':
        break;
      case 'write_file':
        if (path) {
          this.written.set(path, { step, created: !this.read.has(path) && !this.written.has(path) });
          this.deleted.delete(path);
          // A file just written is a file whose contents the model now knows: it sent
          // them. Recording the read too is what stops the "write then immediately read
          // back the same file" pair that cost the 4B session a third of its steps.
          this.read.set(path, { step, bytes: (action.code || '').length });
        }
        break;
      case 'delete_file':
        if (path) {
          this.deleted.add(path);
          this.read.delete(path);
          this.written.delete(path);
        }
        break;
      case 'run_script':
        if (action.command) {
          this.commands.push({ command: String(action.command), cwd: String(action.cwd || ''), ok });
        }
        break;
      default:
        break;
    }
  }

  /**
   * Has this exact path already been fetched, and is it still there?
   *
   * @param {string} path
   * @returns {boolean}
   */
  hasRead(path) {
    const key = String(path || '');
    return this.read.has(key) && !this.deleted.has(key);
  }

  /**
   * How many times this folder has been listed.
   *
   * @param {string} path
   * @returns {number}
   */
  timesListed(path) {
    return this.listed.get(String(path || '') || '.') || 0;
  }

  /**
   * Nothing recorded yet — the block would be all headings and no content.
   *
   * Deletions and struggles count. A session whose only step was a failed read has
   * nothing in hand but does have something worth saying, and an earlier version of this
   * getter checked only the four "has" collections — so the one turn where the model
   * most needed telling what had just gone wrong was the turn that rendered nothing.
   */
  get isEmpty() {
    return (
      this.read.size === 0 &&
      this.written.size === 0 &&
      this.listed.size === 0 &&
      this.commands.length === 0 &&
      this.deleted.size === 0 &&
      this.struggles.length === 0
    );
  }

  /**
   * The standing block: what is already in hand, and what is therefore pointless.
   *
   * Phrased throughout as statements of fact about the session rather than as
   * instructions to the model, with one imperative at the end. A 0.8B model handed six
   * imperatives obeys the last one; handed a list of paths under a heading, it has
   * something it can check an intention against.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.includeStruggles]  Off for the smallest budgets, where the
   *   failures crowd out the paths and the paths are what prevent the loop.
   * @returns {string}
   */
  render(opts = {}) {
    if (this.isEmpty) return '';

    /** @type {string[]} */
    const lines = [];

    const readPaths = [...this.read.keys()].filter((path) => !this.deleted.has(path));
    if (readPaths.length > 0) {
      lines.push(`- Files you have ALREADY READ (you have their contents): ${renderPaths(readPaths)}`);
    }

    const writtenPaths = [...this.written.keys()];
    if (writtenPaths.length > 0) {
      lines.push(`- Files you have ALREADY WRITTEN (they exist — edit, do not recreate): ${renderPaths(writtenPaths)}`);
    }

    const listedPaths = [...this.listed.keys()];
    if (listedPaths.length > 0) {
      lines.push(`- Folders you have ALREADY LISTED (you know what is in them): ${renderPaths(listedPaths)}`);
    }

    if (this.deleted.size > 0) {
      lines.push(`- Files you have DELETED (they are gone): ${renderPaths([...this.deleted])}`);
    }

    if (this.commands.length > 0) {
      const recent = this.commands.slice(-MAX_COMMANDS_SHOWN).map((entry) => {
        const where = entry.cwd ? ` in ${shortPath(entry.cwd)}` : '';
        return `\`${entry.command}\`${where}${entry.ok ? '' : ' (failed)'}`;
      });
      lines.push(`- Commands you have ALREADY RUN: ${recent.join('; ')}`);
    }

    if (opts.includeStruggles && this.struggles.length > 0) {
      const last = this.struggles[this.struggles.length - 1];
      const target = last.path ? ` on ${shortPath(last.path)}` : '';
      lines.push(`- What went wrong last time: ${last.action}${target} — ${neutralize(last.why, { maxChars: 160 })}`);
    }

    // A session whose only record is a struggle, rendered with `includeStruggles` off,
    // reaches here with every section empty. Emitting the heading and the closing
    // imperative around nothing would spend tokens telling the model not to re-fetch an
    // empty list.
    if (lines.length === 0) return '';

    return `WHAT YOU ALREADY HAVE:\n${lines.join('\n')}\nDo not fetch any of it again. Use it.`;
  }
}

module.exports = {
  WorkingSet,
  isRecon,
  renderPaths,
  shortPath,
  FETCHING_ACTIONS,
  RECON_ACTIONS,
  MAX_PATHS_SHOWN,
  MAX_COMMANDS_SHOWN,
};
