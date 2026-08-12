'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  ModelDiscovery,
  normalizeTagEntry,
  mergeShowDetails,
  pickRecommendation,
} = require('../../app/core/modelDiscovery');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'ollama-tags.json'), 'utf8')
);

/** @returns {any[]} */
function tagEntries() {
  return JSON.parse(JSON.stringify(fixture.models));
}

/**
 * Minimal stand-in for OllamaClient that records what it was asked for.
 *
 * @param {any[]} models
 * @param {Record<string, any>} [showResponses]
 */
function fakeClient(models, showResponses = {}) {
  return {
    tagsCalls: 0,
    showCalls: /** @type {string[]} */ ([]),
    async tags() {
      this.tagsCalls += 1;
      return models;
    },
    async show(name) {
      this.showCalls.push(name);
      if (showResponses[name]) return showResponses[name];
      throw new Error(`no fixture for ${name}`);
    },
  };
}

describe('modelDiscovery.normalizeTagEntry', () => {
  it('reads parameter size, context length, and capabilities inline from /api/tags', () => {
    const model = normalizeTagEntry(tagEntries()[0]);
    assert.strictEqual(model.name, 'llama3.2:1b');
    assert.strictEqual(model.params, 1.2);
    assert.strictEqual(model.paramsLabel, '1.2B');
    assert.strictEqual(model.supportsTools, true);
    assert.strictEqual(model.contextLength, 131072);
    assert.strictEqual(model.detailsComplete, true);
  });

  it('marks a model without a capabilities array as incomplete', () => {
    // Older Ollama builds omit the field entirely — absent is not the same as
    // "no tools", so it must trigger the /api/show fallback rather than a guess.
    const legacy = normalizeTagEntry(tagEntries()[4]);
    assert.strictEqual(legacy.params, null);
    assert.strictEqual(legacy.paramsLabel, 'unknown size');
    assert.strictEqual(legacy.detailsComplete, false);
  });

  it('survives a malformed entry without throwing', () => {
    const model = normalizeTagEntry(/** @type {any} */ ({}));
    assert.strictEqual(model.name, '');
    assert.strictEqual(model.params, null);
    assert.strictEqual(model.supportsTools, false);
  });
});

describe('modelDiscovery.mergeShowDetails', () => {
  it('fills in size and capabilities from an /api/show response', () => {
    const base = normalizeTagEntry(tagEntries()[4]);
    const merged = mergeShowDetails(base, {
      details: { parameter_size: '1.1B', quantization_level: 'Q4_0', family: 'llama' },
      capabilities: ['completion', 'tools'],
      model_info: { 'llama.context_length': 8192 },
    });
    assert.strictEqual(merged.params, 1.1);
    assert.strictEqual(merged.supportsTools, true);
    assert.strictEqual(merged.contextLength, 8192);
    assert.strictEqual(merged.detailsComplete, true);
  });

  it('never overwrites values /api/tags already supplied', () => {
    const base = normalizeTagEntry(tagEntries()[0]);
    const merged = mergeShowDetails(base, { details: { parameter_size: '99B' } });
    assert.strictEqual(merged.params, 1.2);
  });

  it('returns the record untouched for a junk response', () => {
    const base = normalizeTagEntry(tagEntries()[0]);
    assert.deepStrictEqual(mergeShowDetails(base, null), base);
  });
});

describe('ModelDiscovery.list', () => {
  it('does not call /api/show when /api/tags is already complete', async () => {
    // The optimization that keeps dropdown-open latency flat: four of the five
    // fixture models are fully described inline.
    const client = fakeClient(tagEntries().slice(0, 4));
    const discovery = new ModelDiscovery(/** @type {any} */ (client));
    const models = await discovery.list();
    assert.strictEqual(models.length, 4);
    assert.deepStrictEqual(client.showCalls, []);
  });

  it('calls /api/show only for incomplete entries', async () => {
    const client = fakeClient(tagEntries(), {
      'legacy-model:latest': {
        details: { parameter_size: '1.1B' },
        capabilities: ['completion'],
      },
    });
    const discovery = new ModelDiscovery(/** @type {any} */ (client));
    const models = await discovery.list();
    assert.deepStrictEqual(client.showCalls, ['legacy-model:latest']);
    const legacy = models.find((m) => m.name === 'legacy-model:latest');
    assert.strictEqual(legacy.params, 1.1);
  });

  it('keeps a model usable when /api/show fails', async () => {
    const client = fakeClient(tagEntries()); // show() always throws
    const discovery = new ModelDiscovery(/** @type {any} */ (client));
    const models = await discovery.list();
    const legacy = models.find((m) => m.name === 'legacy-model:latest');
    assert.ok(legacy, 'model is still listed');
    assert.strictEqual(legacy.params, null);
    assert.strictEqual(legacy.supportsTools, false, 'classified conservatively into Tier B');
  });

  it('serves a cached list until forced', async () => {
    const client = fakeClient(tagEntries().slice(0, 4));
    const discovery = new ModelDiscovery(/** @type {any} */ (client));
    await discovery.list();
    await discovery.list();
    assert.strictEqual(client.tagsCalls, 1);

    // The dropdown forces a re-poll on open, since `ollama pull` can happen anytime.
    await discovery.list({ force: true });
    assert.strictEqual(client.tagsCalls, 2);
  });

  it('dedupes concurrent refreshes into one request', async () => {
    const client = fakeClient(tagEntries().slice(0, 4));
    const discovery = new ModelDiscovery(/** @type {any} */ (client));
    await Promise.all([discovery.list(), discovery.list(), discovery.list()]);
    assert.strictEqual(client.tagsCalls, 1);
  });

  it('returns an empty list rather than throwing when nothing is installed', async () => {
    const discovery = new ModelDiscovery(/** @type {any} */ (fakeClient([])));
    assert.deepStrictEqual(await discovery.list(), []);
  });
});

describe('modelDiscovery.pickRecommendation', () => {
  const models = tagEntries().map(normalizeTagEntry);

  it('suggests a >7B model when a small one is selected', () => {
    const rec = pickRecommendation(models, 'llama3.2:1b');
    assert.ok(rec);
    assert.strictEqual(rec.model, 'qwen2.5-coder:7b');
    assert.match(rec.message, /consider switching/i);
  });

  it('stays silent when the largest model is already selected', () => {
    assert.strictEqual(pickRecommendation(models, 'qwen2.5-coder:7b'), null);
  });

  it('respects a dismissal', () => {
    const rec = pickRecommendation(models, 'llama3.2:1b', { dismissed: new Set(['qwen2.5-coder:7b']) });
    assert.strictEqual(rec, null);
  });

  it('honors a custom threshold', () => {
    const rec = pickRecommendation(models, 'llama3.2:1b', { recommendAboveParams: 3 });
    assert.ok(rec);
    assert.strictEqual(rec.model, 'qwen2.5-coder:7b', 'still picks the largest candidate');
  });

  it('never suggests a model smaller than the current selection', () => {
    const rec = pickRecommendation(models, 'llama3.2:latest', { recommendAboveParams: 1 });
    assert.ok(rec);
    assert.ok(rec.params > 3.2);
  });

  it('ignores models whose size is unknown', () => {
    const rec = pickRecommendation(
      [normalizeTagEntry(tagEntries()[4])],
      'llama3.2:1b',
      { recommendAboveParams: 0 }
    );
    assert.strictEqual(rec, null);
  });
});
