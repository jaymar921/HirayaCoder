'use strict';

/**
 * A Chrome DevTools Protocol client small enough to have no dependencies.
 *
 * It exists for one reason: the benchmark's question is "does every button work", and
 * nothing short of a real browser clicking a real button can answer it. Static analysis
 * of the source answers a different and much weaker question — whether an `onClick` was
 * written — and a model that wires `onClick={deleteTodo}` instead of
 * `onClick={() => deleteTodo(id)}` passes that check and ships a broken app.
 *
 * Node 22+ has a global `WebSocket`, which is the entire reason this file is forty lines
 * of transport rather than a dependency. Everything else is one `send` and one
 * `evaluate`.
 *
 * @module tools/lib/cdp
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Where Chromium lives, in the order worth trying. Edge first: it is on every Windows box. */
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** @returns {string | null} */
function findBrowser() {
  if (process.env.HIRAYA_BENCH_BROWSER) return process.env.HIRAYA_BENCH_BROWSER;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the fixed list above.
  return BROWSERS.find((candidate) => fs.existsSync(candidate)) || null;
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One headless browser with one page attached, driven over CDP.
 *
 * `--user-data-dir` is not optional on Windows: without it the launch is handed to the
 * browser the user already has open, the debugging port never opens, and the run hangs
 * until its timeout with no error to show for it.
 */
class Browser {
  constructor(options = {}) {
    this.port = options.port || 9333 + Math.floor(Math.random() * 400);
    this.timeoutMs = options.timeoutMs || 30000;
    this.nextId = 1;
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.pending = new Map();
    /** @type {string[]} */
    this.consoleErrors = [];
    /** @type {string[]} */
    this.pageErrors = [];
  }

  async launch() {
    const binary = findBrowser();
    if (!binary) throw new Error('no Chromium found — set HIRAYA_BENCH_BROWSER to a chrome/msedge path');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a temp dir this process just made.
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-cdp-'));
    this.child = spawn(
      binary,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--remote-debugging-port=' + this.port,
        '--user-data-dir=' + this.profileDir,
        'about:blank',
      ],
      { stdio: 'ignore', windowsHide: true }
    );

    const target = await this._waitForTarget();
    this.ws = new WebSocket(target);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket did not open')), this.timeoutMs);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP websocket errored'));
      });
    });

    this.ws.addEventListener('message', (event) => this._onMessage(String(event.data)));
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
  }

  /** Poll the debugging port until the browser has published a page target to attach to. */
  async _waitForTarget() {
    const deadline = Date.now() + this.timeoutMs;
    let lastError = 'never responded';
    while (Date.now() < deadline) {
      try {
        const response = await fetch('http://127.0.0.1:' + this.port + '/json/list');
        const targets = await response.json();
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page.webSocketDebuggerUrl;
        lastError = 'no page target yet';
      } catch (error) {
        lastError = String(error.message || error);
      }
      await sleep(150);
    }
    throw new Error('browser debugging port never came up: ' + lastError);
  }

  /** @param {string} raw */
  _onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    // Everything a broken app says about itself. A React app that throws on mount
    // renders an empty root and looks, to a DOM query, exactly like one that rendered
    // nothing — these two streams are how the difference gets recorded.
    if (message.method === 'Runtime.exceptionThrown') {
      const details = (message.params && message.params.exceptionDetails) || {};
      this.pageErrors.push(String((details.exception && details.exception.description) || details.text || 'exception'));
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params && message.params.type === 'error') {
      const args = message.params.args || [];
      this.consoleErrors.push(args.map((a) => String(a.value != null ? a.value : a.description || '')).join(' '));
    } else if (message.method === 'Log.entryAdded') {
      const entry = (message.params && message.params.entry) || {};
      if (entry.level === 'error') this.consoleErrors.push(String(entry.text || ''));
    }
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Run an expression in the page and return its value.
   *
   * `awaitPromise` is on so a probe can await React's own re-render before asserting;
   * without it every assertion races the scheduler and fails intermittently, which is
   * the worst property a benchmark can have.
   *
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const description = (details.exception && details.exception.description) || details.text;
      throw new Error(String(description).split('\n')[0]);
    }
    return result.result ? result.result.value : undefined;
  }

  /** @param {string} url */
  async goto(url) {
    await this.send('Page.navigate', { url });
    // `Page.loadEventFired` is not enough for a React app: the document is complete
    // while the root div is still empty. Give the module graph a moment to mount.
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.evaluate('document.readyState === "complete"').catch(() => false);
      if (ready) break;
      await sleep(100);
    }
    await sleep(600);
  }

  async close() {
    try {
      if (this.ws) this.ws.close();
    } catch {
      /* the process is going away regardless */
    }
    try {
      if (this.child) this.child.kill();
    } catch {
      /* already gone */
    }
    await sleep(300);
    if (this.profileDir) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own temp dir.
      fs.rmSync(this.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

module.exports = { Browser, findBrowser, sleep };
