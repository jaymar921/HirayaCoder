'use strict';

/**
 * A message that asks to be told something must not be able to reach a tool that runs
 * a command.
 *
 * The session behind this: "can you read the README.md file?" → "proceed" → the agent
 * ran `start_development_windows.bat` (refused by the program allowlist) and then
 * `node api/server.js` (allowed, because `node` has to be), which bound a port, failed
 * to reach MongoDB, and hung the session until the step budget ran out.
 */

const assert = require('assert');

const intentRouter = require('../../app/core/intentRouter');
const promptRouter = require('../../app/core/promptRouter');

const TIER_A = { tier: 'A', strategy: 'native', label: 'Agentic', model: 'qwen2.5-coder:7b' };
const TIER_B = { tier: 'B', strategy: 'react', label: 'Lite', model: 'llama3.2:1b' };

describe('intentRouter.isReadOnlyRequest', () => {
  const readOnly = [
    'can you read the README.md file?',
    'review the README.md',
    'what is this project all about?',
    'explain the auth flow',
    'describe the folder structure',
    'summarize what this module does',
    "Hi, may I know what's the project all about? I need to understand what is the structure of this project.",
  ];

  for (const message of readOnly) {
    it(`treats "${message.slice(0, 44)}" as read-only`, () => {
      assert.strictEqual(intentRouter.isReadOnlyRequest(message), true);
    });
  }

  const notReadOnly = [
    'add a login route',
    'explain the auth flow then fix the bug in app.js',
    'run the tests and explain the failures',
    'start the dev server',
    'read the config then update the port',
    'compile it and tell me what breaks',
  ];

  for (const message of notReadOnly) {
    it(`leaves "${message.slice(0, 44)}" alone`, () => {
      assert.strictEqual(intentRouter.isReadOnlyRequest(message), false);
    });
  }

  it('lets a bare "proceed" inherit the restriction of what it agrees to', () => {
    const conversation = [
      { role: 'user', text: 'can you read the README.md file?' },
      { role: 'assistant', text: 'I can read the following files: README.md, api/server.js…' },
    ];
    assert.strictEqual(intentRouter.isReadOnlyRequest('proceed', conversation), true);
  });

  it('does not let assent inherit a restriction that was never there', () => {
    const conversation = [
      { role: 'user', text: 'add a login route' },
      { role: 'assistant', text: 'I will add src/routes/auth.js.' },
    ];
    assert.strictEqual(intentRouter.isReadOnlyRequest('proceed', conversation), false);
  });

  it('treats assent with no history as ordinary work', () => {
    assert.strictEqual(intentRouter.isReadOnlyRequest('proceed', []), false);
    assert.strictEqual(intentRouter.isReadOnlyRequest('proceed'), false);
  });

  it('says nothing about an empty message', () => {
    assert.strictEqual(intentRouter.isReadOnlyRequest(''), false);
    assert.strictEqual(intentRouter.isReadOnlyRequest(undefined), false);
  });
});

