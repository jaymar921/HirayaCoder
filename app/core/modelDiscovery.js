'use strict';

/**
 * Discovers locally installed Ollama models and turns them into the normalized
 * records the dropdown, status bar, and capability classifier consume.
 *
 * ## Why `/api/show` is a fallback rather than the primary source
 *
 * `PROMPT.md` section 4 calls for a `POST /api/show` per model to read parameter
 * size and tool-calling capability. Current Ollama (0.32.x) already returns
 * `details.parameter_size`, `details.context_length`, and `capabilities` inline from
 * `GET /api/tags` — so issuing N extra round-trips on every dropdown open would add
 * latency for data already in hand.
 *
 * This module therefore builds records from `/api/tags` alone whenever that response
 * is complete, and falls back to `/api/show` per model only for entries missing
 * fields (older Ollama builds, unusual manifests). Results of the fallback are
 * cached by name+digest so the cost is paid at most once per model.
 *
 * @module core/modelDiscovery
 */

const logger = require('../utils/logger');
const { parseParameterSize, formatParams } = require('./modelCapability');

/**
 * @typedef {object} DiscoveredModel
 * @property {string} name
 * @property {number | null} params            Billions of parameters, null if unknown.
 * @property {string} paramsLabel              e.g. '1.2B', or 'unknown size'.
 * @property {boolean} supportsTools
 * @property {number | null} contextLength
 * @property {number | null} sizeBytes         On-disk size.
 * @property {string | null} quantization
 * @property {string | null} family
 * @property {string | null} modifiedAt
 * @property {string | null} digest
 * @property {boolean} detailsComplete         False when /api/show was needed and still fell short.
 */

/**
 * @typedef {object} Recommendation
 * @property {string} model
 * @property {number} params
 * @property {string} message
 */

/** How long a successful `/api/tags` result stays fresh, in ms. */
const TAGS_CACHE_TTL_MS = 30000;

/**
 * Turn one `/api/tags` entry into a normalized record.
 *
 * @param {import('./ollamaClient').OllamaTagEntry} entry
 * @returns {DiscoveredModel}
 */
function normalizeTagEntry(entry) {
  const details = (entry && entry.details) || {};
  const capabilities = Array.isArray(entry && entry.capabilities) ? entry.capabilities : [];
  const params = parseParameterSize(details.parameter_size);

  return {
    name: String((entry && entry.name) || (entry && entry.model) || '').trim(),
    params,
    paramsLabel: params === null ? 'unknown size' : formatParams(params),
    supportsTools: capabilities.includes('tools'),
    // Reported by Ollama for hybrid reasoning models. Two very different things
    // depend on it: `think: false` must be sent to stop the reasoning trace eating
    // the token budget, and only these models are trusted to keep a TODO list.
    supportsThinking: capabilities.includes('thinking'),
    // Gates the image attachment button. Sending images to a model without this
    // wastes a long upload and returns a confused answer about text it cannot see.
    supportsVision: capabilities.includes('vision'),
    contextLength: typeof details.context_length === 'number' ? details.context_length : null,
    sizeBytes: typeof (entry && entry.size) === 'number' ? entry.size : null,
    quantization: details.quantization_level || null,
    family: details.family || null,
    modifiedAt: (entry && entry.modified_at) || null,
    digest: (entry && entry.digest) || null,
    // `capabilities` absent entirely means this Ollama build predates the field, so
    // we can't distinguish "no tools" from "not reported" without /api/show.
    detailsComplete: params !== null && Array.isArray(entry && entry.capabilities),
  };
}

/**
 * Fold an `/api/show` response into a record that `/api/tags` under-described.
 *
 * @param {DiscoveredModel} model
 * @param {any} show Raw `/api/show` response.
 * @returns {DiscoveredModel}
 */
function mergeShowDetails(model, show) {
  if (!show || typeof show !== 'object') return model;

  const details = show.details || {};
  const capabilities = Array.isArray(show.capabilities) ? show.capabilities : null;
  const modelInfo = show.model_info || {};

  const params = model.params !== null ? model.params : parseParameterSize(details.parameter_size);

  // Context length lives under a family-prefixed key, e.g. 'llama.context_length'.
  let contextLength = model.contextLength;
  if (contextLength === null) {
    const entry = Object.entries(modelInfo).find(
      ([key, value]) => key.endsWith('.context_length') && typeof value === 'number'
    );
    if (entry) contextLength = /** @type {number} */ (entry[1]);
    else if (typeof details.context_length === 'number') contextLength = details.context_length;
  }

  return {
    ...model,
    params,
    paramsLabel: params === null ? 'unknown size' : formatParams(params),
    supportsTools: capabilities ? capabilities.includes('tools') : model.supportsTools,
    supportsThinking: capabilities ? capabilities.includes('thinking') : model.supportsThinking,
    supportsVision: capabilities ? capabilities.includes('vision') : model.supportsVision,
    contextLength,
    quantization: model.quantization || details.quantization_level || null,
    family: model.family || details.family || null,
    detailsComplete: params !== null && Boolean(capabilities),
  };
}

