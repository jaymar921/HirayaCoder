'use strict';

/**
 * What a file offers, with arguments, and what an edit changed. Both end up in the
 * prompt as memory, so what matters is that they are right where they speak and silent
 * where they cannot tell.
 */

const assert = require('assert');

const codeShape = require('../../app/core/codeShape');
const { CART_JS } = require('../../tools/lib/cartFixture');

describe('codeShape', () => {
  describe('shapeOf / describe', () => {
    it('reads CommonJS exports with their arguments', () => {
      // The benchmark fixture. `dictation.exportsOf` found nothing in it at all.
      const text = codeShape.describe(CART_JS, 'src/cart.js');
      assert.match(text, /^createCart\(\), addItem\(cart, product, quantity = 1\), removeItem\(cart, id\)/);
      assert.match(text, /deserialize\(text\)/);
    });

    it('reads ES module exports, including props, defaults and renames', () => {
      const source = [
        "import { useState } from 'react';",
        'export default function TodoItem({ todo, onToggle, onDelete }) {',
        '  return null;',
        '}',
        'export const useTodos = (initial = []) => {',
        '  return { todos: initial };',
        '};',
        'const helper = x => x * 2;',
        'export { helper as double };',
        'export class Store {}',
      ].join('\n');
      const names = codeShape.shapeOf(source, 'src/TodoItem.jsx').map((item) => item.signature);
      assert.ok(names.includes('TodoItem({ todo, onToggle, onDelete })'), names.join(' | '));
      assert.ok(names.includes('useTodos(initial = [])'));
      assert.ok(names.includes('double(x)'), 'the rename was shown under its local name');
      assert.ok(names.includes('class Store'));
      assert.match(codeShape.describe(source, 'src/TodoItem.jsx'), /default TodoItem/);
    });

    it('reads exports.name assignments', () => {
      const source = 'exports.add = function (a, b) { return a + b; };\nexports.VERSION = "1";\n';
      const names = codeShape.shapeOf(source, 'lib.js').map((item) => item.signature);
      assert.deepStrictEqual(names, ['add(a, b)', 'VERSION']);
    });

    it('reads a Python module: functions, a class, and its public methods without self', () => {
      const source = [
        'class ProductService:',
        '    def __init__(self, repo, tax_rate=0.1):',
        '        self.repo = repo',
        '    def add(self, name: str, price: float) -> dict:',
        '        pass',
        '    def _private(self):',
        '        pass',
        'def main(argv=None):',
        '    pass',
        'def _hidden():',
        '    pass',
      ].join('\n');
      assert.strictEqual(
        codeShape.describe(source, 'pos/product_service.py'),
        'class ProductService, ProductService(repo, tax_rate=0.1), ProductService.add(name: str, price: float), main(argv=None)'
      );
    });

    it('respects a Python __all__', () => {
      const source = '__all__ = ["public"]\ndef public():\n    pass\ndef also_public_looking():\n    pass\n';
      assert.strictEqual(codeShape.describe(source, 'm.py'), 'public()');
    });

    it('reads a Java type, its public methods and constructors', () => {
      const source = [
        'package com.pos;',
        'public class CartService {',
        '    public CartService(Repository repo) { }',
        '    public void addItem(String sku, int quantity) { }',
        '    private int secret() { return 1; }',
        '}',
      ].join('\n');
      const text = codeShape.describe(source, 'src/main/java/com/pos/CartService.java');
      assert.match(text, /class CartService/);
      assert.match(text, /addItem\(String sku, int quantity\): void/);
      assert.match(text, /new CartService\(Repository repo\)/);
      assert.doesNotMatch(text, /secret/);
    });

    it('says nothing about a language it does not read', () => {
      assert.strictEqual(codeShape.describe('body { color: red }', 'style.css'), '');
      assert.strictEqual(codeShape.describe('# Title', 'README.md'), '');
    });

    it('counts what it does not name', () => {
      const source = Array.from({ length: 20 }, (_, i) => `function f${i}() {}`).join('\n') +
        `\nmodule.exports = { ${Array.from({ length: 20 }, (_, i) => `f${i}`).join(', ')} };\n`;
      assert.match(codeShape.describe(source, 'many.js', { maxItems: 5 }), /, and 15 more$/);
    });
  });

  describe('describeChange', () => {
    const edit = (from, to) => codeShape.describeChange(CART_JS, CART_JS.replace(from, to), 'src/cart.js');

    it('quotes a one-line change both ways', () => {
      assert.strictEqual(
        edit('TAX_RATE = 0.08', 'TAX_RATE = 0.1'),
        '"const TAX_RATE = 0.08;" became "const TAX_RATE = 0.1;"'
      );
    });

    it('names the definition a changed line sits in', () => {
      assert.match(edit('throw new Error(`No item with id ${id} in the cart.`);', 'return cart;'), / in removeItem$/);
    });

    it('never quotes in backticks, which memory would read as a command', () => {
      // memoryStore.subjectOf files a note under the first backticked span it finds.
      const described = edit('throw new Error(`No item with id ${id} in the cart.`);', 'return cart;');
      assert.ok(!described.includes('`'), described);
    });

    it('reports definitions added, removed, and given new arguments', () => {
      assert.strictEqual(
        edit('module.exports = {', 'function itemCount(cart) {\n  return 0;\n}\n\nmodule.exports = {\n  itemCount,'),
        'added itemCount(cart)'
      );
      assert.strictEqual(
        edit('function removeItem(cart, id)', 'function removeItem(cart, id, silent = false)'),
        'removeItem(cart, id, silent = false) now takes different arguments'
      );
      assert.match(edit('  serialize,\n', ''), /^removed serialize/);
    });

    it('describes a new file by what it provides', () => {
      assert.match(codeShape.describeChange(null, CART_JS, 'src/cart.js'), /^provides createCart\(\), addItem/);
    });

    it('stays silent rather than guess', () => {
      assert.strictEqual(codeShape.describeChange(CART_JS, CART_JS, 'src/cart.js'), null);
      assert.strictEqual(codeShape.describeChange('a', 'b', 'notes.txt'), null);
    });
  });

  describe('on hostile input', () => {
    // Every expression here runs over whatever the model wrote. Measured, not assumed:
    // see SAST-014 for what an unbounded one cost.
    const hostile = [
      'a'.repeat(200000),
      ' '.repeat(200000) + 'x',
      `const ${'a'.repeat(100000)} = ${'b'.repeat(100000)}`,
      `export {${'a,'.repeat(50000)}`,
      `function f${'('.repeat(100000)}`,
      `def ${'a'.repeat(100000)}(${'x'.repeat(100000)}`,
      `  public ${'A'.repeat(100000)} ${'b'.repeat(100000)}`,
      `exports.${'a'.repeat(100000)} = function ${'b'.repeat(100000)}`,
    ];

    for (const file of ['x.js', 'x.py', 'X.java']) {
      it(`stays fast in ${file}`, () => {
        const started = Date.now();
        for (const text of hostile) {
          codeShape.describe(text, file);
          codeShape.describeChange(text, `${text}\nx`, file);
        }
        assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
      });
    }
  });
});
