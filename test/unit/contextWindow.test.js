'use strict';

/**
 * The context window the extension asks Ollama for. Every request used to run in the
 * server's default, 4,096 tokens on any machine under 24 GiB of VRAM, and a prompt that
 * did not fit lost its beginning without a word.
 */

const assert = require('assert');

const contextWindow = require('../../app/core/contextWindow');
const { classify, budgetsFor, BUDGETS } = require('../../app/core/modelCapability');

describe('contextWindow', () => {
  describe('plan', () => {
    it('sizes the window for the largest prompt plus a full file of output', () => {
      const plan = contextWindow.plan({ largestPromptTarget: 2000 });
      // 2000 × 2 overhead + 4096 reserve = 8096, so the next bucket up.
      assert.strictEqual(plan.numCtx, 8192);
      assert.strictEqual(plan.limited, false);
      assert.strictEqual(plan.source, 'auto');
    });

    it('stops at the auto ceiling and says the prompt will be trimmed', () => {
      const plan = contextWindow.plan({ largestPromptTarget: 24000 });
      assert.strictEqual(plan.numCtx, contextWindow.AUTO_MAX);
      assert.strictEqual(plan.limited, true);
      assert.match(plan.reason, /trimmed/);
    });

    it('never asks for more than the model was trained on', () => {
      const plan = contextWindow.plan({ largestPromptTarget: 2000, modelMax: 4096 });
      assert.strictEqual(plan.numCtx, 4096);
      assert.strictEqual(plan.limited, true);
    });

    it('takes the setting over auto, within the floor and the model', () => {
      assert.strictEqual(contextWindow.plan({ largestPromptTarget: 2000, configured: 32768 }).numCtx, 32768);
      assert.strictEqual(contextWindow.plan({ largestPromptTarget: 2000, configured: 100 }).numCtx, contextWindow.MIN_WINDOW);
      assert.strictEqual(
        contextWindow.plan({ largestPromptTarget: 2000, configured: 65536, modelMax: 16384 }).numCtx,
        16384
      );
      assert.strictEqual(contextWindow.plan({ largestPromptTarget: 2000, configured: 32768 }).source, 'setting');
    });

    it('ignores a nonsense model maximum rather than sizing to it', () => {
      assert.strictEqual(contextWindow.plan({ largestPromptTarget: 2000, modelMax: -1 }).numCtx, 8192);
      assert.strictEqual(contextWindow.plan({ largestPromptTarget: 2000, modelMax: NaN }).numCtx, 8192);
    });
  });

  describe('fit', () => {
    it('shrinks a prompt target that does not fit, and leaves one that does', () => {
      const big = { promptTokenTarget: 12000, maxSteps: 15 };
      const fitted = contextWindow.fit(big, 16384);
      assert.strictEqual(fitted.promptTokenTarget, contextWindow.promptBudgetFor(16384));
      assert.strictEqual(fitted.maxSteps, 15);
      assert.strictEqual(big.promptTokenTarget, 12000, 'the shared budget table was mutated');

      const small = { promptTokenTarget: 1800 };
      assert.strictEqual(contextWindow.fit(small, 8192), small);
    });

    it('lets the output reserve give way on a small window rather than leave no prompt', () => {
      assert.ok(contextWindow.promptBudgetFor(4096) > 0);
      assert.strictEqual(contextWindow.promptBudgetFor(4096), 1024);
    });
  });

  it('formats token counts the way the panel shows them', () => {
    assert.strictEqual(contextWindow.formatTokens(8192), '8k');
    assert.strictEqual(contextWindow.formatTokens(1536), '1.5k');
    assert.strictEqual(contextWindow.formatTokens(950), '950');
  });

  describe('through modelCapability', () => {
    it('gives a Tier B model one window that covers every capacity', () => {
      const capability = classify({ name: 'llama3.2:1b', params: 1.2, supportsTools: true, contextLength: 131072 });
      assert.strictEqual(capability.tier, 'B');
      assert.strictEqual(capability.numCtx, 8192);
      for (const capacity of ['low', 'medium', 'high']) {
        // The same window at every capacity: a different one would make Ollama reload.
        assert.strictEqual(budgetsFor('B', capacity, capability.numCtx).numCtx, 8192);
        assert.strictEqual(
          budgetsFor('B', capacity, capability.numCtx).promptTokenTarget,
          BUDGETS.B[capacity].promptTokenTarget,
          'a Tier B budget that already fitted was trimmed'
        );
      }
    });

    it('trims a Tier A prompt target to the window it actually gets', () => {
      const capability = classify({ name: 'qwen3.5:4b', params: 4.7, supportsTools: true, contextLength: 262144 });
      assert.strictEqual(capability.tier, 'A');
      assert.strictEqual(capability.numCtx, contextWindow.AUTO_MAX);
      assert.ok(budgetsFor('A', 'high', capability.numCtx).promptTokenTarget < BUDGETS.A.high.promptTokenTarget);
    });

    it('honours the contextLength setting', () => {
      const capability = classify(
        { name: 'llama3.2:1b', params: 1.2, supportsTools: true, contextLength: 131072 },
        { contextLength: 4096 }
      );
      assert.strictEqual(capability.numCtx, 4096);
      assert.match(capability.windowReason, /settings/);
    });

    it('leaves budgets untouched when no window is given, as every older caller expects', () => {
      assert.strictEqual(budgetsFor('A', 'medium'), BUDGETS.A.medium);
    });
  });
});