/**
 * Decide whether to nudge the user toward a larger installed model.
 *
 * Informational only — the caller never switches models on the user's behalf.
 *
 * @param {DiscoveredModel[]} models
 * @param {string} selectedName
 * @param {object} [opts]
 * @param {number} [opts.recommendAboveParams] Default 7.
 * @param {Set<string>} [opts.dismissed]       Models the user already waved off.
 * @returns {Recommendation | null}
 */
function pickRecommendation(models, selectedName, opts = {}) {
  const threshold = typeof opts.recommendAboveParams === 'number' ? opts.recommendAboveParams : 7;
  const dismissed = opts.dismissed || new Set();

  const selected = models.find((m) => m.name === selectedName);
  const selectedParams = selected && selected.params !== null ? selected.params : 0;

  const candidates = models
    .filter((m) => m.params !== null && m.params > threshold)
    .filter((m) => m.name !== selectedName && !dismissed.has(m.name))
    // Only suggest something meaningfully bigger than what's already selected.
    .filter((m) => /** @type {number} */ (m.params) > selectedParams)
    .sort((a, b) => /** @type {number} */ (b.params) - /** @type {number} */ (a.params));

  if (candidates.length === 0) return null;

  const best = candidates[0];
  return {
    model: best.name,
    params: /** @type {number} */ (best.params),
    message:
      `You have a larger model installed — for better results on capable hardware, ` +
      `consider switching to \`${best.name}\` (${best.paramsLabel}).`,
  };
}

class ModelDiscovery {
  /**
   * @param {import('./ollamaClient').OllamaClient} client
   */
  constructor(client) {
    this.client = client;
    /** @type {DiscoveredModel[] | null} */
    this._cache = null;
    /** @type {number} */
    this._cachedAt = 0;
    /** @type {Map<string, any>} Keyed by `name@digest` so a re-pulled model re-fetches. */
    this._showCache = new Map();
    /** @type {Promise<DiscoveredModel[]> | null} Dedupes concurrent refreshes. */
    this._inflight = null;
  }

  /**
   * List installed models, re-polling `/api/tags` when the cache is stale.
   *
   * The dropdown passes `force: true` on open, since models can be pulled outside
   * the extension at any time via `ollama pull`.
   *
   * @param {{force?: boolean, signal?: AbortSignal}} [opts]
   * @returns {Promise<DiscoveredModel[]>}
   */
  async list(opts = {}) {
    const fresh = this._cache && Date.now() - this._cachedAt < TAGS_CACHE_TTL_MS;
    if (fresh && !opts.force) return /** @type {DiscoveredModel[]} */ (this._cache);
    if (this._inflight) return this._inflight;

    this._inflight = this._fetch(opts).finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  /**
   * @param {{signal?: AbortSignal}} opts
   * @returns {Promise<DiscoveredModel[]>}
   * @private
   */
  async _fetch(opts) {
    const entries = await this.client.tags({ signal: opts.signal });
    const models = entries.map(normalizeTagEntry).filter((m) => m.name.length > 0);

    // Only pay for /api/show where /api/tags came up short.
    const incomplete = models.filter((m) => !m.detailsComplete);
    let resolved = models;
    if (incomplete.length > 0) {
      logger.debug(`Filling in details for ${incomplete.length} model(s) via /api/show.`);
      /** @type {Map<string, DiscoveredModel>} */
      const updates = new Map();
      await Promise.all(
        incomplete.map(async (model) => {
          try {
            const key = `${model.name}@${model.digest || ''}`;
            let show = this._showCache.get(key);
            if (!show) {
              show = await this.client.show(model.name, { signal: opts.signal });
              this._showCache.set(key, show);
            }
            updates.set(model.name, mergeShowDetails(model, show));
          } catch (err) {
            // A model whose details can't be read is still usable — it just gets
            // classified conservatively (Tier B) by modelCapability.
            logger.warn(`Could not read details for ${model.name}: ${/** @type {Error} */ (err).message}`);
          }
        })
      );
      resolved = models.map((model) => updates.get(model.name) || model);
    }

    resolved.sort((a, b) => a.name.localeCompare(b.name));
    this._cache = resolved;
    this._cachedAt = Date.now();
    return resolved;
  }

  /**
   * @param {string} name
   * @param {{force?: boolean}} [opts]
   * @returns {Promise<DiscoveredModel | null>}
   */
  async get(name, opts = {}) {
    const models = await this.list(opts);
    return models.find((m) => m.name === name) || null;
  }

  /** Drop all caches — call after a settings change or an explicit refresh. */
  invalidate() {
    this._cache = null;
    this._cachedAt = 0;
  }
}

module.exports = {
  ModelDiscovery,
  normalizeTagEntry,
  mergeShowDetails,
  pickRecommendation,
  TAGS_CACHE_TTL_MS,
};
