'use strict';

/**
 * Ghost-text completions from the local model.
 *
 * This is the feature most likely to make the whole extension feel bad, because it
 * runs on *every keystroke pause* against a model that takes seconds per response on
 * CPU. Copilot's inline completion is backed by a datacentre; a 1–3B model on a
 * laptop is not, and pretending otherwise produces suggestions that arrive after the
 * user has already typed the line.
 *
 * So the design is defensive:
 *
 *  - **Debounced**, and every superseded request is aborted rather than left running.
 *    Ten queued requests on a CPU-bound machine is a stalled editor.
 *  - **Off by default.** It is opt-in via `hirayacoder.inlineCompletion.enabled`,
 *    because the honest default on this hardware is "don't".
 *  - **Skipped where it cannot help**: no completion inside a comment, on an empty
 *    line with no context, or when the model is already busy with a chat turn.
 *  - **One line at a time.** Multi-line generations from a small model are usually
 *    wrong past the first line, and a wrong five-line block is more disruptive to
 *    dismiss than a wrong one-liner.
 *
 * @module features/inlineCompletion
 */

const vscode = require('vscode');

const logger = require('../utils/logger');

/** How long the typing has to stop before a request goes out. */
const DEBOUNCE_MS = 350;

/** A completion that arrives after this is worse than none — the user has moved on. */
const REQUEST_TIMEOUT_MS = 8000;

/** Lines of context on each side of the cursor. */
const PREFIX_LINES = 40;
const SUFFIX_LINES = 10;

/**
 * Trim a model completion down to something safe to insert.
 *
 * Small models like to restate the prompt, wrap output in a code fence, or explain
 * themselves. None of that can go into the buffer.
 *
 * @param {string} raw
 * @param {string} currentLine  Text already on the line, left of the cursor.
 * @returns {string}
 */
function cleanCompletion(raw, currentLine) {
  let text = String(raw == null ? '' : raw);

  // Strip a code fence if the model wrapped its answer.
  const fence = /^\s*```[a-z]*\s*\n?([\s\S]*?)```\s*$/i.exec(text);
  if (fence) text = fence[1];

  // Models frequently echo the line back with the completion appended. Inserting
  // that duplicates whatever the user already typed.
  const trimmedLine = currentLine.trim();
  if (trimmedLine && text.trimStart().startsWith(trimmedLine)) {
    text = text.trimStart().slice(trimmedLine.length);
    // The echoed prefix takes its trailing space with it only if the model wrote
    // one. When the cursor already sits after a space — `const total = |` — the
    // remainder still begins with one, and inserting it gives a double space.
    if (/\s$/.test(currentLine)) text = text.replace(/^[ \t]+/, '');
  }

  // One line only.
  const firstBreak = text.indexOf('\n');
  if (firstBreak !== -1) text = text.slice(0, firstBreak);

  // A completion that is only whitespace would show an empty ghost the user cannot
  // see but can still accept.
  return text.trimEnd();
}

/**
 * Should a completion even be attempted here?
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {boolean}
 */
