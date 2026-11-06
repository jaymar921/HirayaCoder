'use strict';

/**
 * What 1.2.0 puts in front of the model that it did not have before: what the files it
 * changed now provide, a window that holds the prompt it was sent, and a Tier A history
 * that is shortened by the extension instead of cut by the server.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { FileHistory } = require('../../app/core/fileHistory');
const { createClient } = require('../../app/core/ollamaClient');
const { fitHistory, KEEP_RECENT_MESSAGES } = require('../../app/agent/nativeToolLoop');
const { CART_JS } = require('../../tools/lib/cartFixture');

describe('memory: what the changed files provide', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-shapes-')));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  it('names the functions and their arguments, read from disk now', async () => {
    fs.writeFileSync(path.join(root, 'src', 'cart.js'), CART_JS);
    const history = new FileHistory(root);
    await history.record({ path: 'src/cart.js', kind: 'create', before: null, after: CART_JS, sessionId: '1' });
    await history.flush();

    const block = await history.renderForPrompt('1');
    assert.match(block, /created src\/cart\.js \(\d+ lines\)\. It provides: createCart\(\), addItem\(cart, product, quantity = 1\)/);
    assert.match(block, /exact names and arguments/);
  });

  it('reports the file as it is now, not as it was written', async () => {
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'function one() {}\nmodule.exports = { one };\n');
    const history = new FileHistory(root);
    await history.record({ path: 'src/a.js', kind: 'create', before: null, after: 'x', sessionId: '1' });
    await history.flush();
    // Edited by hand afterwards.
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'function two(b) {}\nmodule.exports = { two };\n');

    const block = await history.renderForPrompt('1');
    assert.match(block, /two\(b\)/);
    assert.doesNotMatch(block, /one\(\)/);
  });

  it('lists a file edited several times once', async () => {
    fs.writeFileSync(path.join(root, 'src', 'a.js'), 'module.exports = {};\n');
    const history = new FileHistory(root);
    for (let i = 0; i < 3; i += 1) {
      await history.record({ path: 'src/a.js', kind: 'edit', before: `${i}\n`, after: `${i + 1}\n`, sessionId: '1' });
    }
    await history.flush();
    const block = await history.renderForPrompt('1');
    assert.strictEqual(block.match(/src\/a\.js/g).length, 1);
  });

  it('keeps the plain line for a file that is gone or unreadable', async () => {
    const history = new FileHistory(root);
    await history.record({ path: 'src/gone.js', kind: 'create', before: null, after: 'x', sessionId: '1' });
    await history.flush();
    const block = await history.renderForPrompt('1');
    assert.match(block, /- created src\/gone\.js \(1 lines\)$/m);
  });

  it('does not read through a path that leaves the workspace', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-outside-')));
    fs.writeFileSync(path.join(outside, 'secret.js'), 'function leaked(token) {}\nmodule.exports = { leaked };\n');
    const history = new FileHistory(root);
    // A recorded path cannot normally point outside, which is exactly why this is checked
    // again: the history file is plain JSONL on disk and anyone can edit it.
    await history.record({ path: path.relative(root, path.join(outside, 'secret.js')), kind: 'edit', before: 'a', after: 'b', sessionId: '1' });
    await history.flush();
    const block = await history.renderForPrompt('1');
    assert.doesNotMatch(block, /leaked/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('redacts a credential that happens to sit in a signature default', async () => {
    fs.writeFileSync(
      path.join(root, 'src', 'api.js'),
      "function connect(key = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') {}\nmodule.exports = { connect };\n"
    );
    const history = new FileHistory(root);
    await history.record({ path: 'src/api.js', kind: 'create', before: null, after: 'x', sessionId: '1' });
    await history.flush();
    const block = await history.renderForPrompt('1');
    assert.match(block, /connect\(/);
    assert.doesNotMatch(block, /AAAAAAAAAAAAAAAAAAAA/);
  });
});

describe('ollamaClient: one context window per model', () => {
  /** @type {http.Server} */
  let server;
  /** @type {string} */
  let endpoint;
  /** @type {object[]} */
  let bodies;
  /** @type {object} */
  let reply;

  before((done) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        bodies.push(JSON.parse(raw));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(reply));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  after((done) => server.close(done));

  beforeEach(() => {
    bodies = [];
    reply = { message: { content: 'ok' }, done: true, prompt_eval_count: 1000, prompt_eval_cached_count: 990, eval_count: 50 };
  });

  it('stamps the window on every request for that model, and only that model', async () => {
    const client = createClient({ endpoint });
    client.setContextWindow('llama3.2:1b', 8192);
    await client.chat({ model: 'llama3.2:1b', messages: [], options: { temperature: 0 } });
    await client.generate({ model: 'llama3.2:1b', prompt: 'x' });
    await client.chat({ model: 'minicpm-v4.6', messages: [] });

    assert.strictEqual(bodies[0].options.num_ctx, 8192);
    assert.strictEqual(bodies[0].options.temperature, 0, 'the caller options were dropped');
    assert.strictEqual(bodies[1].options.num_ctx, 8192);
    assert.ok(!bodies[2].options || bodies[2].options.num_ctx === undefined, 'a different model was given the window');
  });

  it('leaves a caller that names its own window alone', async () => {
    const client = createClient({ endpoint });
    client.setContextWindow('m', 8192);
    await client.chat({ model: 'm', messages: [], options: { num_ctx: 2048 } });
    assert.strictEqual(bodies[0].options.num_ctx, 2048);
  });

  it('reads the cached count as a share of the prompt, not an addition to it', async () => {
    // Measured on Ollama 0.40: a 167-token prompt reported 167 evaluated and 166 cached.
    const client = createClient({ endpoint });
    client.setContextWindow('m', 8192);
    await client.chat({ model: 'm', messages: [] });
    assert.strictEqual(client.usage.peakPromptTokens, 1000);
    assert.strictEqual(client.usage.numCtx, 8192);
    assert.strictEqual(client.usage.filled, 0);
  });

  it('notices a request that filled its window', async () => {
    const client = createClient({ endpoint });
    client.setContextWindow('m', 4096);
    reply = { message: { content: '' }, done: true, done_reason: 'length', prompt_eval_count: 2050, eval_count: 2046 };
    await client.chat({ model: 'm', messages: [] });
    assert.strictEqual(client.usage.filled, 1);
    client.resetUsage();
    assert.strictEqual(client.usage.requests, 0);
  });
});

