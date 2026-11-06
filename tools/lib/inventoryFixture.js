'use strict';

/**
 * The edit benchmark's held-out fixture: a Python module with a class, about 120 lines.
 *
 * Written after `cartFixture` had been used to tune `core/editRegion`, and deliberately
 * not tuned against: its tasks exist to say whether what worked on the cart generalises
 * to another language, another shape of file, and requests worded differently. Results on
 * it are reported as they come out.
 *
 * @module tools/lib/inventoryFixture
 */

const INVENTORY_PY = `"""A small stock-keeping module for a shop."""

import json

LOW_STOCK_THRESHOLD = 5
CURRENCY = "PHP"


class Product:
    """One kind of thing the shop sells."""

    def __init__(self, sku, name, price, stock=0):
        self.sku = sku
        self.name = name
        self.price = price
        self.stock = stock

    def to_dict(self):
        return {"sku": self.sku, "name": self.name, "price": self.price, "stock": self.stock}


class Inventory:
    """Every product the shop has, by SKU."""

    def __init__(self):
        self.products = {}

    def add_product(self, product):
        if product.sku in self.products:
            raise ValueError(f"{product.sku} is already in the inventory")
        if product.price < 0:
            raise ValueError("price cannot be negative")
        self.products[product.sku] = product
        return product

    def remove_product(self, sku):
        if sku not in self.products:
            raise KeyError(sku)
        return self.products.pop(sku)

    def restock(self, sku, quantity):
        if quantity <= 0:
            raise ValueError("restock quantity must be positive")
        product = self.products[sku]
        product.stock += quantity
        return product.stock

    def sell(self, sku, quantity):
        if quantity <= 0:
            raise ValueError("sale quantity must be positive")
        product = self.products[sku]
        product.stock -= quantity
        return product.price * quantity

    def low_stock(self):
        return [p for p in self.products.values() if p.stock < LOW_STOCK_THRESHOLD]

    def total_value(self):
        return sum(p.price * p.stock for p in self.products.values())

    def to_json(self):
        return json.dumps([p.to_dict() for p in self.products.values()])

    @staticmethod
    def from_json(text):
        inventory = Inventory()
        for item in json.loads(text):
            inventory.add_product(Product(item["sku"], item["name"], item["price"], item["stock"]))
        return inventory


def format_price(amount):
    """Format an amount for a receipt, e.g. 12.5 becomes "PHP 12.50"."""
    return f"{CURRENCY} {amount:.2f}"
`;

/**
 * Checks run with `python -c` against the edited module. `inv()` builds a fresh inventory
 * with two products; `ok(x)` raises on a false value; `raises(E, f)` asserts an exception.
 */
const PRELUDE = `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("inventory", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def ok(v, n=[0]):
    n[0] += 1
    if not v: raise AssertionError("assertion %d failed" % n[0])
def raises(E, f):
    try: f()
    except E: return True
    return False
def inv():
    i = m.Inventory()
    i.add_product(m.Product("a", "Pen", 10.0, 3))
    i.add_product(m.Product("b", "Pad", 5.0, 20))
    return i
`;

const CHECKS = {
  addProduct: `i = inv(); ok(len(i.products) == 2); ok(raises(ValueError, lambda: i.add_product(m.Product("a", "x", 1.0))))`,
  negativePrice: `ok(raises(ValueError, lambda: inv().add_product(m.Product("c", "x", -1.0))))`,
  removeMissingRaises: `ok(raises(KeyError, lambda: inv().remove_product("zz")))`,
  remove: `i = inv(); ok(i.remove_product("a").sku == "a"); ok(len(i.products) == 1)`,
  restock: `i = inv(); ok(i.restock("a", 2) == 5); ok(raises(ValueError, lambda: i.restock("a", 0)))`,
  sell: `i = inv(); ok(i.sell("b", 4) == 20.0); ok(i.products["b"].stock == 16); ok(raises(ValueError, lambda: i.sell("b", 0)))`,
  sellAllowsOversell: `i = inv(); i.sell("a", 5); ok(i.products["a"].stock == -2)`,
  lowStock5: `ok([p.sku for p in inv().low_stock()] == ["a"])`,
  totalValue: `ok(inv().total_value() == 130.0)`,
  json: `i = m.Inventory.from_json(inv().to_json()); ok(i.products["b"].stock == 20)`,
  formatPrice: `ok(m.format_price(12.5) == "PHP 12.50")`,
};

const TASKS = {
  'py-threshold': {
    prompt: 'In inventory.py, raise the low stock threshold from 5 to 10.',
    target: `i = inv(); i.products["b"].stock = 7; ok(sorted(p.sku for p in i.low_stock()) == ["a", "b"])`,
    replaces: ['lowStock5'],
  },
  'py-oversell': {
    prompt: 'In inventory.py, sell should raise a ValueError when the quantity is more than the product has in stock.',
    target: `i = inv(); ok(raises(ValueError, lambda: i.sell("a", 5))); ok(i.products["a"].stock == 3); ok(i.sell("a", 3) == 30.0)`,
    replaces: ['sellAllowsOversell'],
  },
  'py-remove': {
    prompt: 'In inventory.py, make remove_product return None instead of raising KeyError when the sku is not there.',
    target: `ok(inv().remove_product("zz") is None)`,
    replaces: ['removeMissingRaises'],
  },
  'py-method': {
    prompt: 'Add a method count_products(self) to the Inventory class in inventory.py that returns how many different products there are.',
    target: `ok(inv().count_products() == 2)`,
    replaces: [],
  },
};

/** Hand-made answers, so the grader is checked before any model is graded by it. */
const CORRECT = {
  'py-threshold': (text) => text.replace('LOW_STOCK_THRESHOLD = 5', 'LOW_STOCK_THRESHOLD = 10'),
  'py-oversell': (text) =>
    text.replace(
      '        product = self.products[sku]\n        product.stock -= quantity',
      '        product = self.products[sku]\n        if quantity > product.stock:\n            raise ValueError("not enough stock")\n        product.stock -= quantity'
    ),
  'py-remove': (text) => text.replace('            raise KeyError(sku)', '            return None'),
  'py-method': (text) =>
    text.replace('    def to_json(self):', '    def count_products(self):\n        return len(self.products)\n\n    def to_json(self):'),
};

module.exports = { INVENTORY_PY, PRELUDE, CHECKS, TASKS, CORRECT };
