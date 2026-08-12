'use strict';

/**
 * These assertions are the acceptance criteria for Ask and Plan mode.
 *
 * The spec is specific that mutations must be *structurally* unavailable in those
 * modes — absent from what the model is offered, not blocked at the permission gate
 * afterwards. That distinction is only observable here, at the routing layer, which
 * is why these tests inspect the schema rather than the outcome.
 */

const assert = require('assert');

const promptRouter = require('../../app/core/promptRouter');
const toolRegistry = require('../../app/agent/toolRegistry');

const TIER_B = { tier: 'B', strategy: 'react', label: 'Lite', model: 'llama3.2:1b' };
const TIER_A = { tier: 'A', strategy: 'native', label: 'Agentic', model: 'qwen2.5-coder:7b' };

/**
 * @param {'agent'|'plan'|'ask'} mode
 * @param {object} capability
 */
function routeFor(mode, capability = TIER_B) {
  return promptRouter.route({ mode, capability, thinkingCapacity: 'medium', memory: '- earlier fact' });
}

const MUTATING = ['write_file', 'delete_file', 'run_script', 'run_tests'];

describe('promptRouter — Ask mode', () => {
  it('starts no loop at all', () => {
    const route = routeFor('ask');
    assert.strictEqual(route.strategy, 'none');
    assert.strictEqual(route.budgets.maxSteps, 0);
  });

  it('offers zero tools, on either tier', () => {
    for (const capability of [TIER_B, TIER_A]) {
      const route = routeFor('ask', capability);
      assert.deepStrictEqual(route.tools, []);
      assert.deepStrictEqual(route.ollamaTools, []);
      assert.strictEqual(route.allowedActions.size, 0);
    }
  });

  it('names no tool in its system prompt', () => {
    const route = routeFor('ask');
    for (const name of [...MUTATING, 'read_file', 'list_files', 'search_workspace']) {
      assert.ok(!route.systemPrompt.includes(name), `Ask prompt mentions ${name}`);
    }
  });

  it('tells the model it has no tools this turn', () => {
    assert.match(routeFor('ask').systemPrompt, /no tools this turn/i);
  });

  it('cannot mutate', () => {
    assert.strictEqual(promptRouter.canMutate(routeFor('ask')), false);
  });
});

describe('promptRouter — Plan mode', () => {
  it('offers only read-only tools', () => {
    const route = routeFor('plan');
    assert.deepStrictEqual(
      route.tools.map((tool) => tool.name).sort(),
      ['list_files', 'read_file', 'search_workspace']
    );
  });

  it('omits every mutating tool from the schema offered to a Tier A model', () => {
    // Not "present but refused" — absent from the function schemas entirely.
    const route = routeFor('plan', TIER_A);
    const offered = route.ollamaTools.map((tool) => tool.function.name);
    for (const name of MUTATING) {
      assert.ok(!offered.includes(name), `${name} was offered to the model in Plan mode`);
    }
    assert.deepStrictEqual(offered.sort(), ['list_files', 'read_file', 'search_workspace']);
  });

  it('omits every mutating action from the Tier B prompt and action set', () => {
    const route = routeFor('plan', TIER_B);
    for (const name of MUTATING) {
      assert.ok(!route.allowedActions.has(name), `${name} is in the allowed action set`);
      assert.ok(!route.systemPrompt.includes(name), `Plan prompt mentions ${name}`);
    }
  });

  it('still allows exploration', () => {
    const route = routeFor('plan');
    for (const name of ['read_file', 'list_files', 'search_workspace']) {
      assert.ok(route.allowedActions.has(name));
    }
  });

  it('tells the model to produce a plan rather than describe work as done', () => {
    const prompt = routeFor('plan').systemPrompt;
    assert.match(prompt, /PLAN MODE/);
    assert.match(prompt, /cannot change it/i);
  });

  it('cannot mutate', () => {
    assert.strictEqual(promptRouter.canMutate(routeFor('plan')), false);
    assert.strictEqual(promptRouter.canMutate(routeFor('plan', TIER_A)), false);
  });
});