describe('promptRouter — a read-only Agent turn', () => {
  /**
   * @param {object} capability
   * @param {boolean} readOnlyTurn
   */
  function routeFor(capability, readOnlyTurn) {
    return promptRouter.route({
      mode: 'agent',
      capability,
      thinkingCapacity: 'medium',
      memory: '- a fact',
      intent: 'task',
      readOnlyTurn,
    });
  }

  const MUTATING = ['write_file', 'delete_file', 'delete_folder', 'create_folder', 'run_script', 'run_tests'];

  for (const capability of [TIER_A, TIER_B]) {
    it(`offers no mutating tool on ${capability.label}`, () => {
      const route = routeFor(capability, true);
      for (const name of MUTATING) {
        assert.ok(
          !route.tools.some((tool) => tool.name === name),
          `${name} was still offered on ${capability.label}`
        );
        assert.ok(!route.allowedActions.has(name), `${name} was still an allowed action on ${capability.label}`);
      }
    });

    it(`still offers the reading tools on ${capability.label}`, () => {
      const route = routeFor(capability, true);
      for (const name of ['read_file', 'list_files', 'search_workspace']) {
        assert.ok(route.tools.some((tool) => tool.name === name), `${name} was missing`);
      }
    });
  }

  it('keeps the native schemas in step with the tool list', () => {
    // The Tier A model is offered `ollamaTools`, not `tools`. A filter applied to one
    // and not the other would be a hole exactly where it is least visible.
    const route = routeFor(TIER_A, true);
    const names = route.ollamaTools.map((entry) => entry.function.name);
    assert.ok(!names.includes('run_script'));
    assert.ok(!names.includes('write_file'));
    assert.ok(names.includes('read_file'));
  });

  it('does not list a mutating action in the Tier B prompt', () => {
    const route = routeFor(TIER_B, true);
    assert.doesNotMatch(route.systemPrompt, /"run_script"/);
    assert.doesNotMatch(route.systemPrompt, /"write_file"/);
    assert.match(route.systemPrompt, /"read_file"/);
  });

  it('tells the model not to boot the project to find out what it is', () => {
    assert.match(routeFor(TIER_A, true).systemPrompt, /do not run the project/i);
  });

  it('reports the restriction separately from Plan mode', () => {
    const restricted = routeFor(TIER_A, true);
    assert.strictEqual(restricted.readOnly, true);
    assert.strictEqual(restricted.readOnlyTurn, true);
    // The user is still in Agent mode and their next message gets everything back.
    assert.strictEqual(restricted.mode, 'agent');
  });

  it('gives the full toolset back when the message is not read-only', () => {
    const route = routeFor(TIER_A, false);
    assert.ok(route.tools.some((tool) => tool.name === 'write_file'));
    assert.ok(route.tools.some((tool) => tool.name === 'run_script'));
    assert.strictEqual(route.readOnlyTurn, false);
    assert.strictEqual(route.readOnly, false);
  });

  it('ignores the flag outside Agent mode', () => {
    // Plan has already dropped the mutating tools and Ask never had any; a second
    // mechanism claiming credit for that would make the modes harder to reason about.
    for (const mode of /** @type {const} */ (['plan', 'ask'])) {
      const route = promptRouter.route({
        mode,
        capability: TIER_A,
        thinkingCapacity: 'medium',
        readOnlyTurn: true,
      });
      assert.strictEqual(route.readOnlyTurn, false, `${mode} claimed a read-only turn`);
    }
  });
});

describe('promptRouter — the assistant knows what it is', () => {
  const productInfo = require('../../app/utils/productInfo');

  it('puts the name and version into every mode', () => {
    for (const mode of /** @type {const} */ (['agent', 'plan', 'ask'])) {
      for (const capability of [TIER_A, TIER_B]) {
        const route = promptRouter.route({ mode, capability, thinkingCapacity: 'medium', memory: '-' });
        assert.match(
          route.systemPrompt,
          new RegExp(`version ${productInfo.VERSION.replace(/\./g, '\\.')}`),
          `${mode}/${capability.label} carried no version`
        );
      }
    }
  });

  it('reaches the conversational route too', () => {
    const route = promptRouter.route({
      mode: 'agent',
      capability: TIER_A,
      thinkingCapacity: 'medium',
      intent: 'chat',
    });
    assert.strictEqual(route.strategy, 'chat');
    assert.match(route.systemPrompt, /version/);
  });

  it('leaves no placeholder behind', () => {
    for (const mode of /** @type {const} */ (['agent', 'plan', 'ask'])) {
      const route = promptRouter.route({ mode, capability: TIER_A, thinkingCapacity: 'medium', memory: '-' });
      assert.doesNotMatch(route.systemPrompt, /\{identity\}/);
    }
  });

  it('separates its own version from the open project one', () => {
    // The observed failure was answering "what version are you?" with the version field
    // out of the workspace's package.json.
    assert.match(productInfo.identityLine(), /nothing to do with the version of whatever project/i);
  });

  it('reports a version rather than throwing when package.json is unreadable', () => {
    assert.ok(typeof productInfo.readVersion() === 'string');
    assert.ok(productInfo.readVersion().length > 0);
  });
});
