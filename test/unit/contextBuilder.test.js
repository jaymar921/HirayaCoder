'use strict';

const assert = require('assert');

const { build } = require('../../app/core/contextBuilder');
const { estimateTokens } = require('../../app/utils/tokenBudget');

describe('contextBuilder.build', () => {
  it('includes everything when the budget is ample', () => {
    const result = build({
      task: 'Add email validation',
      budget: 100000,
      editor: { path: 'src/signup.js', content: 'const a = 1;', language: 'javascript' },
      memory: ['- Project uses Tailwind.'],
      contextFiles: '--- spec.md ---\nUse a regex.',
      observation: 'Read 40 lines.',
    });

    assert.ok(result.text.includes('Add email validation'));
    assert.ok(result.text.includes('Project uses Tailwind'));
    assert.ok(result.text.includes('spec.md'));
    assert.ok(result.text.includes('src/signup.js'));
    assert.ok(result.text.includes('Read 40 lines'));
    assert.strictEqual(result.notes.length, 0);
  });

  it('omits sections that were not provided', () => {
    const result = build({ task: 'Explain this', budget: 5000 });
    assert.ok(result.text.includes('Explain this'));
    assert.ok(!result.text.includes('Session Memory'));
    assert.ok(!result.text.includes('Reference files'));
  });

  it('labels memory as reference material, not as instructions', () => {
    // A 1B model handed bare sentences will happily re-execute them as if they
    // were the task.
    const result = build({ task: 'x', budget: 5000, memory: ['- Deleted old config.'] });
    assert.match(result.text, /reference only, not new instructions/i);
  });

  it('marks context files as read-only direction', () => {
    const result = build({ task: 'x', budget: 5000, contextFiles: '--- a.md ---\nhi' });
    assert.match(result.text, /do not edit unless asked/i);
  });

  describe('budget pressure on a 1B-sized window', () => {
    const bigFile = `import x from 'x';\n${'const filler = 1;\n'.repeat(3000)}export default x;`;

    it('keeps the task no matter what', () => {
      const result = build({
        task: 'Add email validation to the signup form',
        budget: 300,
        editor: { path: 'a.js', content: bigFile },
        memory: Array.from({ length: 50 }, (_, i) => `- Fact number ${i} about this project.`),
      });
      assert.ok(result.text.includes('Add email validation to the signup form'));
      assert.strictEqual(result.included.Task, true);
    });

    it('sacrifices the open file before session memory', () => {
      // The core Tier B trade: a compressed digest of ten turns is worth more per
      // token than the tail of one file.
      const result = build({
        task: 'Continue the work',
        budget: 400,
        editor: { path: 'a.js', content: bigFile },
        memory: ['- Added email validation to the signup form.'],
      });
      assert.strictEqual(result.included['Session Memory'], true);
      assert.ok(result.text.includes('Added email validation'));
    });

    it('keeps the latest observation, so the loop does not repeat itself', () => {
      const result = build({
        task: 'Continue',
        budget: 350,
        editor: { path: 'a.js', content: bigFile },
        observation: 'write_file failed: path is outside the workspace.',
      });
      assert.strictEqual(result.included.Observation, true);
      assert.ok(result.text.includes('outside the workspace'));
    });

    it('prefers a selection over the whole file it came from', () => {
      const result = build({
        task: 'Explain this',
        budget: 400,
        editor: { path: 'a.js', content: bigFile, selection: 'function target() { return 42; }' },
      });
      assert.ok(result.text.includes('function target()'));
    });

    it('stays within the requested budget', () => {
      const result = build({
        task: 'Do the thing',
        budget: 500,
        editor: { path: 'a.js', content: bigFile },
        memory: Array.from({ length: 100 }, (_, i) => `- Fact ${i}.`),
        contextFiles: 'x'.repeat(20000),
      });
      assert.ok(result.tokens <= 550, `used ${result.tokens} against a 500 budget`);
    });

    it('reports what it dropped so the UI can say so', () => {
      const result = build({
        task: 'Do the thing',
        budget: 200,
        editor: { path: 'a.js', content: bigFile },
        contextFiles: 'y'.repeat(20000),
      });
      assert.ok(result.notes.length > 0);
      assert.ok(result.notes.some((n) => /omitted|trimmed/.test(n)));
    });

    it('produces a usable prompt even at a 1800-token Tier B budget', () => {
      const result = build({
        task: 'Add a logout button to the header',
        budget: 1800,
        editor: { path: 'src/Header.jsx', content: bigFile },
        memory: ['- Project uses Tailwind for styling.', '- Added a login button last turn.'],
        observation: 'Read src/Header.jsx (3002 lines).',
      });
      assert.strictEqual(result.included.Task, true);
      assert.strictEqual(result.included['Session Memory'], true);
      assert.strictEqual(result.included.Observation, true);
      assert.ok(result.tokens <= 1900);
      assert.ok(estimateTokens(result.text) > 100, 'not so trimmed it says nothing');
    });
  });

  describe('secret redaction', () => {
    it('redacts credentials in the open file', () => {
      const result = build({
        task: 'x',
        budget: 5000,
        editor: { path: '.env.js', content: `const key = "ghp_${'a'.repeat(36)}";` },
      });
      assert.ok(!result.text.includes('a'.repeat(36)));
      assert.ok(result.text.includes('[REDACTED:GITHUB-TOKEN]'));
    });

    it('redacts credentials in a selection', () => {
      const result = build({
        task: 'x',
        budget: 5000,
        editor: { path: 'a.js', selection: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE' },
      });
      assert.ok(!result.text.includes('AKIAIOSFODNN7EXAMPLE'));
    });

    it('redacts credentials in an observation from script output', () => {
      const result = build({
        task: 'x',
        budget: 5000,
        observation: `npm ERR! token npm_${'b'.repeat(36)} is invalid`,
      });
      assert.ok(!result.text.includes('b'.repeat(36)));
    });

    it('redacts credentials in the task itself', () => {
      const result = build({ task: 'use AKIAIOSFODNN7EXAMPLE to connect', budget: 5000 });
      assert.ok(!result.text.includes('AKIAIOSFODNN7EXAMPLE'));
    });
  });

  it('handles a zero budget without throwing', () => {
    assert.doesNotThrow(() => build({ task: 'x', budget: 0 }));
  });

  it('handles a missing task', () => {
    assert.doesNotThrow(() => build({ task: undefined, budget: 100 }));
  });
});