describe('nativeToolLoop.fitHistory', () => {
  const big = (n) => 'x'.repeat(n);
  const conversation = () => [
    { role: 'system', content: 'rules' },
    { role: 'user', content: `TASK ${big(400)}` },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'a.js', code: big(20000) } } }] },
    { role: 'tool', name: 'write_file', content: `Created a.js\n${big(20000)}` },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'b.js' } } }] },
    { role: 'tool', name: 'read_file', content: `b.js (300 lines):\n${big(20000)}` },
    { role: 'assistant', content: 'latest', tool_calls: [] },
    { role: 'tool', name: 'read_file', content: `latest result ${big(2000)}` },
    { role: 'user', content: 'held' },
    { role: 'user', content: 'now' },
  ];

  it('does nothing to a conversation that fits', () => {
    const messages = conversation().slice(0, 2);
    assert.strictEqual(fitHistory(messages, 8192), 0);
  });

  it('shortens old tool output and old file bodies, never the task or the latest turn', () => {
    const messages = conversation();
    const before = JSON.parse(JSON.stringify(messages));
    const trimmed = fitHistory(messages, 8192);

    assert.ok(trimmed > 0);
    assert.deepStrictEqual(messages[0], before[0]);
    assert.deepStrictEqual(messages[1], before[1], 'the task was touched');
    for (let i = messages.length - KEEP_RECENT_MESSAGES; i < messages.length; i += 1) {
      assert.deepStrictEqual(messages[i], before[i], `recent message ${i} was touched`);
    }
    assert.strictEqual(messages[2].tool_calls[0].function.arguments.path, 'a.js', 'the call lost its path');
    assert.match(messages[2].tool_calls[0].function.arguments.code, /now on disk/);
    assert.match(messages[3].content, /^Created a\.js \[rest trimmed/);
    assert.strictEqual(messages.length, before.length, 'a message was removed, breaking the call/result pairing');
  });

  it('does nothing without a window', () => {
    assert.strictEqual(fitHistory(conversation(), null), 0);
  });
});
