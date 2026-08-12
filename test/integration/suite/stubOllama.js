'use strict';

/**
 * A stand-in for Ollama, on loopback.
 *
 * It has to be a real HTTP server rather than a stubbed client: the thing worth
 * testing is that `ollamaClient` reaches a real socket, that its loopback enforcement
 * lets 127.0.0.1 through, and that a scripted reply travels all the way from the wire
 * into a file on disk. A fake client object would skip every one of those.
 */

const http = require('http');

/**
 * @param {object} options
 * @param {Array<string | object>} options.replies  Scripted assistant messages, in order.
 * @param {object[]} [options.models]               What `/api/tags` reports.
 */
function startStubOllama(options) {
  const replies = options.replies || [];
  const models = options.models || [
    {
      name: 'stub-model:1b',
      model: 'stub-model:1b',
      size: 1300000000,
      digest: 'stub-digest',
      details: { family: 'stub', parameter_size: '1.2B', quantization_level: 'Q8_0' },
      capabilities: ['completion', 'tools'],
    },
  ];

  const state = { calls: 0, requests: /** @type {any[]} */ ([]) };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      /** @type {any} */
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        parsed = {};
      }
      state.requests.push({ url: req.url, body: parsed });

      const send = (payload) => {
        const text = JSON.stringify(payload);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      };

      if (req.url === '/api/version') return send({ version: '0.0.0-stub' });
      if (req.url === '/api/tags') return send({ models });
      if (req.url === '/api/show') {
        return send({
          details: { parameter_size: '1.2B', family: 'stub' },
          capabilities: ['completion', 'tools'],
        });
      }

      if (req.url === '/api/chat' || req.url === '/api/generate') {
        const reply = replies[Math.min(state.calls, replies.length - 1)];
        state.calls += 1;
        const message = typeof reply === 'string' ? { role: 'assistant', content: reply } : reply;
        return send({
          model: parsed.model || 'stub-model:1b',
          created_at: new Date().toISOString(),
          message,
          response: message.content,
          done: true,
          done_reason: 'stop',
        });
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"not found"}');
    });
  });

  return new Promise((resolve) => {
    // Port 0 so parallel runs cannot collide, bound to loopback so the client's own
    // egress rule is satisfied by the address rather than by an exception.
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('net').AddressInfo} */ (server.address());
      resolve({
        port,
        endpoint: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise((done) => server.close(() => done(undefined))),
      });
    });
  });
}

module.exports = { startStubOllama };
