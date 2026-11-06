'use strict';

/**
 * The edit benchmark's fixture: an ordinary CommonJS module of about 150 lines.
 *
 * Kept on its own so the unit tests that pin `core/codeShape` read exactly the file the
 * benchmark grades against.
 *
 * @module tools/lib/cartFixture
 */

/** Long enough that retyping it is a real job, ordinary enough to be typical. */
const CART_JS = `'use strict';

/**
 * A small shopping cart. Every function returns a new cart rather than changing the one
 * it was given, so callers can keep the previous state for undo.
 */

const TAX_RATE = 0.08;
const MAX_QUANTITY = 99;

/**
 * @returns {{items: Array<{id: string, name: string, price: number, quantity: number}>, discount: number}}
 */
function createCart() {
  return { items: [], discount: 0 };
}

/**
 * Add an item, or raise its quantity if it is already in the cart.
 *
 * @param {object} cart
 * @param {{id: string, name: string, price: number}} product
 * @param {number} [quantity]
 */
function addItem(cart, product, quantity = 1) {
  if (!product || typeof product.id !== 'string') {
    throw new Error('A product needs an id.');
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new Error('Quantity must be a whole number of at least 1.');
  }
  const existing = cart.items.find((item) => item.id === product.id);
  if (existing) {
    return updateQuantity(cart, product.id, existing.quantity + quantity);
  }
  const item = { id: product.id, name: product.name, price: product.price, quantity };
  return { ...cart, items: [...cart.items, item] };
}

/**
 * Remove an item entirely.
 *
 * @param {object} cart
 * @param {string} id
 */
function removeItem(cart, id) {
  const index = cart.items.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new Error(\`No item with id \${id} in the cart.\`);
  }
  const items = cart.items.slice();
  items.splice(index, 1);
  return { ...cart, items };
}

/**
 * Set the quantity of an item. Zero removes it.
 *
 * @param {object} cart
 * @param {string} id
 * @param {number} quantity
 */
function updateQuantity(cart, id, quantity) {
  if (quantity === 0) {
    return removeItem(cart, id);
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new Error('Quantity must be a whole number.');
  }
  const capped = Math.min(quantity, MAX_QUANTITY);
  const items = cart.items.map((item) => (item.id === id ? { ...item, quantity: capped } : item));
  return { ...cart, items };
}

/**
 * Sum of price times quantity, before discount and tax.
 *
 * @param {object} cart
 * @returns {number}
 */
function subtotal(cart) {
  return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

/**
 * Apply a percentage discount to the whole cart.
 *
 * @param {object} cart
 * @param {number} percent
 */
function applyDiscount(cart, percent) {
  if (typeof percent !== 'number' || percent < 0) {
    throw new Error('Discount must be a positive number.');
  }
  return { ...cart, discount: percent };
}

/**
 * Tax on the discounted subtotal.
 *
 * @param {object} cart
 * @returns {number}
 */
function tax(cart) {
  const discounted = subtotal(cart) * (1 - cart.discount / 100);
  return discounted * TAX_RATE;
}

/**
 * What the customer pays.
 *
 * @param {object} cart
 * @returns {number}
 */
function total(cart) {
  const discounted = subtotal(cart) * (1 - cart.discount / 100);
  return Math.round((discounted + tax(cart)) * 100) / 100;
}

/**
 * Format an amount for display, e.g. 12.5 becomes "$12.50".
 *
 * @param {number} amount
 * @returns {string}
 */
function formatMoney(amount) {
  return \`$\${amount.toFixed(2)}\`;
}

/**
 * @param {object} cart
 * @returns {string}
 */
function serialize(cart) {
  return JSON.stringify(cart);
}

/**
 * @param {string} text
 * @returns {object}
 */
function deserialize(text) {
  const parsed = JSON.parse(text);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('Not a saved cart.');
  }
  return { items: parsed.items, discount: Number(parsed.discount) || 0 };
}

module.exports = {
  createCart,
  addItem,
  removeItem,
  updateQuantity,
  subtotal,
  applyDiscount,
  tax,
  total,
  formatMoney,
  serialize,
  deserialize,
};
`;

/** Run before each check, with the edited file's path as the first argument. */
const PRELUDE = `
const m = require(process.argv[1]);
const P1 = { id: 'a', name: 'Pen', price: 10 };
const P2 = { id: 'b', name: 'Pad', price: 5 };
let n = 0;
function ok(v) { n += 1; if (!v) throw new Error('assertion ' + n + ' failed'); }
`;

