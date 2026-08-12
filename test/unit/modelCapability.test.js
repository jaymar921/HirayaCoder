'use strict';

const assert = require('assert');
const {
  classify,
  budgetsFor,
  parseParameterSize,
  formatParams,
} = require('../../app/core/modelCapability');

describe('modelCapability.parseParameterSize', () => {
  it('parses the shapes Ollama actually emits', () => {
    assert.strictEqual(parseParameterSize('1.2B'), 1.2);
    assert.strictEqual(parseParameterSize('3B'), 3);
    assert.strictEqual(parseParameterSize('7.6B'), 7.6);
    assert.strictEqual(parseParameterSize('70B'), 70);
  });

  it('scales sub-billion sizes into billions', () => {
    assert.strictEqual(parseParameterSize('500M'), 0.5);
    assert.strictEqual(parseParameterSize('137M'), 0.137);
  });

  it('reports mixture-of-experts models by total parameters', () => {
    // Total governs memory pressure on a low-spec laptop, which is what the tier
    // threshold is protecting against.
    assert.strictEqual(parseParameterSize('8x7B'), 56);
  });

  it('returns null rather than guessing when the size is missing or junk', () => {
    assert.strictEqual(parseParameterSize(undefined), null);
    assert.strictEqual(parseParameterSize(null), null);
    assert.strictEqual(parseParameterSize(''), null);
    assert.strictEqual(parseParameterSize('enormous'), null);
  });
});

describe('modelCapability.classify', () => {
  it('keeps a tool-advertising 1B model on the lite ReAct loop', () => {
    // The regression this whole rule exists for: Ollama reports tools support for
    // llama3.2:1b, so a capability-only rule would hand the extension's flagship
    // lite target to the native loop and reactLoop.js would never run.
    const result = classify({ name: 'llama3.2:1b', params: 1.2, supportsTools: true });
    assert.strictEqual(result.tier, 'B');
    assert.strictEqual(result.strategy, 'react');
    assert.strictEqual(result.label, 'Lite');
  });

  it('classifies a large tool-calling model as Tier A', () => {
    const result = classify({ name: 'qwen2.5-coder:7b', params: 7.6, supportsTools: true });
    assert.strictEqual(result.tier, 'A');
    assert.strictEqual(result.strategy, 'native');
    assert.strictEqual(result.label, 'Agentic');
  });

  it('classifies any model without tool support as Tier B regardless of size', () => {
    const result = classify({ name: 'big-no-tools:34b', params: 34, supportsTools: false });
    assert.strictEqual(result.tier, 'B');
  });

  it('treats the threshold as inclusive', () => {
    assert.strictEqual(classify({ name: 'm', params: 3, supportsTools: true }).tier, 'B');
    assert.strictEqual(classify({ name: 'm', params: 3.2, supportsTools: true }).tier, 'A');
  });

  it('honors a configurable threshold', () => {
    const relaxed = classify({ name: 'llama3.2:1b', params: 1.2, supportsTools: true }, { liteTierMaxParams: 1 });
    assert.strictEqual(relaxed.tier, 'A');
  });

  it('falls back to capability alone when the threshold is zero', () => {
    const result = classify({ name: 'tiny:0.5b', params: 0.5, supportsTools: true }, { liteTierMaxParams: 0 });
    assert.strictEqual(result.tier, 'A', 'threshold 0 restores the literal spec rule');
  });

  it('applies a per-model override and flags it as overridden', () => {
    const result = classify(
      { name: 'llama3.2:1b', params: 1.2, supportsTools: true },
      { tierOverrides: { 'llama3.2:1b': 'A' } }
    );
    assert.strictEqual(result.tier, 'A');
    assert.strictEqual(result.overridden, true);
  });

  it('lets an override force a capable model down to the lite loop', () => {
    const result = classify(
      { name: 'qwen2.5-coder:7b', params: 7.6, supportsTools: true },
      { tierOverrides: { 'qwen2.5-coder:7b': 'B' } }
    );
    assert.strictEqual(result.tier, 'B');
    assert.strictEqual(result.strategy, 'react');
  });

  it('trusts advertised tool support when the size is unknown', () => {
    const result = classify({ name: 'mystery:latest', params: null, supportsTools: true });
    assert.strictEqual(result.tier, 'A');
    assert.match(result.reason, /size unknown/i);
  });

  it('always explains itself', () => {
    const result = classify({ name: 'llama3.2:1b', params: 1.2, supportsTools: true });
    assert.ok(result.reason.length > 0);
    assert.match(result.reason, /1\.2B/);
  });
});

describe('modelCapability.budgetsFor', () => {
  it('scales step budget with thinking capacity on Tier A', () => {
    assert.strictEqual(budgetsFor('A', 'low').maxSteps, 8);
    assert.strictEqual(budgetsFor('A', 'medium').maxSteps, 15);
    assert.strictEqual(budgetsFor('A', 'high').maxSteps, 25);
  });

  it('does not give small models more steps at high thinking — only more memory', () => {
    assert.strictEqual(budgetsFor('B', 'medium').maxSteps, 8);
    assert.strictEqual(budgetsFor('B', 'high').maxSteps, 8);
    assert.strictEqual(budgetsFor('B', 'medium').memoryRecallEntries, 5);
    assert.strictEqual(budgetsFor('B', 'high').memoryRecallEntries, Infinity);
  });

  it('re-condenses memory every step only at high thinking on Tier B', () => {
    assert.strictEqual(budgetsFor('B', 'high').translateFrequency, 'every-step');
    assert.strictEqual(budgetsFor('B', 'medium').translateFrequency, 'session-end');
  });

  it('requests a reasoning trace only at high thinking on Tier A', () => {
    assert.strictEqual(budgetsFor('A', 'high').requestReasoning, true);
    assert.strictEqual(budgetsFor('A', 'medium').requestReasoning, false);
    assert.strictEqual(budgetsFor('B', 'high').requestReasoning, false);
  });

  it('keeps the Tier B per-turn prompt inside a 1B-friendly budget', () => {
    assert.ok(budgetsFor('B', 'high').promptTokenTarget <= 2000);
    assert.ok(budgetsFor('B', 'low').promptTokenTarget <= 2000);
  });

  it('falls back to medium for an unrecognized capacity', () => {
    assert.deepStrictEqual(budgetsFor('B', /** @type {any} */ ('bogus')), budgetsFor('B', 'medium'));
  });
});

describe('modelCapability.formatParams', () => {
  it('renders sub-billion sizes in millions', () => {
    assert.strictEqual(formatParams(0.5), '500M');
  });

  it('trims trailing zeros', () => {
    assert.strictEqual(formatParams(3), '3B');
    assert.strictEqual(formatParams(1.2), '1.2B');
  });
});
