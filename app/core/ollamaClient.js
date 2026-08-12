'use strict';

/**
 * HTTP wrapper around the local Ollama API.
 *
 * This is the ONLY module in HirayaCoder permitted to open a socket, and it will
 * only ever open one to a loopback address. The loopback restriction is enforced in
 * code (`assertLoopbackEndpoint`), not by convention — a non-loopback endpoint in
 * settings throws before any request is made, so there is no configuration that
 * causes workspace content to leave the machine.
 *
 * Implemented directly on `node:http` rather than a client library to keep the
 * dependency footprint at zero (see `security/threat-model.md`).
 *
 * @module core/ollamaClient
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const logger = require('../utils/logger');

/** Hostnames that resolve to this machine and nothing else. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

const DEFAULT_ENDPOINT = 'http://127.0.0.1:11434';
// Local inference on CPU is slow: a single turn on a 2-5B model routinely takes
// 60-90 seconds, and a 120s ceiling turned that into spurious mid-session failures.
const DEFAULT_TIMEOUT_MS = 300000;

/**
 * Consecutive timeouts before the server is called unresponsive rather than slow.
 *
 * One is not enough and never will be: on CPU inference a large model loading into
 * memory legitimately blows a deadline, and telling the user to restart a server that
 * was merely busy is worse than saying nothing. Two in a row is not a load.
 */
const TIMEOUTS_BEFORE_UNRESPONSIVE = 2;

/**
 * @typedef {object} OllamaModelDetails
 * @property {string} [parameter_size]
 * @property {string} [quantization_level]
 * @property {string} [family]
 * @property {number} [context_length]
 */

/**
 * @typedef {object} OllamaTagEntry
 * @property {string} name
 * @property {string} [model]
 * @property {number} [size]
 * @property {string} [modified_at]
 * @property {string[]} [capabilities]
 * @property {OllamaModelDetails} [details]
 */

/**
 * @typedef {object} ChatRequest
 * @property {string} model
 * @property {Array<{role: string, content: string, images?: string[], tool_calls?: unknown[]}>} messages
 * @property {unknown[]} [tools]        Native tool schemas (Tier A only).
 * @property {'json'} [format]          Constrains sampling to valid JSON (Tier B loop).
 * @property {boolean} [think]          Reasoning passthrough, models that support it.
 * @property {Record<string, unknown>} [options] num_ctx, temperature, num_predict, ...
 * @property {boolean} [stream]
 */

/**
 * Validate that an endpoint points at this machine.
 *
 * @param {string} endpoint
 * @returns {URL} The parsed, validated endpoint.
 * @throws {Error} If the endpoint is malformed, non-HTTP, or not loopback.
 */
function assertLoopbackEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint));
  } catch {
    throw new Error(
      `HirayaCoder: "${endpoint}" is not a valid URL. Expected something like ${DEFAULT_ENDPOINT}.`
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`HirayaCoder: unsupported protocol "${url.protocol}". Use http or https on a loopback address.`);
  }

  const host = url.hostname.toLowerCase();
  // Cover the whole 127.0.0.0/8 range, not just 127.0.0.1.
  const isLoopbackIpv4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (!LOOPBACK_HOSTS.has(host) && !isLoopbackIpv4) {
    throw new Error(
      `HirayaCoder refuses to connect to "${url.hostname}". Only loopback addresses ` +
        `(127.0.0.1, localhost, ::1) are allowed — the extension is offline by design.`
    );
  }

  return url;
}

/**
 * Thrown for transport-level failures so callers can distinguish "Ollama isn't
 * running" from "Ollama answered with an error".
 */
class OllamaUnreachableError extends Error {
  /**
   * @param {string} endpoint
   * @param {Error} cause
   */
  constructor(endpoint, cause) {
    super(`Could not reach Ollama at ${endpoint}. Is it running? (${cause.message})`);
    this.name = 'OllamaUnreachableError';
    this.cause = cause;
    this.endpoint = endpoint;
  }
}

/** Thrown when Ollama responds with a non-2xx status. */
class OllamaResponseError extends Error {
  /**
   * @param {number} status
   * @param {string} body
   * @param {string} path
   */
  constructor(status, body, path) {
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed.error === 'string') detail = parsed.error;
    } catch {
      /* keep the raw body */
    }
    super(`Ollama ${path} returned ${status}: ${detail}`);
    this.name = 'OllamaResponseError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Create a client bound to one endpoint.
 *
 * @param {object} [config]
 * @param {string} [config.endpoint]
 * @param {number} [config.timeoutMs]
 * @returns {OllamaClient}
 */
