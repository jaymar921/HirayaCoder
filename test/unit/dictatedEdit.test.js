'use strict';

/**
 * Dictated edits: the extension finds the lines a request is about, the model is asked in
 * plain words to rewrite them, and the answer is applied as an ordinary edit_file.
 *
 * Measured before this existed (tools/bench-edit.js, llama3.2:1b, a 164-line module):
 * 0 of 12 with whole-file writes, and still 0 of 12 with edit_file, because the model
 * filled `find` with words from the request rather than text from the file.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const editRegion = require('../../app/core/editRegion');
const { asksForMore } = require('../../app/core/contextTranslator');
const { dictateEdit, extractEdit, buildEditPrompt, outOfScope } = require('../../app/agent/dictation');
const { locateLines } = require('../../app/agent/tools/editFile');
const { AgentSession } = require('../../app/agent/agentSession');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');
const { CART_JS } = require('../../tools/lib/cartFixture');

const lineOf = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle));

describe('editRegion.locate', () => {
  const at = (request) => editRegion.locate(CART_JS, request, { path: 'src/cart.js' });

  it('finds a constant from the words of the request', () => {
    // "tax rate" is how a person says `TAX_RATE`, and the declaration beats the line using it.
    const region = at('In src/cart.js, change the tax rate from 8% to 10%.');
    assert.strictEqual(region.text, 'const TAX_RATE = 0.08;');
  });

  it('matches an abbreviation, and widens a hit to its whole function', () => {
    assert.strictEqual(at('Raise the maximum quantity in src/cart.js to 500.').text, 'const MAX_QUANTITY = 99;');
    const region = at('In src/cart.js, make applyDiscount throw an Error when the percent is greater than 50.');
    assert.ok(region.text.startsWith('function applyDiscount(cart, percent) {'));
    assert.ok(region.text.endsWith('}'));
  });

  it('ignores comments, which describe the code next to them', () => {
    const region = at('In src/cart.js, removeItem throws an error when the id is not in the cart.');
    assert.ok(region.text.startsWith('function removeItem(cart, id) {'), region.text);
  });

  it('places an addition above the export list, with a related definition to copy from', () => {
    const region = at('Add a function itemCount(cart) to src/cart.js that returns the total quantity of all items, and export it.');
    assert.strictEqual(region.mode, 'insert');
    assert.deepStrictEqual(region.names, ['itemCount']);
    assert.ok(region.exportList.text.startsWith('module.exports = {'));
    assert.ok(region.exportList.text.endsWith('};'));
    // The function that already walks `cart.items` is the explanation of the data a 1B
    // model needed; without it, it wrote `cart.reduce(...)`.
    assert.match(region.related, /cart\.items/);
  });

  it('appends when the file has no export list', () => {
    const region = editRegion.locate('def total():\n    return 1\n', 'Add total_price() that returns 2', { path: 'm.py' });
    assert.strictEqual(region.mode, 'append');
    assert.strictEqual(region.start, 2);
  });

  it('adds names to an export list in its own layout, and never twice', () => {
    assert.strictEqual(editRegion.withExports('module.exports = { a, b };', ['c']), 'module.exports = { a, b, c };');
    assert.strictEqual(editRegion.withExports('module.exports = {\n  a,\n  b\n};', ['c']), 'module.exports = {\n  a,\n  b,\n  c,\n};');
    assert.strictEqual(editRegion.withExports('export { a };', ['a']), 'export { a };');
    assert.strictEqual(editRegion.withExports('const x = 1;', ['c']), null);
  });

  it('adds to an export list whose last line ends in a long run of spaces, quickly', () => {
    const started = Date.now();
    const out = editRegion.withExports(`module.exports = {\n  a${' '.repeat(100000)}\n};`, ['c']);
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
    assert.strictEqual(out, 'module.exports = {\n  a,\n  c,\n};');
  });

  it('declines a request that says nothing about where', () => {
    assert.strictEqual(at('Fix the bug in src/cart.js'), null);
  });

  it('declines when two separate places match equally', () => {
    const text = 'function a() {\n  return total;\n}\n\nfunction b() {\n  return total;\n}\n';
    assert.strictEqual(editRegion.locate(text, 'change the total', { path: 'x.js' }), null);
  });

  it('stays fast on a hostile file and request', () => {
    const started = Date.now();
    editRegion.locate(`${'a'.repeat(100000)}\n`.repeat(3), `${'b'.repeat(100000)} c(`, {});
    editRegion.locate('x\n'.repeat(1999), 'x '.repeat(10000), {});
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  });
});

describe('contextTranslator.asksForMore', () => {
  const cases = [
    ['In src/cart.js, change the tax rate from 8% to 10%.', false],
    ['Add a function itemCount(cart) to src/cart.js, and export it alongside the others.', false],
    ['In src/cart.js, change the tax rate to 10% and add a test for total().', true],
    ['Change the tax rate in src/cart.js. Then update the README.', true],
    ['Fix the bug in src/cart.js where total is wrong', false],
  ];
  for (const [request, expected] of cases) {
    it(`${expected ? 'sees more than one part' : 'sees one part'} in "${request.slice(0, 48)}…"`, () => {
      assert.strictEqual(asksForMore(request), expected);
    });
  }

  it('stays fast on a request padded with spaces', () => {
    const started = Date.now();
    asksForMore(`plus${' '.repeat(19996)}!`);
    assert.ok(Date.now() - started < 200, `took ${Date.now() - started}ms`);
  });
});

describe('dictation.outOfScope', () => {
  const opener = 'def sell(self, sku, quantity):';

  it('reads a top-level name that starts with a keyword as the whole name', () => {
    // `constant` was read as `const` declaring `ant`, and the insert that used it refused.
    const fileText = 'constant = 1\nletter = "a"\nclasses = []\n';
    assert.deepStrictEqual(outOfScope('if quantity > constant or letter in classes:\n    raise ValueError()', { opener, fileText }), []);
  });

  it('still refuses a name the file does not have', () => {
    assert.deepStrictEqual(outOfScope('if quantity > self.stock:\n    raise ValueError()', { opener, fileText: 'class Inventory:\n', classText: '' }), ['self.stock']);
  });

  it('stays fast on a file line of keyword and tabs', () => {
    const started = Date.now();
    outOfScope('x', { opener, fileText: `export${'\t'.repeat(200000)}(` });
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
  });

  it('trims a reply ending in a long run of blank space, quickly', () => {
    const started = Date.now();
    const out = extractEdit(`\`\`\`js\nconst TAX_RATE = 0.1;${' '.repeat(20000)}x${' \n'.repeat(10000)}\`\`\``, { mode: 'insert', text: '' });
    assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
    assert.ok(out.code === null || !/\s$/.test(out.code));
  });
});

describe('dictation.dictateEdit', () => {
  const region = { mode: 'replace', start: 7, end: 7, text: 'const TAX_RATE = 0.08;' };

  it('asks in plain words, showing the lines and the request', () => {
    const prompt = buildEditPrompt({ path: 'src/cart.js', task: 'change the tax rate to 10%', region });
    assert.match(prompt, /Here is line 8 of src\/cart\.js/);
    assert.match(prompt, /const TAX_RATE = 0\.08;/);
    assert.match(prompt, /The request: change the tax rate to 10%/);
    assert.doesNotMatch(prompt, /"action"/, 'the JSON protocol leaked into a plain request');
  });

  it('takes a one-line answer, which a file dictation would refuse as too short', () => {
    assert.deepStrictEqual(extractEdit('```js\nconst TAX_RATE = 0.1;\n```', region), { code: 'const TAX_RATE = 0.1;', reason: '' });
  });

  it('refuses an unchanged answer, prose, a cut-off block, and a whole file', () => {
    assert.match(extractEdit('```js\nconst TAX_RATE = 0.08;\n```', region).reason, /unchanged/);
    assert.match(extractEdit('Sure! You should change it to 0.1.', region).reason, /explained/);
    assert.match(extractEdit('```js\nconst TAX_RATE = 0.1;', region).reason, /cut off/);
    assert.match(extractEdit(`\`\`\`js\n${CART_JS}\`\`\``, region).reason, /rewrote far more/);
  });

  it('sends no format and no thinking, only words', async () => {
    let sent;
    const client = {
      async chat(body) {
        sent = body;
        return { message: { content: '```js\nconst TAX_RATE = 0.1;\n```' }, done_reason: 'stop' };
      },
    };
    const result = await dictateEdit({ client, model: 'm', path: 'src/cart.js', task: 't', region });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(sent.format, undefined);
    assert.strictEqual(sent.think, false);
  });
});

describe('editFile.locateLines', () => {
  const text = 'a\nb\nc\n';

  it('places an edit by line when the lines are what was read', () => {
    assert.deepStrictEqual(locateLines(text, { start: 1, end: 1 }, 'b'), { start: 2, end: 3, how: 'exact' });
  });

  it('refuses lines that changed since they were read', () => {
    assert.strictEqual(locateLines(text, { start: 1, end: 1 }, 'B'), null);
    assert.strictEqual(locateLines(text, { start: 9, end: 9 }, 'b'), null);
  });

  it('inserts at the end with nothing to match', () => {
    assert.deepStrictEqual(locateLines(text, { start: 3, end: 2 }, ''), { start: 6, end: 6, how: 'exact' });
    assert.strictEqual(locateLines(text, { start: 3, end: 2 }, 'x'), null);
  });
});

describe('AgentSession: a dictated edit', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-dictedit-')));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'cart.js'), CART_JS);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  function session(replies, capability) {
    const client = {
      calls: 0,
      bodies: [],
      async chat(body) {
        this.bodies.push(body);
        const reply = replies[Math.min(this.calls, replies.length - 1)];
        this.calls += 1;
        return { message: { content: reply }, done_reason: 'stop' };
      },
    };
    const gate = new PermissionGate({
      workspaceRoot: root,
      modes: new PermissionModes({ initial: { autoEdit: true } }),
      auditLog: new AuditLog(root),
      confirm: async () => true,
    });
    return {
      client,
      session: new AgentSession({
        client: /** @type {any} */ (client),
        model: 'm',
        capability: capability || { tier: 'B', strategy: 'react', canPlanTodos: false, params: 1.2 },
        gate,
        workspaceRoot: root,
        sessionId: '1',
      }),
    };
  }

  it('makes the change with one plain-words call and ends the turn', async () => {
    const { client, session: s } = session(['```js\nconst TAX_RATE = 0.1;\n```']);
    const result = await s.run('In src/cart.js, change the tax rate from 8% to 10%.', { mode: 'agent' });

    assert.strictEqual(client.calls, 1, 'the loop was asked to confirm a finished edit');
    assert.strictEqual(client.bodies[0].format, undefined);
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8'), CART_JS.replace('0.08', '0.1'));
    assert.strictEqual(result.stopReason, 'done');
    assert.match(result.summary, /Changed src\/cart\.js: "const TAX_RATE = 0\.08;" became "const TAX_RATE = 0\.1;"/);
    assert.strictEqual(result.steps[0].action.action, 'edit_file');
  });

  it('leaves a file holding a secret to the loop, which redacts, and never shows the raw line', async () => {
    const key = 'sk-proj-Q7vR2mX9kL4pT8wN3bY6cH1dF5gJ0aZs';
    fs.writeFileSync(path.join(root, 'src', 'cart.js'), CART_JS.replace("'use strict';", `'use strict';\nconst API_KEY = '${key}';`));
    const { client, session: s } = session([JSON.stringify({ thought: 'stop', action: 'done', summary: 'Not changed.' })]);
    await s.run('In src/cart.js, change the tax rate from 8% to 10%.', { mode: 'agent' });

    assert.ok(client.bodies.length > 0);
    assert.strictEqual(client.bodies[0].format !== undefined, true, 'the first call was a dictated edit, not the loop');
    for (const body of client.bodies) assert.doesNotMatch(JSON.stringify(body), new RegExp(key));
  });

  it('goes on to the loop when the request asks for more', async () => {
    const { client, session: s } = session([
      '```js\nconst TAX_RATE = 0.1;\n```',
      JSON.stringify({ thought: 'done', action: 'done', summary: 'Changed the rate; the test was not added.' }),
    ]);
    await s.run('In src/cart.js, change the tax rate to 10% and add a test for total().', { mode: 'agent' });
    assert.strictEqual(client.calls, 2);
    assert.ok(client.bodies[1].format, 'the second call was not the action loop');
    assert.match(JSON.stringify(client.bodies[1].messages), /That change was made from your request/);
  });

  it('places the edit by line, so a repeated line elsewhere is never the one changed', async () => {
    const { session: s } = session(['```js\nfunction removeItem(cart, id) {\n  return cart;\n}\n```']);
    await s.run('In src/cart.js, removeItem should return the cart unchanged instead of throwing.', { mode: 'agent' });
    const after = fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8');
    assert.ok(after.includes('function removeItem(cart, id) {\n  return cart;\n}'));
    // `return { ...cart, items };` also ends updateQuantity, and that one survives.
    assert.strictEqual(after.split('return { ...cart, items };').length - 1, 1);
    assert.ok(lineOf(after, 'function updateQuantity') > 0);
  });

  it('is not used on the native tier, in Plan mode, or for a file the request does not name', async () => {
    const tierA = session(['done'], { tier: 'A', strategy: 'native', canPlanTodos: false, params: 8 });
    tierA.client.chat = async function chat(body) {
      this.bodies.push(body);
      this.calls += 1;
      return { message: { content: 'Nothing to do.' } };
    };
    await tierA.session.run('In src/cart.js, change the tax rate from 8% to 10%.', { mode: 'agent' });
    assert.doesNotMatch(JSON.stringify(tierA.client.bodies), /Rewrite this line/, 'Tier A was dictated to');

    const plan = session([JSON.stringify({ thought: 't', action: 'done', summary: '1. Change TAX_RATE in src/cart.js' })]);
    await plan.session.run('In src/cart.js, change the tax rate from 8% to 10%.', { mode: 'plan' });
    assert.ok(plan.client.bodies[0].format, 'Plan mode was dictated to');

    const unnamed = session([JSON.stringify({ thought: 't', action: 'done', summary: 'ok' })]);
    await unnamed.session.run('Change the tax rate from 8% to 10%.', { mode: 'agent' });
    assert.ok(unnamed.client.bodies[0].format);
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8'), CART_JS);
  });

  it('adds a function and exports it in one edit, with the name added by the extension', async () => {
    const { session: s } = session(['```js\nfunction itemCount(cart) {\n  return cart.items.reduce((n, item) => n + item.quantity, 0);\n}\n```']);
    const result = await s.run(
      'Add a function itemCount(cart) to src/cart.js that returns the total quantity of all items, and export it.',
      { mode: 'agent' }
    );
    const file = path.join(root, 'src', 'cart.js');
    const cart = require(file);
    delete require.cache[require.resolve(file)];
    assert.strictEqual(cart.itemCount({ items: [{ quantity: 2 }, { quantity: 3 }] }), 5);
    assert.strictEqual(typeof cart.createCart, 'function', 'the rest of the module was lost');
    assert.match(result.summary, /added itemCount\(cart\)/);
  });

  it('names a dropped check, then asks only for the new lines when it is dropped again', async () => {
    // The measured failure, twice: the old check replaced instead of kept.
    const dropping =
      "```js\nfunction applyDiscount(cart, percent) {\n  if (typeof percent !== 'number' || percent > 50) {\n    throw new Error('x');\n  }\n  return { ...cart, discount: percent };\n}\n```";
    const { client, session: s } = session([dropping, dropping, "```js\nif (percent > 50) {\n  throw new Error('Too much.');\n}\n```"]);
    await s.run('In src/cart.js, make applyDiscount throw an Error when the percent is greater than 50.', { mode: 'agent' });
    const after = fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8');
    assert.ok(after.includes("typeof percent !== 'number' || percent < 0"), 'the existing check was lost');
    assert.ok(after.includes('function applyDiscount(cart, percent) {\n  if (percent > 50) {\n    throw'));
    assert.match(JSON.stringify(client.bodies[1].messages), /your rewrite removed \\"percent < 0\\"/);
    assert.match(JSON.stringify(client.bodies[2].messages), /first line of a function/);
  });

  it('refuses new lines at the top of a function that use what does not exist there', async () => {
    const dropping =
      "```js\nfunction removeItem(cart, id) {\n  if (product.stock < 1) {\n    return cart;\n  }\n  const items = cart.items.slice();\n  return { ...cart, items };\n}\n```";
    const { session: s } = session([
      dropping,
      dropping,
      '```js\nif (product.stock < 1) {\n  return cart;\n}\n```',
      JSON.stringify({ thought: 't', action: 'done', summary: 'could not' }),
    ]);
    await s.run('In src/cart.js, removeItem should do nothing when the product is out of stock.', { mode: 'agent' });
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8'), CART_JS);
  });

  it('never writes an action object into a file', async () => {
    const { session: s } = session([JSON.stringify({ thought: 't', action: 'edit_file', path: 'src/cart.js', find: 'a', replace: 'b' })]);
    await s.run('In src/cart.js, change the tax rate from 8% to 10%.', { mode: 'agent' });
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8'), CART_JS);
  });

  it('hands the loop the lines it found when the dictation does not work', async () => {
    const { client, session: s } = session([
      'I cannot do that.',
      'Still no.',
      'No.',
      JSON.stringify({ thought: 't', action: 'done', summary: 'gave up' }),
    ]);
    await s.run('In src/cart.js, change the tax rate from 8% to 10%.', { mode: 'agent' });
    assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'cart.js'), 'utf8'), CART_JS);
    assert.match(JSON.stringify(client.bodies[3].messages), /const TAX_RATE = 0\.08;/);
  });
});
