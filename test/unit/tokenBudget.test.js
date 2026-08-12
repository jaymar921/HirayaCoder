'use strict';

const assert = require('assert');

const { estimateTokens, truncateToTokens, allocate } = require('../../app/utils/tokenBudget');

describe('tokenBudget.estimateTokens', () => {
  it('returns zero for empty input', () => {
    assert.strictEqual(estimateTokens(''), 0);
    assert.strictEqual(estimateTokens(/** @type {any} */ (null)), 0);
  });

  it('scales with length', () => {
    assert.ok(estimateTokens('a'.repeat(400)) > estimateTokens('a'.repeat(100)));
  });

  it('errs high rather than low', () => {
    // Under-estimating is the dangerous direction: Ollama silently truncates and
    // the model answers about half a file without saying so.
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
    // ~90 words; a real tokenizer lands near 110. We must not come in under that.
    assert.ok(estimateTokens(prose) >= 110, `got ${estimateTokens(prose)}`);
  });

  it('counts punctuation-dense code above the naive character estimate', () => {
    const code = 'const x = arr.map((a) => ({ ...a, b: [1,2,3] }));';
    assert.ok(estimateTokens(code) > code.length / 4);
  });
});

describe('tokenBudget.truncateToTokens', () => {
  it('leaves text that already fits untouched', () => {
    const result = truncateToTokens('short text', 100);
    assert.strictEqual(result.text, 'short text');
    assert.strictEqual(result.truncated, false);
  });

  it('trims to roughly the requested budget', () => {
    const result = truncateToTokens('word '.repeat(1000), 100);
    assert.strictEqual(result.truncated, true);
    assert.ok(estimateTokens(result.text) <= 120, `got ${estimateTokens(result.text)}`);
  });

  it('keeps the head by default', () => {
    const result = truncateToTokens('START' + 'x'.repeat(5000) + 'END', 50);
    assert.ok(result.text.startsWith('START'));
    assert.ok(!result.text.endsWith('END'));
  });

  it('can keep the tail instead', () => {
    const result = truncateToTokens('START' + 'x'.repeat(5000) + 'END', 50, { keep: 'tail' });
    assert.ok(result.text.endsWith('END'));
  });

  it('keeps both ends for file content, so imports and exports both survive', () => {
    const file = `import fs from 'fs';\n${'// filler\n'.repeat(2000)}export default thing;`;
    const result = truncateToTokens(file, 120, { keep: 'both' });
    assert.ok(result.text.includes("import fs from 'fs'"), 'head lost');
    assert.ok(result.text.includes('export default thing'), 'tail lost');
    assert.ok(result.text.includes('trimmed'), 'elision not marked');
  });

  it('reports the original size so the UI can say what was cut', () => {
    const result = truncateToTokens('word '.repeat(1000), 50);
    assert.ok(result.originalTokens > 500);
  });

  it('degrades gracefully at a zero or negative budget', () => {
    assert.doesNotThrow(() => truncateToTokens('some text', 0));
    assert.doesNotThrow(() => truncateToTokens('some text', -5));
  });
});

describe('tokenBudget.allocate', () => {
  const section = (name, priority, size, extra = {}) => ({
    name,
    content: `${name}: ${'word '.repeat(size)}`,
    priority,
    ...extra,
  });

  it('keeps everything when the budget is ample', () => {
    const result = allocate([section('A', 10, 10), section('B', 5, 10)], 10000);
    assert.ok(result.sections.every((s) => !s.dropped && !s.truncated));
    assert.strictEqual(result.notes.length, 0);
  });

  it('preserves the caller order regardless of priority', () => {
    const result = allocate([section('Low', 1, 5), section('High', 99, 5)], 10000);
    assert.deepStrictEqual(result.sections.map((s) => s.name), ['Low', 'High']);
  });

  it('sacrifices the lowest priority first', () => {
    // 'Task' must survive a squeeze that kills 'Open File'.
    const sections = [
      section('Open File', 50, 400, { minTokens: 100 }),
      section('Task', 100, 10),
    ];
    const result = allocate(sections, 60);
    const byName = Object.fromEntries(result.sections.map((s) => [s.name, s]));
    assert.strictEqual(byName.Task.dropped, false);
    assert.strictEqual(byName['Open File'].dropped, true);
  });

  it('drops a section rather than leaving a misleading fragment', () => {
    // Half a memory block is worse than none — the model cannot tell it is
    // reading a fragment.
    const result = allocate([section('Memory', 10, 200, { minTokens: 150 })], 40);
    assert.strictEqual(result.sections[0].dropped, true);
    assert.match(result.notes[0], /omitted/);
  });

  it('truncates when there is room above the floor', () => {
    const result = allocate([section('Memory', 10, 500, { minTokens: 20 })], 100);
    assert.strictEqual(result.sections[0].dropped, false);
    assert.strictEqual(result.sections[0].truncated, true);
    assert.match(result.notes[0], /trimmed/);
  });

  it('stays within budget overall', () => {
    const result = allocate(
      [section('A', 30, 300), section('B', 20, 300), section('C', 10, 300)],
      200
    );
    assert.ok(result.totalTokens <= 200 * 1.05, `used ${result.totalTokens} of 200`);
  });

  it('handles a zero budget without throwing', () => {
    const result = allocate([section('A', 10, 10)], 0);
    assert.strictEqual(result.sections[0].dropped, true);
  });

  it('handles an empty section list', () => {
    assert.deepStrictEqual(allocate([], 100).sections, []);
  });
});
