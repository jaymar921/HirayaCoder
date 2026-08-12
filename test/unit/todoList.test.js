'use strict';

const assert = require('assert');

const { TodoList, MIN_ITEMS, MAX_ITEMS } = require('../../app/agent/todoList');

describe('TodoList', () => {
  it('opens the first item and leaves the rest pending', () => {
    const todos = new TodoList(['Edit greet.js', 'Update README', 'Delete old file']);
    assert.strictEqual(todos.current().text, 'Edit greet.js');
    assert.strictEqual(todos.position(), 1);
    assert.deepStrictEqual(
      todos.items.map((i) => i.status),
      ['active', 'pending', 'pending']
    );
  });

  it('advances one item at a time', () => {
    const todos = new TodoList(['One', 'Two', 'Three']);
    const next = todos.finishCurrent('done', '', 4);

    assert.strictEqual(next.text, 'Two');
    assert.strictEqual(todos.items[0].status, 'done');
    assert.strictEqual(todos.items[0].steps, 4);
    assert.strictEqual(todos.position(), 2);
  });

  it('keeps going after an item fails', () => {
    // A failed item must not abandon the rest of the user's request.
    const todos = new TodoList(['One', 'Two']);
    const next = todos.finishCurrent('failed', 'stopped: repeating');

    assert.strictEqual(next.text, 'Two');
    assert.strictEqual(todos.items[0].status, 'failed');
  });

  it('reports completion only when nothing is left', () => {
    const todos = new TodoList(['One', 'Two']);
    assert.strictEqual(todos.isComplete(), false);
    todos.finishCurrent('done');
    assert.strictEqual(todos.isComplete(), false);
    assert.strictEqual(todos.finishCurrent('done'), null);
    assert.strictEqual(todos.isComplete(), true);
  });

  it('marks unreached items as skipped rather than done', () => {
    const todos = new TodoList(['One', 'Two', 'Three']);
    todos.finishCurrent('done');
    todos.skipRemaining('the session ran out of steps');

    assert.deepStrictEqual(
      todos.items.map((i) => i.status),
      ['done', 'skipped', 'skipped']
    );
    assert.match(todos.describe(), /not attempted \(the session ran out of steps\)/);
  });

  it('shows the model which single item to work on', () => {
    const todos = new TodoList(['One', 'Two']);
    todos.finishCurrent('done');

    const rendered = todos.render();
    assert.match(rendered, /\[x\] 1\. One/);
    assert.match(rendered, /\[>\] 2\. Two {3}<- do this one now/);
    assert.strictEqual((rendered.match(/do this one now/g) || []).length, 1);
  });

  it('is not worth keeping for a single item', () => {
    // One item is the task, not a list; running it through the TODO path would add
    // an inference call and a wrapper for nothing.
    assert.strictEqual(TodoList.isWorthKeeping(['Just one thing']), false);
    assert.strictEqual(TodoList.isWorthKeeping(['One', 'Two']), true);
    assert.strictEqual(TodoList.isWorthKeeping([]), false);
    assert.strictEqual(TodoList.isWorthKeeping(null), false);
    assert.strictEqual(MIN_ITEMS, 2);
  });

  it('caps a runaway list', () => {
    const todos = new TodoList(Array.from({ length: 20 }, (_, i) => `Item ${i}`));
    assert.strictEqual(todos.items.length, MAX_ITEMS);
  });

  it('counts progress by outcome', () => {
    const todos = new TodoList(['One', 'Two', 'Three']);
    todos.finishCurrent('done');
    todos.finishCurrent('failed');
    assert.deepStrictEqual(todos.progress(), { done: 1, failed: 1, skipped: 0, total: 3 });
  });
});