function createClient(config = {}) {
  return new OllamaClient(config);
}

class OllamaClient {
  /**
   * @param {object} [config]
   * @param {string} [config.endpoint]
   * @param {number} [config.timeoutMs]
   */
  constructor(config = {}) {
    this.endpoint = config.endpoint || DEFAULT_ENDPOINT;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    // Validate eagerly so a bad setting surfaces at construction, not mid-task.
    this.url = assertLoopbackEndpoint(this.endpoint);

    /**
     * Running health and latency, updated by `_observe` on every settled request.
     *
     * Lives on the client because that is the only place that sees every call — the
     * agent loop, the model list, the status-bar ping, and inline completion all go
     * through here, so a picture assembled anywhere else would be partial.
     */
    this.health = {
      state: /** @type {'unknown' | 'up' | 'down' | 'unresponsive'} */ ('unknown'),
      consecutiveFailures: 0,
      consecutiveTimeouts: 0,
      requests: 0,
      totalLatencyMs: 0,
      slowestMs: 0,
      lastLatencyMs: /** @type {number | null} */ (null),
      lastOkAt: /** @type {number | null} */ (null),
      lastErrorAt: /** @type {number | null} */ (null),
      lastError: /** @type {string | null} */ (null),
    };

    /** @type {((health: object, previous: string) => void) | null} Set by the host. */
    this.onHealthChange = null;
  }

  /**
   * Re-point the client, e.g. after a settings change.
   *
   * @param {object} config
   * @param {string} [config.endpoint]
   * @param {number} [config.timeoutMs]
   */
  reconfigure(config) {
    if (config.endpoint !== undefined) {
      this.url = assertLoopbackEndpoint(config.endpoint);
      this.endpoint = config.endpoint;
    }
    if (config.timeoutMs !== undefined) this.timeoutMs = config.timeoutMs;
  }

  /**
   * Issue a request and buffer the full response body.
   *
   * @param {'GET' | 'POST' | 'DELETE'} method
   * @param {string} apiPath
   * @param {unknown} [body]
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<any>} Parsed JSON response.
   */
  request(method, apiPath, body, opts = {}) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      // Wrapped so every settle path — success, HTTP error, malformed body, transport
      // failure — passes through the health tracker exactly once. Timing at this layer
      // rather than at each call site is what makes "why was that turn slow?" a
      // question the ledger can answer without every caller remembering to measure.
      const settle = (fn, err) => (value) => {
        this._observe(apiPath, Date.now() - startedAt, err ? value : null);
        fn(value);
      };
      const done = settle(resolve, false);
      const failed = settle(reject, true);