function shouldComplete(document, position) {
  const line = document.lineAt(position.line).text;
  const before = line.slice(0, position.character);

  // Mid-word: the model would complete the identifier the user is still typing,
  // which fights with the editor's own IntelliSense.
  if (/[\w$]$/.test(before) && position.character < line.length && /[\w$]/.test(line[position.character])) {
    return false;
  }

  const trimmed = before.trim();
  // Inside a line comment there is nothing useful to predict, and a model asked to
  // continue a comment writes prose into source.
  if (/^(\/\/|#|\*|--)/.test(trimmed)) return false;

  return true;
}

/**
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @returns {{prefix: string, suffix: string}}
 */
function gatherContext(document, position) {
  const startLine = Math.max(0, position.line - PREFIX_LINES);
  const endLine = Math.min(document.lineCount - 1, position.line + SUFFIX_LINES);

  const prefix = document.getText(
    new vscode.Range(new vscode.Position(startLine, 0), position)
  );
  const suffix = document.getText(
    new vscode.Range(position, new vscode.Position(endLine, document.lineAt(endLine).text.length))
  );

  return { prefix, suffix };
}

/**
 * Ghost-text provider backed by Ollama's `/api/generate`.
 */
class InlineCompletionProvider {
  /**
   * @param {object} options
   * @param {() => import('../core/ollamaClient').OllamaClient | null} options.getClient
   * @param {() => string | null} options.getModel
   * @param {() => boolean} options.isEnabled
   * @param {() => boolean} options.isBusy  True while a chat turn is running.
   */
  constructor(options) {
    this.getClient = options.getClient;
    this.getModel = options.getModel;
    this.isEnabled = options.isEnabled;
    this.isBusy = options.isBusy;

    /** @type {AbortController | null} */
    this._inFlight = null;
    /** @type {NodeJS.Timeout | null} */
    this._timer = null;
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.Position} position
   * @param {vscode.InlineCompletionContext} _context
   * @param {vscode.CancellationToken} token
   * @returns {Promise<vscode.InlineCompletionItem[]>}
   */
  async provideInlineCompletionItems(document, position, _context, token) {
    if (!this.isEnabled()) return [];
    // The model is single-threaded from this machine's point of view. Competing with
    // an agent turn would slow both and delay the one the user is watching.
    if (this.isBusy()) return [];
    if (!shouldComplete(document, position)) return [];

    const client = this.getClient();
    const model = this.getModel();
    if (!client || !model) return [];

    const settled = await this._debounce(token);
    if (!settled || token.isCancellationRequested) return [];

    // Supersede any request still running for an earlier keystroke.
    if (this._inFlight) this._inFlight.abort();
    const controller = new AbortController();
    this._inFlight = controller;
    token.onCancellationRequested(() => controller.abort());

    const { prefix, suffix } = gatherContext(document, position);
    const currentLine = document.lineAt(position.line).text.slice(0, position.character);

    try {
      const response = await client.generate(
        {
          model,
          prompt:
            `Continue this ${document.languageId} code. Reply with code only — no explanation, ` +
            `no markdown fence, and only the rest of the current line.\n\n` +
            `${prefix}<CURSOR>${suffix}\n\nText to insert at <CURSOR>:`,
          // Deterministic-ish: a creative completion is a wrong completion.
          options: { temperature: 0.1, num_predict: 64, stop: ['\n\n', '```'] },
          think: false,
          stream: false,
        },
        { timeoutMs: REQUEST_TIMEOUT_MS, signal: controller.signal }
      );

      if (token.isCancellationRequested) return [];

      const text = cleanCompletion((response && response.response) || '', currentLine);
      if (!text) return [];

      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    } catch (err) {
      // Aborts are the normal case here, not an error worth showing anyone.
      const message = /** @type {Error} */ (err).message || '';
      if (!/abort/i.test(message)) logger.debug(`Inline completion failed: ${message}`);
      return [];
    } finally {
      if (this._inFlight === controller) this._inFlight = null;
    }
  }

  /**
   * Resolve true when the user has stopped typing, false if cancelled first.
   *
   * @param {vscode.CancellationToken} token
   * @returns {Promise<boolean>}
   * @private
   */
  _debounce(token) {
    if (this._timer) clearTimeout(this._timer);
    return new Promise((resolve) => {
      this._timer = setTimeout(() => resolve(true), DEBOUNCE_MS);
      token.onCancellationRequested(() => {
        if (this._timer) clearTimeout(this._timer);
        resolve(false);
      });
    });
  }

  dispose() {
    if (this._timer) clearTimeout(this._timer);
    if (this._inFlight) this._inFlight.abort();
  }
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {ConstructorParameters<typeof InlineCompletionProvider>[0]} options
 * @returns {InlineCompletionProvider}
 */
function register(context, options) {
  const provider = new InlineCompletionProvider(options);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ scheme: 'file' }, provider),
    provider
  );
  return provider;
}

module.exports = {
  register,
  InlineCompletionProvider,
  cleanCompletion,
  shouldComplete,
  DEBOUNCE_MS,
};
