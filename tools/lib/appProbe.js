'use strict';

/**
 * Serve a built app and find out whether its buttons work.
 *
 * The benchmark's verdict on a TODO app is not "did `npm run build` exit 0" — a build
 * passes on an app whose delete button is wired to nothing. So the production bundle is
 * served from a throwaway static server, opened in a real headless Chromium, and driven
 * through every feature the brief asks for. What comes back is a per-feature pass/fail
 * with the reason attached.
 *
 * Serving `dist/` rather than `npm run preview` is deliberate: preview is a long-lived
 * child process that has to be found in the output, matched on a port line whose format
 * changes between Vite majors, and killed reliably on Windows. Thirty lines of `http`
 * has none of those failure modes, and it is the same bundle either way.
 *
 * @module tools/lib/appProbe
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const { Browser } = require('./cdp');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * A static file server over one directory, with no way out of it.
 *
 * @param {string} rootDir
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function serve(rootDir) {
  const root = fs.realpathSync(rootDir);
  const server = http.createServer((request, response) => {
    let relative;
    try {
      relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    } catch {
      response.writeHead(400).end('bad url');
      return;
    }
    if (relative.endsWith('/')) relative += 'index.html';
    const target = path.join(root, relative);
    // Path confinement, for the same reason the extension has it: the directory being
    // served was written by a model, and a symlink or a `..` in a bundled asset path
    // must not be able to read the machine.
    if (target !== root && !target.startsWith(root + path.sep)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined above.
    fs.readFile(target, (error, body) => {
      if (error) {
        // SPA fallback: a router-less TODO app never needs it, but one that added a
        // route should not be failed for a 404 on a deep link.
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path.
        fs.readFile(path.join(root, 'index.html'), (fallbackError, fallbackBody) => {
          if (fallbackError) response.writeHead(404).end('not found');
          else response.writeHead(200, { 'Content-Type': MIME['.html'] }).end(fallbackBody);
        });
        return;
      }
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type }).end(body);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: 'http://127.0.0.1:' + port + '/',
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** The feature names the TODO probe reports, in the order the brief asks for them. */
const FEATURES = [
  'mounted',
  'emptyState',
  'addEnter',
  'addButton',
  'inputClears',
  'ignoresEmpty',
  'liveCount',
  'toggleComplete',
  'editTodo',
  'deleteTodo',
  'clearCompleted',
  'clearAll',
];

/** What the contact-manager probe reports. Same shape, a different product. */
const CONTACT_FEATURES = [
  'mounted',
  'emptyState',
  'addContact',
  'validatesInput',
  'listsContacts',
  'searchFilters',
  'editContact',
  'deleteContact',
  'deleteConfirms',
  'clearAll',
  'clearAllConfirms',
  'persists',
];

/** Which page script drives which brief, and what each one is expected to report. */
const SUITES = {
  'browser-todo': { file: 'probe-page.js', features: FEATURES },
  'browser-contacts': { file: 'probe-contacts.js', features: CONTACT_FEATURES },
};

/**
 * Drive the built app through every feature.
 *
 * @param {string} distDir  A Vite `dist/` directory.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ran: boolean, reason: string, features: Record<string, {ok: boolean, detail: string}>,
 *   passed: number, total: number, consoleErrors: string[], pageErrors: string[], finalText?: string}>}
 */
async function probeApp(distDir, options = {}) {
  const suite = SUITES[options.suite] || SUITES['browser-todo'];
  const expected = suite.features;
  const blank = {
    ran: false,
    reason: '',
    features: {},
    passed: 0,
    total: expected.length,
    consoleErrors: [],
    pageErrors: [],
  };

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path the caller computed from its own temp root.
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    return { ...blank, reason: 'no dist/index.html — nothing was built to probe' };
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in this repo.
  const probeSource = fs.readFileSync(path.join(__dirname, suite.file), 'utf8');

  const site = await serve(distDir);
  const browser = new Browser({ timeoutMs: options.timeoutMs || 30000 });
  try {
    await browser.launch();
    await browser.goto(site.url);
    await browser.evaluate(probeSource);
    const report = await browser.evaluate('window.__hirayaProbe()');
    const features = (report && report.features) || {};
    for (const name of expected) {
      if (!features[name]) features[name] = { ok: false, detail: 'not reached — an earlier feature failed hard' };
    }
    return {
      ran: true,
      reason: '',
      features,
      passed: expected.filter((name) => features[name] && features[name].ok).length,
      total: expected.length,
      consoleErrors: browser.consoleErrors.slice(0, 20),
      pageErrors: browser.pageErrors.slice(0, 20),
      finalText: report ? report.finalText : '',
    };
  } catch (error) {
    return {
      ...blank,
      reason: String((error && error.message) || error),
      consoleErrors: browser.consoleErrors.slice(0, 20),
      pageErrors: browser.pageErrors.slice(0, 20),
    };
  } finally {
    await browser.close().catch(() => {});
    await site.close().catch(() => {});
  }
}

module.exports = { probeApp, serve, FEATURES, CONTACT_FEATURES, SUITES };