      const chunks = [];
      const req = this._open(method, apiPath, body, opts, (res) => {
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            failed(new OllamaResponseError(status, text, apiPath));
            return;
          }
          if (!text.trim()) {
            done({});
            return;
          }
          try {
            done(JSON.parse(text));
          } catch (err) {
            failed(new Error(`Ollama ${apiPath} returned malformed JSON: ${/** @type {Error} */ (err).message}`));
          }
        });
      }, failed);

      if (req) req.end();
    });
  }

  /**
   * Issue a streaming request. Ollama streams newline-delimited JSON objects.
   *
   * @param {'POST'} method
   * @param {string} apiPath
   * @param {unknown} body
   * @param {(chunk: any) => void} onChunk Called once per NDJSON object.
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs]
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<void>} Resolves when the stream ends.
   */
  requestStream(method, apiPath, body, onChunk, opts = {}) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      const req = this._open(method, apiPath, body, opts, (res) => {
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) {
          const errChunks = [];
          res.on('data', (c) => errChunks.push(c));
          res.on('end', () => reject(new OllamaResponseError(status, Buffer.concat(errChunks).toString('utf8'), apiPath)));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (text) => {
          buffer += text;
          let newline = buffer.indexOf('\n');
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
              try {
                onChunk(JSON.parse(line));
              } catch (err) {
                // A malformed frame mid-stream shouldn't kill the whole turn; the
                // parser layer decides what to do with an incomplete response.
                logger.warn('Discarded malformed stream frame from Ollama:', line.slice(0, 200));
              }
            }
            newline = buffer.indexOf('\n');
          }
        });
        res.on('end', () => {
          const tail = buffer.trim();
          if (tail) {
            try {
              onChunk(JSON.parse(tail));
            } catch {
              logger.warn('Discarded malformed trailing frame from Ollama.');
            }
          }
          resolve();
        });
      }, reject);

      if (req) req.end();
    });
  }

  /**
   * Fold one finished request into the running health picture.
   *
   * ## Why three failure states and not one boolean
   *
   * "Is Ollama up?" is the wrong question on a laptop running a local model, because
   * the two ways it goes wrong need opposite responses from the user:
   *
   *  - **down** — nothing is listening. The process is not running, or it is on a
   *    different port. `OllamaUnreachableError` says so on the first try, so there is
   *    no reason to wait for a second: start Ollama.
   *  - **unresponsive** — something is listening and did not answer inside the
   *    deadline. On CPU inference the innocent explanation is real (a large model
   *    loading into memory can take minutes), which is why one timeout is not enough
   *    to call it. Repeated ones are the wedged-server case, and that is the one that
   *    actually needs a restart.
   *  - **up**, with the request having failed anyway — a 4xx or 5xx. The server is
   *    healthy and the *request* was wrong, which is a different bug entirely and must
   *    not be reported as an outage.
   *
   * Latency is recorded on every settle, including failures: a timeout's duration is
   * the most informative number in a slow session, and dropping it would leave exactly
   * the case worth debugging unmeasured.
   *
   * @param {string} apiPath
   * @param {number} ms
   * @param {Error | null} error
   * @private
   */
  _observe(apiPath, ms, error) {
    const previous = this.health.state;

    this.health.lastLatencyMs = ms;
    this.health.requests += 1;
    this.health.totalLatencyMs += ms;
    if (ms > this.health.slowestMs) this.health.slowestMs = ms;

    if (!error) {
      this.health.state = 'up';
      this.health.consecutiveFailures = 0;
      this.health.consecutiveTimeouts = 0;
      this.health.lastOkAt = Date.now();
      this.health.lastError = null;
    } else {
      // An abort is the user pressing Stop, or a session being cancelled. It says
      // nothing about the server and must never be counted against it.
      if (/aborted/i.test(error.message || '')) return;

      this.health.consecutiveFailures += 1;
      this.health.lastErrorAt = Date.now();
      this.health.lastError = String(error.message || '').slice(0, 200);

      if (error instanceof OllamaUnreachableError) {
        this.health.state = 'down';
        this.health.consecutiveTimeouts = 0;
      } else if (/timed out/i.test(error.message || '')) {
        this.health.consecutiveTimeouts += 1;
        this.health.state = this.health.consecutiveTimeouts >= TIMEOUTS_BEFORE_UNRESPONSIVE ? 'unresponsive' : 'up';
      } else {
        // The server answered, so it is up; the request is what failed.
        this.health.state = 'up';
        this.health.consecutiveTimeouts = 0;
      }
    }

    if (this.health.state !== previous) {
      logger.info(`Ollama is ${this.health.state} (was ${previous}) after ${apiPath} in ${ms}ms.`);
      if (this.onHealthChange) {
        try {
          this.onHealthChange(this.healthSnapshot(), previous);
        } catch (err) {
          // A reporting hook must never break the request that triggered it.
          logger.warn(`Health listener threw: ${/** @type {Error} */ (err).message}`);
        }
      }
    }
  }

  /**
   * The current picture, as a plain copy.
   *
   * `needsRestart` is the whole point of the distinction above: it is true only for the
   * two states a user can actually act on, so a UI can say "start Ollama" without
   * having to re-derive which failures mean that.
   *
   * @returns {{state: string, needsRestart: boolean, lastLatencyMs: number | null, averageLatencyMs: number | null, slowestMs: number, requests: number, consecutiveFailures: number, lastOkAt: number | null, lastErrorAt: number | null, lastError: string | null}}
   */
  healthSnapshot() {
    return {
      ...this.health,
      needsRestart: this.health.state === 'down' || this.health.state === 'unresponsive',
      averageLatencyMs:
        this.health.requests > 0 ? Math.round(this.health.totalLatencyMs / this.health.requests) : null,
    };
  }

  /**
   * Shared request plumbing: builds the request, wires timeout/abort, and forwards
   * transport errors as `OllamaUnreachableError`.
   *
   * @param {string} method
   * @param {string} apiPath
   * @param {unknown} body
   * @param {{timeoutMs?: number, signal?: AbortSignal}} opts
   * @param {(res: import('http').IncomingMessage) => void} onResponse
   * @param {(err: Error) => void} onError
   * @returns {import('http').ClientRequest | null}
   * @private
   */
  _open(method, apiPath, body, opts, onResponse, onError) {
    const transport = this.url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    // `??` rather than `||`, so an explicit 0 survives. A model pull legitimately
    // runs for an hour and passes 0 to mean "no deadline"; with `||` that read as
    // falsy, fell back to the default, and aborted the download partway.
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    /** @type {import('http').RequestOptions} */
    const requestOptions = {
      protocol: this.url.protocol,
      hostname: this.url.hostname,
      port: this.url.port || (this.url.protocol === 'https:' ? 443 : 80),
      path: (this.url.pathname === '/' ? '' : this.url.pathname.replace(/\/$/, '')) + apiPath,
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
        : {},
    };

    logger.debug(`ollama ${method} ${requestOptions.path}`);

    let settled = false;
    /** @param {Error} err */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      onError(err);
    };

    const req = transport.request(requestOptions, (res) => {
      if (settled) {
        res.resume();
        return;
      }
      settled = true;
      onResponse(res);
    });

    // Zero means no deadline — only `pull` uses it, and only because a download has
    // no sensible upper bound. Everything else keeps its timeout.
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        fail(new Error(`Ollama request to ${apiPath} timed out after ${timeoutMs}ms.`));
      });
    }

    req.on('error', (err) => {
      fail(new OllamaUnreachableError(this.endpoint, /** @type {Error} */ (err)));
    });

    if (opts.signal) {
      if (opts.signal.aborted) {
        req.destroy();
        fail(new Error('Request aborted.'));
        return null;
      }
      opts.signal.addEventListener(
        'abort',
        () => {
          req.destroy();
          fail(new Error('Request aborted.'));
        },
        { once: true }
      );
    }

    if (payload) req.write(payload);
    return req;
  }

  // --- API surface -------------------------------------------------------

  /**
   * List locally installed models.
   *
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<OllamaTagEntry[]>}
   */
  async tags(opts = {}) {
    const data = await this.request('GET', '/api/tags', undefined, { timeoutMs: 10000, signal: opts.signal });
    return Array.isArray(data && data.models) ? data.models : [];
  }

  /**
   * Model metadata. Only needed as a fallback — modern Ollama returns parameter
   * size, context length, and capabilities inline from `/api/tags`.
   *
   * @param {string} model
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<any>}
   */
  show(model, opts = {}) {
    return this.request('POST', '/api/show', { model }, { timeoutMs: 15000, signal: opts.signal });
  }

  /**
   * Non-streaming chat completion.
   *
   * @param {ChatRequest} body
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
   * @returns {Promise<any>}
   */
  chat(body, opts = {}) {
    return this.request('POST', '/api/chat', { ...body, stream: false }, opts);
  }

  /**
   * Streaming chat completion.
   *
   * @param {ChatRequest} body
   * @param {(chunk: any) => void} onChunk
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
   * @returns {Promise<void>}
   */
  chatStream(body, onChunk, opts = {}) {
    return this.requestStream('POST', '/api/chat', { ...body, stream: true }, onChunk, opts);
  }

  /**
   * Raw completion — used by inline completion, which has no conversation.
   *
   * @param {{model: string, prompt: string, suffix?: string, options?: Record<string, unknown>, format?: 'json'}} body
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [opts]
   * @returns {Promise<any>}
   */
  generate(body, opts = {}) {
    return this.request('POST', '/api/generate', { ...body, stream: false }, opts);
  }

  /**
   * Download a model, streaming progress.
   *
   * The only call in this client with no timeout: a multi-gigabyte pull on a slow
   * connection legitimately runs for an hour, and the usual per-request deadline
   * would abort it partway through and leave the user re-downloading. Cancellation
   * is the caller's job, via `signal` — which is what the progress notification's
   * cancel button is wired to.
   *
   * @param {{model: string, insecure?: boolean}} body
   * @param {{signal?: AbortSignal, onProgress?: (chunk: any) => void}} [opts]
   * @returns {Promise<void>}
   */
  pull(body, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    return this.requestStream('POST', '/api/pull', { ...body, stream: true }, onProgress, {
      signal: opts.signal,
      timeoutMs: 0,
    });
  }

  /**
   * Cheap liveness probe for the status bar.
   *
   * @returns {Promise<{reachable: boolean, version?: string, error?: string}>}
   */
  async ping() {
    try {
      const data = await this.request('GET', '/api/version', undefined, { timeoutMs: 3000 });
      return { reachable: true, version: (data && data.version) || 'unknown' };
    } catch (err) {
      return { reachable: false, error: /** @type {Error} */ (err).message };
    }
  }
}

module.exports = {
  OllamaClient,
  OllamaUnreachableError,
  OllamaResponseError,
  createClient,
  assertLoopbackEndpoint,
  DEFAULT_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  TIMEOUTS_BEFORE_UNRESPONSIVE,
};