describe('promptRouter — Agent mode', () => {
  it('offers the full tool set', () => {
    const route = routeFor('agent');
    assert.strictEqual(route.tools.length, toolRegistry.TOOLS.length);
    for (const name of MUTATING) assert.ok(route.allowedActions.has(name));
  });

  it('can mutate', () => {
    assert.strictEqual(promptRouter.canMutate(routeFor('agent')), true);
  });

  it('is fully agentic on a 1B model — the tier changes the mechanism, not the reach', () => {
    const lite = routeFor('agent', TIER_B);
    const agentic = routeFor('agent', TIER_A);
    assert.strictEqual(lite.strategy, 'react');
    assert.strictEqual(agentic.strategy, 'native');
    // Same tools, same reach; only how actions are produced differs.
    assert.deepStrictEqual(
      lite.tools.map((t) => t.name).sort(),
      agentic.tools.map((t) => t.name).sort()
    );
  });
});

describe('promptRouter — prompt assembly', () => {
  it('injects session memory into the Tier B prompt', () => {
    const route = promptRouter.route({
      mode: 'agent',
      capability: TIER_B,
      thinkingCapacity: 'medium',
      memory: '- Project uses Tailwind.',
    });
    assert.ok(route.systemPrompt.includes('Project uses Tailwind'));
    assert.ok(!route.systemPrompt.includes('{session_memory}'), 'placeholder left unreplaced');
  });

  it('injects session memory into the Tier A prompt', () => {
    // Regression: the Tier A prompt originally had no placeholder, so memory was
    // silently dropped for every native tool-calling model.
    const route = promptRouter.route({
      mode: 'agent',
      capability: TIER_A,
      thinkingCapacity: 'medium',
      memory: '- Project uses Tailwind.',
    });
    assert.ok(route.systemPrompt.includes('Project uses Tailwind'));
    assert.ok(!route.systemPrompt.includes('{memory}'), 'placeholder left unreplaced');
  });

  it('labels memory as background rather than instructions', () => {
    const route = routeFor('agent');
    assert.match(route.systemPrompt, /not new instructions|never grants/i);
  });

  it('lists only the offered actions in the Tier B prompt', () => {
    const route = routeFor('agent');
    assert.ok(!route.systemPrompt.includes('{actions}'), 'placeholder left unreplaced');
    assert.ok(route.systemPrompt.includes('read_file'));
  });

  it('scales the step budget with thinking capacity', () => {
    const low = promptRouter.route({ mode: 'agent', capability: TIER_A, thinkingCapacity: 'low' });
    const high = promptRouter.route({ mode: 'agent', capability: TIER_A, thinkingCapacity: 'high' });
    assert.ok(high.budgets.maxSteps > low.budgets.maxSteps);
  });
});

describe('toolRegistry mode filtering', () => {
  it('refuses to hand back a mutating tool outside Agent mode', () => {
    // The executor's guard: even if a loop bug produced the name, dispatch fails.
    assert.strictEqual(toolRegistry.get('write_file', 'plan'), null);
    assert.strictEqual(toolRegistry.get('delete_file', 'plan'), null);
    assert.strictEqual(toolRegistry.get('run_script', 'ask'), null);
    assert.strictEqual(toolRegistry.get('read_file', 'ask'), null);
  });

  it('hands back read-only tools in Plan mode', () => {
    assert.ok(toolRegistry.get('read_file', 'plan'));
  });

  it('hands back everything in Agent mode', () => {
    for (const tool of toolRegistry.TOOLS) {
      assert.ok(toolRegistry.get(tool.name, 'agent'), `${tool.name} unavailable in agent mode`);
    }
  });

  it('returns null for an unknown tool', () => {
    assert.strictEqual(toolRegistry.get('rm_rf', 'agent'), null);
  });
});
