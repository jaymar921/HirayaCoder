'use strict';

const assert = require('assert');
const http = require('http');

const {
  assertLoopbackEndpoint,
  createClient,
  OllamaUnreachableError,
  OllamaResponseError,
} = require('../../app/core/ollamaClient');

describe('ollamaClient.assertLoopbackEndpoint', () => {
  it('accepts the loopback forms a user might reasonably type', () => {
    for (const endpoint of [
      'http://127.0.0.1:11434',
      'http://localhost:11434',
      'http://LOCALHOST:11434',
      'http://[::1]:11434',
      'http://127.0.0.53:11434',
      'https://127.0.0.1:11434',
    ]) {
      assert.doesNotThrow(() => assertLoopbackEndpoint(endpoint), endpoint);
    }
  });

  it('refuses any non-loopback host', () => {
    // This is the enforcement point for "no data leaves the machine" — it is a code
    // check, not a documented convention, so no setting can defeat it.
    for (const endpoint of [
      'http://192.168.1.10:11434',
      'http://10.0.0.5:11434',
      'http://ollama.example.com:11434',
      'https://api.openai.com',
      'http://169.254.169.254',
      'http://0.0.0.0:11434',
    ]) {
      assert.throws(() => assertLoopbackEndpoint(endpoint), /refuses to connect/i, endpoint);
    }
  });

  it('refuses non-HTTP protocols', () => {
    assert.throws(() => assertLoopbackEndpoint('file:///etc/passwd'), /unsupported protocol/i);
    assert.throws(() => assertLoopbackEndpoint('ftp://127.0.0.1'), /unsupported protocol/i);
  });

  it('rejects malformed input', () => {
    assert.throws(() => assertLoopbackEndpoint('not a url'), /not a valid URL/i);
    assert.throws(() => assertLoopbackEndpoint(''), /not a valid URL/i);
  });

  it('rejects a non-loopback host smuggled in via credentials', () => {
    // `new URL()` parses the host after '@', so this must not read as localhost.
    assert.throws(() => assertLoopbackEndpoint('http://127.0.0.1@evil.example.com/'), /refuses to connect/i);
  });
});

describe('OllamaClient construction', () => {
  it('validates eagerly so a bad setting fails before any request', () => {
    assert.throws(() => createClient({ endpoint: 'http://example.com' }), /refuses to connect/i);
  });

  it('rejects a bad endpoint on reconfigure and keeps the old one', () => {
    const client = createClient({ endpoint: 'http://127.0.0.1:11434' });
    assert.throws(() => client.reconfigure({ endpoint: 'http://evil.example.com' }));
    assert.strictEqual(client.endpoint, 'http://127.0.0.1:11434');
  });
});

describe('OllamaClient against a local stub server', () => {
  /** @type {http.Server} */
  let server;
  /** @type {string} */
  let endpoint;
  /** @type {(req: http.IncomingMessage, res: http.ServerResponse) => void} */
  let handler;

  before((done) => {
    server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => {
      endpoint = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  after((done) => server.close(done));

  it('parses /api/tags', async () => {
    handler = (req, res) => {
      assert.strictEqual(req.url, '/api/tags');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'llama3.2:1b' }] }));
    };
    const models = await createClient({ endpoint }).tags();
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0].name, 'llama3.2:1b');
  });

  it('returns an empty array when the response has no models key', async () => {
    handler = (_req, res) => res.end('{}');
    assert.deepStrictEqual(await createClient({ endpoint }).tags(), []);
  });

  it('surfaces the error message from a non-2xx response', async () => {
    handler = (_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'model "ghost" not found' }));
    };
    await assert.rejects(
      () => createClient({ endpoint }).show('ghost'),
      (err) => err instanceof OllamaResponseError && /model "ghost" not found/.test(err.message)
    );
  });

  it('rejects on malformed JSON rather than returning a partial object', async () => {
    handler = (_req, res) => res.end('{"models": [');
    await assert.rejects(() => createClient({ endpoint }).tags(), /malformed JSON/i);
  });

  it('assembles NDJSON stream frames split across packets', async () => {
    handler = (_req, res) => {
      res.write('{"message":{"content":"Hel');
      res.write('lo"}}\n{"message":{"content":" world"},"done":true}\n');
      res.end();
    };
    const chunks = [];
    await createClient({ endpoint }).chatStream(
      { model: 'llama3.2:1b', messages: [] },
      (chunk) => chunks.push(chunk.message.content)
    );
    assert.deepStrictEqual(chunks, ['Hello', ' world']);
  });

  it('handles a final frame with no trailing newline', async () => {
    handler = (_req, res) => res.end('{"message":{"content":"only"},"done":true}');
    const chunks = [];
    await createClient({ endpoint }).chatStream({ model: 'm', messages: [] }, (c) => chunks.push(c));
    assert.strictEqual(chunks.length, 1);
  });

  it('reports an unreachable server distinctly from an error response', async () => {
    const client = createClient({ endpoint: 'http://127.0.0.1:1' });
    await assert.rejects(
      () => client.tags(),
      (err) => err instanceof OllamaUnreachableError && /Is it running\?/.test(err.message)
    );
  });

  it('ping reports unreachable without throwing', async () => {
    const result = await createClient({ endpoint: 'http://127.0.0.1:1' }).ping();
    assert.strictEqual(result.reachable, false);
    assert.ok(result.error);
  });

  it('ping reports the version when reachable', async () => {
    handler = (_req, res) => res.end(JSON.stringify({ version: '0.32.7' }));
    const result = await createClient({ endpoint }).ping();
    assert.deepStrictEqual(result, { reachable: true, version: '0.32.7' });
  });

  it('times out a hung request instead of hanging the agent loop', async () => {
    handler = () => {
      /* never respond */
    };
    await assert.rejects(
      () => createClient({ endpoint, timeoutMs: 150 }).chat({ model: 'm', messages: [] }),
      /timed out after 150ms/
    );
  });

  it('honors an abort signal', async () => {
    handler = () => {};
    const controller = new AbortController();
    const promise = createClient({ endpoint }).chat({ model: 'm', messages: [] }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(() => promise, /aborted/i);
  });

  it('forces stream:false on the buffered chat path', async () => {
    let received = null;
    handler = (req, res) => {
      const body = [];
      req.on('data', (c) => body.push(c));
      req.on('end', () => {
        received = JSON.parse(Buffer.concat(body).toString('utf8'));
        res.end('{}');
      });
    };
    await createClient({ endpoint }).chat({ model: 'm', messages: [], stream: true });
    assert.strictEqual(received.stream, false);
  });
});
