'use strict';

/**
 * Tier A's "the model is answering, so it is finished" rule, and the one case where
 * that inference is wrong.
 */

const assert = require('assert');

const nativeToolLoop = require('../../app/agent/nativeToolLoop');
const { looksLikeNarratedToolCall, NARRATED_CALL_LIMIT } = nativeToolLoop;

const ROUTE = {
  systemPrompt: 'You are a coding agent.',
  budgets: { maxSteps: 6 },
  tools: [],
};

/** Mock Ollama replaying scripted assistant messages in order. */
function scriptedClient(replies) {
  return {
    calls: 0,
    bodies: /** @type {any[]} */ ([]),
    async chat(body) {
      this.bodies.push(body);
      const reply = replies[Math.min(this.calls, replies.length - 1)];
      this.calls += 1;
      return { message: reply };
    },
  };
}

describe('nativeToolLoop.looksLikeNarratedToolCall', () => {
  it('recognises the reply that ended a session claiming success', () => {
    // llama3.2:latest, verbatim: reported `done` with this as its whole summary,
    // having changed nothing. `edit_file` is not one of this project's tools.
    const observed =
      '{"name": "edit_file", "parameters": {"file": "src/greet.js", "new_content": "function greet() {}"}}';
    assert.strictEqual(looksLikeNarratedToolCall(observed), true);
  });

  it('recognises the OpenAI and Tier B shapes too', () => {
    assert.strictEqual(looksLikeNarratedToolCall('{"function": {"name": "write_file"}}'), true);
    assert.strictEqual(looksLikeNarratedToolCall('{"action": "write_file", "path": "a.js"}'), true);
    assert.strictEqual(looksLikeNarratedToolCall('{"name": "read_file", "arguments": {"path": "a.js"}}'), true);
  });

  it('sees through a code fence', () => {
    assert.strictEqual(
      looksLikeNarratedToolCall('```json\n{"name": "write_file", "parameters": {"path": "a.js"}}\n```'),
      true
    );
  });

  it('does not flag an ordinary answer', () => {
    assert.strictEqual(looksLikeNarratedToolCall('I updated src/greet.js to handle an empty name.'), false);
    assert.strictEqual(looksLikeNarratedToolCall(''), false);
    assert.strictEqual(looksLikeNarratedToolCall('The config is {"a": 1} in JSON.'), false);
  });

  it('does not flag a summary that merely happens to be JSON', () => {
    // A real answer about data, not an attempt to call anything.
    assert.strictEqual(looksLikeNarratedToolCall('{"files": 3, "status": "updated"}'), false);
  });
});

describe('nativeToolLoop run', () => {
  const noop = async () => ({ ok: true, observation: 'ok' });

  it('corrects a typed-out tool call instead of reporting success', async () => {
    const client = scriptedClient([
      { content: '{"name": "edit_file", "parameters": {"file": "src/greet.js", "new_content": "x"}}' },
      { content: 'I updated src/greet.js.' },
    ]);

    const result = await nativeToolLoop.run({
      client,
      model: 'llama3.2:latest',
      route: ROUTE,
      task: 'Update greet',
      context: 'ctx',
      execute: noop,
    });

    assert.strictEqual(result.stopReason, 'done');
    assert.strictEqual(result.summary, 'I updated src/greet.js.');

    // The model was told what it did wrong, rather than being taken at its word.
    const correction = client.bodies[1].messages.find(
      (m) => m.role === 'user' && /tool call written as text/.test(String(m.content))
    );
    assert.ok(correction, 'the model was not corrected');
  });

  it('gives up honestly when the model only ever narrates', async () => {
    const client = scriptedClient([{ content: '{"name": "edit_file", "parameters": {"file": "a.js"}}' }]);

    const result = await nativeToolLoop.run({
      client,
      model: 'llama3.2:latest',
      route: ROUTE,
      task: 'Update greet',
      context: 'ctx',
      execute: noop,
    });

    assert.strictEqual(result.stopReason, 'narrated-tool-calls');
    assert.match(result.summary, /nothing was actually changed/);
    assert.strictEqual(client.calls, NARRATED_CALL_LIMIT + 1);
    // The user must not be handed raw JSON as the account of their task.
    assert.doesNotMatch(result.summary, /edit_file/);
  });

  it('still treats a plain answer as the end of the session', async () => {
    const client = scriptedClient([{ content: 'src/greet.js already handles an empty name.' }]);

    const result = await nativeToolLoop.run({
      client,
      model: 'gemma4:e2b',
      route: ROUTE,
      task: 'Check greet',
      context: 'ctx',
      execute: noop,
    });

    assert.strictEqual(result.stopReason, 'done');
    assert.strictEqual(client.calls, 1);
  });
});
