'use strict';

/**
 * Listing, switching, and pulling Ollama models.
 *
 * `core/modelDiscovery.js` knows what is installed; this turns that into the things
 * a user does — annotate the dropdown, switch the active model, download a new one
 * with visible progress.
 *
 * ## Pulling is a deliberate act
 *
 * `ollama pull` writes gigabytes to disk and saturates the connection, so it is never
 * triggered on the extension's own initiative — not by a recommendation, not by a
 * model being missing, and certainly not by something a model suggested. The user
 * asks, is told the size where it is known, and confirms.
 *
 * @module features/modelManager
 */

const vscode = require('vscode');

const logger = require('../utils/logger');
const modelCapability = require('../core/modelCapability');

/** A single path/tag segment: letters, digits, dot, dash, underscore. */
const SEGMENT = /^[\w.-]+$/;

/**
 * Is this a plausible Ollama model name?
 *
 * Split-and-check rather than one pattern with a nested quantifier. The regex form
 * (`^[\w.-]+(:[\w.-]+)?$`) is flagged as potentially catastrophic to backtrack, and
 * although this particular one is safe — `:` cannot match the inner class — the value
 * comes from a text box and is worth expressing in a form with no ambiguity at all.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isValidModelName(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.length > 200) return false;

  const parts = trimmed.split(':');
  if (parts.length > 2) return false;
  return parts.every((part) => SEGMENT.test(part));
}

/**
 * Format a model for a quick pick or dropdown.
 *
 * @param {import('../core/modelDiscovery').DiscoveredModel} model
 * @param {import('../core/modelCapability').Capability} capability
 * @param {boolean} active
 * @returns {{label: string, description: string, detail: string, name: string}}
 */
function describeModel(model, capability, active) {
  const traits = [];
  if (capability.canPlanTodos) traits.push('TODO lists');
  if (model.supportsVision) traits.push('images');
  if (model.supportsThinking) traits.push('reasoning');

  return {
    name: model.name,
    label: active ? `$(check) ${model.name}` : model.name,
    description: `${model.paramsLabel} · ${capability.label}${traits.length ? ` · ${traits.join(', ')}` : ''}`,
    detail: capability.reason,
  };
}

/**
 * Classify every installed model for display.
 *
 * @param {import('../core/modelDiscovery').DiscoveredModel[]} models
 * @param {object} settings
 * @param {string | null} activeModel
 * @returns {Array<ReturnType<typeof describeModel>>}
 */
function listForPicker(models, settings, activeModel) {
  return models.map((model) => {
    const capability = modelCapability.classify(
      {
        name: model.name,
        params: model.params,
        supportsTools: model.supportsTools,
        supportsThinking: model.supportsThinking,
        contextLength: model.contextLength,
      },
      {
        liteTierMaxParams: settings.liteTierMaxParams,
        tierOverrides: settings.tierOverrides,
        todoMinParams: settings.todoMinParams,
      }
    );
    return describeModel(model, capability, model.name === activeModel);
  });
}

/**
 * Pull a model, reporting progress in the VS Code notification area.
 *
 * Ollama streams NDJSON progress objects; the interesting ones carry `completed` and
 * `total` bytes. Percentages are reported as increments because VS Code's progress
 * API is incremental, and sending absolute values makes the bar jump backwards.
 *
 * @param {import('../core/ollamaClient').OllamaClient} client
 * @param {string} name
 * @returns {Promise<boolean>}
 */
async function pullModel(client, name) {
  const confirmed = await vscode.window.showWarningMessage(
    `Download "${name}" from the Ollama registry?`,
    { modal: true, detail: 'This can be several gigabytes and will use your connection.' },
    'Download'
  );
  if (confirmed !== 'Download') return false;

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Pulling ${name}`, cancellable: true },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      let lastPercent = 0;
      try {
        await client.pull(
          { model: name },
          {
            signal: controller.signal,
            onProgress: (event) => {
              if (!event || typeof event.total !== 'number' || !event.total) {
                if (event && event.status) progress.report({ message: String(event.status) });
                return;
              }
              const percent = Math.min(100, Math.round((event.completed / event.total) * 100));
              const increment = percent - lastPercent;
              lastPercent = percent;
              if (increment > 0) progress.report({ increment, message: `${percent}%` });
            },
          }
        );
        logger.info(`Pulled model ${name}.`);
        return true;
      } catch (err) {
        const message = /** @type {Error} */ (err).message || '';
        if (/abort/i.test(message)) {
          logger.info(`Pull of ${name} cancelled.`);
          return false;
        }
        logger.error(`Pull of ${name} failed: ${message}`);
        vscode.window.showErrorMessage(`HirayaCoder: could not pull ${name} — ${message}`);
        return false;
      }
    }
  );
}

/**
 * Prompt for a model name and pull it.
 *
 * @param {object} app
 * @returns {Promise<void>}
 */
async function pullModelCommand(app) {
  if (!app.client) {
    vscode.window.showWarningMessage('HirayaCoder: not connected to Ollama.');
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Pull an Ollama model',
    prompt: 'Model name, as it appears on ollama.com',
    placeHolder: 'qwen3.5:2b',
    validateInput: (value) => (isValidModelName(value) ? null : 'Use a name like "qwen3.5:2b".'),
  });
  if (!name) return;

  const pulled = await pullModel(app.client, name.trim());
  if (pulled) await app.refresh({ force: true });
}

module.exports = { describeModel, listForPicker, pullModel, pullModelCommand, isValidModelName };
