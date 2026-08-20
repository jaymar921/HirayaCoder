'use strict';

/**
 * Every control in the panel does something, and the something is handled.
 *
 * A dead button is the one UI defect that no other test in this repo can see. The
 * component tests build nodes and assert their shape; the integration tests drive the
 * host. Neither notices that `index.html` grew a button nobody listened to, or that a
 * control posts `attach-flie` and the host's switch quietly falls through to
 * `default`. Both have happened in webviews, and both look completely normal on screen
 * until clicked.
 *
 * So this reads the three files as text and checks the seams between them:
 *
 *   1. Every interactive element in `index.html` is looked up in `main.js`.
 *   2. Every one of them has a way to be activated — its own listener, a delegated
 *      listener on its container, or the form it submits.
 *   3. Every message `main.js` posts is a case the host actually handles.
 *   4. Every message the host posts has a handler in `main.js`.
 *
 * Static analysis is the right shape here on purpose. Loading the real `main.js` would
 * need `acquireVsCodeApi`, a live DOM, and the whole panel standing up — which is the
 * integration suite's job, and it still would not tell us a button was never wired.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const webviewDir = path.join(__dirname, '..', '..', 'app', 'webview');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const html = read(webviewDir, 'index.html');
const mainJs = read(webviewDir, 'main.js');
const chatTabJs = read(__dirname, '..', '..', 'app', 'features', 'chatTab.js');

const componentsJs = fs
  .readdirSync(path.join(webviewDir, 'components'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => read(webviewDir, 'components', name))
  .join('\n');

/** Every `<button>`, `<select>`, `<textarea>` and `<form>` tag, as its raw open tag. */
function interactiveTags() {
  const matches = html.match(/<(?:button|select|textarea|form)\b[^>]*>/g) || [];
  return matches.map((tag) => ({
    tag,
    name: (tag.match(/^<([a-z]+)/) || [])[1],
    id: (tag.match(/\bid="([^"]+)"/) || [])[1],
    type: (tag.match(/\btype="([^"]+)"/) || [])[1],
    dataAttrs: (tag.match(/\bdata-([a-z-]+)="/g) || []).map((a) => a.slice(5, -2)),
  }));
}

/** The `id`s of elements that carry a click listener in `main.js`, however attached. */
function listeningIds() {
  const listening = new Set();

  // `el.foo.addEventListener(...)`, plus the shorthand where the key differs from the
  // id — so the id is recovered through the lookup table rather than guessed from it.
  const lookups = new Map();
  for (const match of mainJs.matchAll(/(\w+):\s*document\.getElementById\('([^']+)'\)/g)) {
    lookups.set(match[1], match[2]);
  }

  for (const match of mainJs.matchAll(/el\.(\w+)\.addEventListener\(/g)) {
    const id = lookups.get(match[1]);
    if (id) listening.add(id);
  }

  return { listening, lookups };
}

describe('webview wiring — every control is looked up', () => {
  const { lookups } = listeningIds();

  for (const element of interactiveTags()) {
    if (!element.id) continue;
    it(`main.js resolves #${element.id}`, () => {
      assert.ok(
        [...lookups.values()].includes(element.id),
        `<${element.name} id="${element.id}"> is in index.html but main.js never calls ` +
          `getElementById('${element.id}') — it cannot be wired to anything.`
      );
    });
  }
});

describe('webview wiring — every control can be activated', () => {
  const { listening } = listeningIds();
  const elements = interactiveTags();

  // The containers that take a delegated click, keyed by the `data-` attribute their
  // children carry: `#mode` handles `[data-mode]`, `#thinking` handles `[data-capacity]`.
  const delegated = new Set();
  for (const match of mainJs.matchAll(/closest\('button\[data-([a-z-]+)\]'\)/g)) {
    delegated.add(match[1]);
  }

  for (const element of elements) {
    if (element.name !== 'button') continue;

    const label = element.id ? `#${element.id}` : element.tag.replace(/\s+/g, ' ');

    it(`${label} has a handler`, () => {
      if (element.id && listening.has(element.id)) return;

      // A submit button is activated through its form, which is where the listener has
      // to be — Enter in the textarea must do the same thing the button does.
      if (element.type === 'submit') {
        assert.ok(
          listening.has('composer'),
          `${label} submits, but no listener is attached to the form it submits.`
        );
        return;
      }

      // Otherwise it must be a delegated child: it carries a `data-` attribute that a
      // container's click handler selects on.
      const matched = element.dataAttrs.filter((attr) => delegated.has(attr));
      assert.ok(
        matched.length > 0,
        `${label} has no listener of its own, does not submit, and carries no ` +
          `data- attribute any delegated handler selects on (has: ` +
          `${element.dataAttrs.join(', ') || 'none'}). It is a dead button.`
      );
    });
  }

  it('leaves no delegated handler selecting on nothing', () => {
    // The other direction: a renamed attribute leaves a handler that matches no button,
    // which is the same dead control seen from the JavaScript side.
    const present = new Set(elements.flatMap((element) => element.dataAttrs));
    for (const attr of delegated) {
      assert.ok(present.has(attr), `main.js delegates on [data-${attr}], which no button carries.`);
    }
  });
});

describe('webview wiring — the message protocol closes on both sides', () => {
  const posted = new Set(
    [...`${mainJs}\n${componentsJs}`.matchAll(/postMessage\(\{\s*type:\s*'([^']+)'/g)].map((m) => m[1])
  );

  const hostCases = new Set([...chatTabJs.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));

  const hostPosts = new Set([...chatTabJs.matchAll(/type:\s*'([a-z-]+)'/g)].map((m) => m[1]));

  const webviewHandlers = new Set([
    ...[...mainJs.matchAll(/^\s{2}(?:'([a-z-]+)'|([a-z]+))\((?:msg)?\)\s*\{/gm)].map((m) => m[1] || m[2]),
  ]);

  it('posts something at all, or the extraction is broken', () => {
    // Guards the regexes above: an empty set would make every assertion below pass.
    assert.ok(posted.size >= 10, `only found ${posted.size} posted message types`);
    assert.ok(hostPosts.size >= 10, `only found ${hostPosts.size} host message types`);
    assert.ok(webviewHandlers.size >= 10, `only found ${webviewHandlers.size} webview handlers`);
  });

  for (const type of posted) {
    it(`the host handles '${type}'`, () => {
      assert.ok(
        hostCases.has(type),
        `the webview posts '${type}' and chatTab._onMessage has no case for it — the ` +
          `click reaches the host and is logged as unknown.`
      );
    });
  }

  for (const type of hostPosts) {
    it(`the webview handles '${type}'`, () => {
      assert.ok(
        webviewHandlers.has(type),
        `chatTab posts '${type}' to the panel and main.js has no handler for it — the ` +
          `message arrives and is dropped.`
      );
    });
  }
});
