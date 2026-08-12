'use strict';

/**
 * Tier A's "the model is answering, so it is finished" rule, and the one case where
 * that inference is wrong.
 */

const assert = require('assert');

const nativeToolLoop = require('../../app/agent/nativeToolLoop');
const { looksLikeNarratedToolCall, missingRequired, NARRATED_CALL_LIMIT } = nativeToolLoop;

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

describe('nativeToolLoop required arguments', () => {
  const toolCall = (name, args) => ({
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name, arguments: args } }],
  });

  it('names the fields a call arrived without', () => {
    assert.deepStrictEqual(missingRequired('write_file', { code: 'x' }), ['path']);
    assert.deepStrictEqual(missingRequired('write_file', { path: 'a.js' }), ['code']);
    assert.deepStrictEqual(missingRequired('write_file', {}), ['path', 'code']);
    assert.deepStrictEqual(missingRequired('write_file', { path: 'a.js', code: 'x' }), []);
  });

  it('treats an empty string as missing', () => {
    // `"code": ""` is a write with no content. Letting it through produces a confusing
    // truncation refusal instead of a plain answer about the missing field.
    assert.deepStrictEqual(missingRequired('write_file', { path: 'a.js', code: '   ' }), ['code']);
  });

  it('asks nothing of a tool that requires nothing', () => {
    assert.deepStrictEqual(missingRequired('list_files', {}), []);
  });

  it('refuses the call and says which field was missing, without running the tool', async () => {
    // Observed on `gemma4:e4b`: five identical write_file calls with no path, each
    // answered only with "The write to undefined was not applied: A file path is
    // required." The model concluded there was "a technical issue with the tool
    // execution environment" and reported the file as written. Nothing had ever told it
    // which field it had left out.
    const client = scriptedClient([
      toolCall('write_file', { code: '<html></html>' }),
      { role: 'assistant', content: 'I see — I left the path out.' },
    ]);

    /** @type {string[]} */
    const executed = [];
    const outcome = await nativeToolLoop.run({
      client,
      model: 'gemma4:e4b',
      route: ROUTE,
      task: 'write the page',
      context: 'Task: write the page',
      execute: async (action) => {
        executed.push(action.action);
        return { ok: true, observation: 'wrote it' };
      },
    });

    assert.deepStrictEqual(executed, [], 'a call with no path reached the tool');
    assert.strictEqual(outcome.steps.length, 0);

    // Read off the message itself rather than a JSON dump of the conversation, where
    // the quotes around the field name come back escaped and never match.
    const correction = client.bodies[1].messages.find((m) => m.role === 'tool');
    assert.ok(correction, 'the model was told nothing about the failed call');
    assert.match(correction.content, /had no "path"/);
    assert.match(correction.content, /workspace-relative file path/);
  });

  it('lets a corrected call through on the next turn', async () => {
    const client = scriptedClient([
      toolCall('write_file', { code: 'x' }),
      toolCall('write_file', { path: 'index.html', code: '<html></html>' }),
      { role: 'assistant', content: 'Created index.html.' },
    ]);

    /** @type {string[]} */
    const written = [];
    const outcome = await nativeToolLoop.run({
      client,
      model: 'm',
      route: ROUTE,
      task: 'write the page',
      context: 'Task: write the page',
      execute: async (action) => {
        written.push(action.path);
        return { ok: true, observation: 'wrote it' };
      },
    });

    assert.deepStrictEqual(written, ['index.html']);
    assert.strictEqual(outcome.stopReason, 'done');
  });
});