/**
 * The checks, run in a child process against the edited module. A task's `replaces` names
 * the checks it is allowed to change: a task that changes the tax rate may change `total`
 * and nothing else.
 */
const CHECKS = {
  createCart: `const c = m.createCart(); ok(Array.isArray(c.items) && c.items.length === 0 && c.discount === 0);`,
  addItem: `let c = m.addItem(m.createCart(), P1, 2); c = m.addItem(c, P1, 1); ok(c.items.length === 1 && c.items[0].quantity === 3);
    let threw = false; try { m.addItem(m.createCart(), P1, 0); } catch { threw = true; } ok(threw);`,
  removeItem: `let c = m.addItem(m.addItem(m.createCart(), P1), P2); c = m.removeItem(c, 'a'); ok(c.items.length === 1 && c.items[0].id === 'b');`,
  removeMissingThrows: `let threw = false; try { m.removeItem(m.createCart(), 'zz'); } catch { threw = true; } ok(threw);`,
  updateQuantity: `let c = m.addItem(m.createCart(), P1); ok(m.updateQuantity(c, 'a', 500).items[0].quantity === 99); ok(m.updateQuantity(c, 'a', 0).items.length === 0);`,
  subtotal: `const c = m.addItem(m.addItem(m.createCart(), P1, 2), P2, 1); ok(Math.abs(m.subtotal(c) - 25) < 1e-9);`,
  applyDiscount: `const c = m.applyDiscount(m.createCart(), 20); ok(c.discount === 20); let threw = false; try { m.applyDiscount(c, -1); } catch { threw = true; } ok(threw);`,
  discountAbove50Allowed: `ok(m.applyDiscount(m.createCart(), 60).discount === 60);`,
  total8: `const c = m.addItem(m.createCart(), P1, 10); ok(m.total(c) === 108);`,
  formatMoney: `ok(m.formatMoney(12.5) === '$12.50');`,
  serialize: `const c = m.addItem(m.createCart(), P1, 2); const back = m.deserialize(m.serialize(c)); ok(back.items[0].quantity === 2 && back.discount === 0);`,
};

const TASKS = {
  tax: {
    prompt: 'In src/cart.js, change the tax rate from 8% to 10%.',
    target: `const c = m.addItem(m.createCart(), P1, 10); ok(m.total(c) === 110);`,
    replaces: ['total8'],
  },
  missing: {
    prompt:
      'In src/cart.js, removeItem throws an error when the id is not in the cart. ' +
      'Change it so it returns the cart unchanged instead of throwing.',
    target: `const c = m.addItem(m.createCart(), P1); const after = m.removeItem(c, 'zz'); ok(after.items.length === 1 && after.items[0].id === 'a');`,
    replaces: ['removeMissingThrows'],
  },
  discount: {
    prompt: 'In src/cart.js, make applyDiscount throw an Error when the percent is greater than 50.',
    target: `let threw = false; try { m.applyDiscount(m.createCart(), 60); } catch { threw = true; } ok(threw); ok(m.applyDiscount(m.createCart(), 50).discount === 50);`,
    replaces: ['discountAbove50Allowed'],
  },
  count: {
    prompt:
      'Add a function itemCount(cart) to src/cart.js that returns the total quantity of all items in the cart, ' +
      'and export it alongside the others.',
    target: `const c = m.addItem(m.addItem(m.createCart(), P1, 2), P2, 3); ok(typeof m.itemCount === 'function' && m.itemCount(c) === 5);`,
    replaces: [],
  },
};

/** Hand-made answers, so the grader is checked before any model is graded by it. */
const CORRECT = {
  tax: (text) => text.replace('TAX_RATE = 0.08', 'TAX_RATE = 0.1'),
  missing: (text) => text.replace(/throw new Error\(`No item with id \$\{id\} in the cart\.`\);/, 'return cart;'),
  discount: (text) =>
    text.replace(
      "throw new Error('Discount must be a positive number.');\n  }",
      "throw new Error('Discount must be a positive number.');\n  }\n  if (percent > 50) {\n    throw new Error('Too much.');\n  }"
    ),
  count: (text) =>
    text.replace(
      'module.exports = {',
      'function itemCount(cart) {\n  return cart.items.reduce((n, item) => n + item.quantity, 0);\n}\n\nmodule.exports = {\n  itemCount,'
    ),
};

module.exports = { CART_JS, PRELUDE, CHECKS, TASKS, CORRECT };
