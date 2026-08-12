'use strict';

/**
 * Fixture tests for two acceptance criteria that cannot be checked by unit-testing
 * any single module, because they are properties of the memory *loop*:
 *
 *  1. "A second request in the same chat tab correctly recalls prior session memory
 *     (e.g. mentions a feature added two turns earlier) without the user
 *     re-explaining it."
 *  2. "Attaching a context file via + measurably changes the agent's proposed
 *     direction."
 *
 * Both run against a scripted mock Ollama, so they are deterministic and need no
 * model. The real-model equivalent is the manual smoke test.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MemoryStore } = require('../../app/core/memoryStore');
const { ContextTranslator } = require('../../app/core/contextTranslator');
const { ContextFilesManager } = require('../../app/core/contextFilesManager');
const contextBuilder = require('../../app/core/contextBuilder');
const { budgetsFor } = require('../../app/core/modelCapability');

/**
 * Mock Ollama replaying a scripted conversation and recording every prompt.
 *
 * @param {string[]} replies
 */
function scriptedClient(replies) {
  let index = 0;
  return {
    prompts: /** @type {string[]} */ ([]),
    async chat(body) {
      this.prompts.push(body.messages[body.messages.length - 1].content);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return { message: { content: reply } };
    },
  };
}

describe('multi-turn session memory recall', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-recall-')));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('recalls a feature added two turns earlier, without the user restating it', async () => {
    const memory = new MemoryStore(root, 1);
    const budgets = budgetsFor('B', 'medium');

    // The translator's scripted replies, one per turn.
    const translator = new ContextTranslator({
      client: /** @type {any} */ (
        scriptedClient([
          '- Added email validation to the signup form in src/signup.js.',
          '- Fixed the N+1 query in userController.js using populate batching.',
          'NONE',
        ])
      ),
      memoryStore: memory,
      model: 'llama3.2:1b',
    });

    // --- Turn 1: user asks for email validation ---
    await translator.translate({
      action: 'write_file',
      path: 'src/signup.js',
      result: 'wrote 42 lines',
      ok: true,
    });

    // --- Turn 2: an unrelated bug fix ---
    await translator.translate({
      action: 'write_file',
      path: 'src/userController.js',
      result: 'wrote 88 lines',
      ok: true,
    });

    // --- Turn 3: the user says something that only makes sense with memory ---
    const recalled = await memory.readRecent(budgets.memoryRecallEntries);
    const prompt = contextBuilder.build({
      task: 'Add the same kind of validation to the login form',
      budget: budgets.promptTokenTarget,
      memory: recalled,
      editor: { path: 'src/login.js', content: 'export function Login() {}' },
    });

    // The model is never told again what "the same kind of validation" means —
    // it is in the prompt only because the memory loop put it there.
    assert.ok(
      prompt.text.includes('email validation'),
      'the feature added two turns ago is absent from turn 3'
    );
    assert.ok(prompt.text.includes('src/signup.js'), 'the file it was added to is absent');
    assert.strictEqual(prompt.included['Session Memory'], true);
  });

  it('carries memory across a closed and reopened tab', async () => {
    const first = new MemoryStore(root, 1);
    await first.append('Project uses Tailwind; do not add another CSS framework.');
    await first.flush();

    // A new process, a new store instance — the same session file.
    const reopened = new MemoryStore(root, 1);
    const prompt = contextBuilder.build({
      task: 'Style the new button',
      budget: 1800,
      memory: await reopened.readRecent(5),
    });

    assert.ok(prompt.text.includes('Tailwind'));
  });

  it('respects the recall depth set by thinking capacity', async () => {
    const memory = new MemoryStore(root, 1);
    for (let i = 1; i <= 10; i += 1) await memory.append(`Fact number ${i}.`);

    const low = await memory.readRecent(budgetsFor('B', 'low').memoryRecallEntries);
    const medium = await memory.readRecent(budgetsFor('B', 'medium').memoryRecallEntries);
    const high = await memory.readRecent(budgetsFor('B', 'high').memoryRecallEntries);

    assert.strictEqual(low.length, 1, 'Low recalls a single entry');
    assert.strictEqual(medium.length, 5);
    assert.strictEqual(high.length, 10, 'High recalls everything within budget');

    // Whatever the depth, it is always the most recent work that survives.
    assert.ok(low[0].includes('Fact number 10'));
  });

  it('does not let memory crowd the task out of a small budget', async () => {
    const memory = new MemoryStore(root, 1);
    for (let i = 1; i <= 200; i += 1) {
      await memory.append(`Fact number ${i} about some part of this project that was changed.`);
    }

    const prompt = contextBuilder.build({
      task: 'Add a logout button',
      budget: budgetsFor('B', 'medium').promptTokenTarget,
      memory: await memory.readRecent(Infinity),
    });

    assert.ok(prompt.text.includes('Add a logout button'), 'the task itself was squeezed out');
    assert.ok(prompt.tokens <= 1900);
  });
});

describe('attached context files change the agent direction', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-ctxfile-')));
    fs.writeFileSync(path.join(root, 'app.js'), 'export function makeButton() {}');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it('is actually read into the prompt, not merely stored', async () => {
    const task = 'Add a submit button to the form';
    const editor = { path: 'app.js', content: 'export function makeButton() {}' };

    const before = contextBuilder.build({ task, budget: 4000, editor });
    assert.ok(!before.text.includes('styled-components'), 'baseline should not mention the convention');

    const manager = new ContextFilesManager(root);
    fs.writeFileSync(
      path.join(root, 'CONVENTIONS.md'),
      '# Conventions\nAll buttons must use styled-components, never inline styles.'
    );
    const added = await manager.add('CONVENTIONS.md');
    assert.strictEqual(added.ok, true);

    const after = contextBuilder.build({
      task,
      budget: 4000,
      editor,
      contextFiles: manager.renderForPrompt(),
    });

    // The measurable difference: the convention is now in front of the model.
    assert.ok(after.text.includes('styled-components'), 'attached file did not reach the prompt');
    assert.ok(after.text.includes('CONVENTIONS.md'), 'source file is not identified');
    assert.ok(after.tokens > before.tokens);
  });

  it('stops influencing the prompt once detached', async () => {
    const manager = new ContextFilesManager(root);
    fs.writeFileSync(path.join(root, 'CONVENTIONS.md'), 'Use styled-components.');
    await manager.add('CONVENTIONS.md');
    await manager.remove('CONVENTIONS.md');

    const prompt = contextBuilder.build({
      task: 'Add a button',
      budget: 4000,
      contextFiles: manager.renderForPrompt(),
    });
    assert.ok(!prompt.text.includes('styled-components'));
  });

  it('reflects an edit to the attached file on the next turn', async () => {
    const manager = new ContextFilesManager(root);
    fs.writeFileSync(path.join(root, 'CONVENTIONS.md'), 'Use styled-components.');
    await manager.add('CONVENTIONS.md');

    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(root, 'CONVENTIONS.md'), 'Use Tailwind utility classes.');
    await manager.refresh();

    const prompt = contextBuilder.build({
      task: 'Add a button',
      budget: 4000,
      contextFiles: manager.renderForPrompt(),
    });
    assert.ok(prompt.text.includes('Tailwind utility classes'));
    assert.ok(!prompt.text.includes('styled-components'));
  });
});
