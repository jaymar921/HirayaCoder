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

  it('records which files an item wrote, for the items that come after it', () => {
    // The checklist is the only thing that crosses between items, and "item 1 is done"
    // is not the fact item 6 needs — "item 1 wrote src/hooks/useTodos.js" is.
    const todos = new TodoList(['Create the hook', 'Assemble App.jsx']);
    todos.finishCurrent('done', '', 2, { changedPaths: ['src/hooks/useTodos.js'], attempts: 2 });

    assert.deepStrictEqual(todos.items[0].changedPaths, ['src/hooks/useTodos.js']);
    assert.strictEqual(todos.items[0].attempts, 2);
  });

  it('leaves changedPaths unset for an item that wrote nothing', () => {
    const todos = new TodoList(['One', 'Two']);
    todos.finishCurrent('failed', 'nothing was written', 1, { changedPaths: [] });
    assert.strictEqual(todos.items[0].changedPaths, undefined);
  });

  it('lists what has not been attempted, before it is skipped', () => {
    const todos = new TodoList(['One', 'Two', 'Three']);
    todos.finishCurrent('done');

    assert.deepStrictEqual(todos.remaining(), ['Three'], 'the active item was counted as unattempted');
    assert.deepStrictEqual(todos.remaining({ includeActive: true }), ['Two', 'Three']);

    todos.skipRemaining('an earlier step failed');
    assert.deepStrictEqual(todos.remaining(), [], 'skipped items still read as pending');
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
    assert.deepStrictEqual(todos.progress(), { done: 1, warned: 0, failed: 1, skipped: 0, total: 3 });
  });

  it('counts an item that landed without being closed off as completed', () => {
    const todos = new TodoList(['One', 'Two']);
    todos.finishCurrent('done-with-warning', 'changes landed, but the model never closed the item off');
    todos.finishCurrent('done');

    // The files changed, so the headline count says two. The caveat is carried
    // separately rather than by calling finished work incomplete.
    const progress = todos.progress();
    assert.strictEqual(progress.done, 2);
    assert.strictEqual(progress.warned, 1);
    assert.strictEqual(progress.failed, 0);
  });

  it('describes a caveated item distinctly from a clean one', () => {
    const todos = new TodoList(['One', 'Two']);
    todos.finishCurrent('done-with-warning', 'the model never closed the item off');
    todos.finishCurrent('done');

    const described = todos.describe();
    assert.match(described, /1\. One — done, with a caveat/);
    assert.match(described, /2\. Two — done$/m);
  });

  it('renders a caveated item as ticked, so the model does not redo it', () => {
    const todos = new TodoList(['One', 'Two']);
    todos.finishCurrent('done-with-warning');
    assert.match(todos.render(), /\[x\] 1\. One/);
  });
});

describe('TodoList — changed by the user mid-run', () => {
  it('adds an item after the one being worked on, not at the end', () => {
    // A step the current item turned out to need is a step the ones after it need too.
    const todos = new TodoList(['One', 'Two', 'Three']);
    assert.strictEqual(todos.insertAfterCurrent(['One and a half']), 1);

    assert.deepStrictEqual(
      todos.items.map((item) => item.text),
      ['One', 'One and a half', 'Two', 'Three']
    );
  });

  it('leaves the new item pending and the current one active', () => {
    const todos = new TodoList(['One', 'Two']);
    todos.insertAfterCurrent(['Extra']);
    assert.strictEqual(todos.current().text, 'One');
    assert.strictEqual(todos.items[1].status, 'pending');
  });

  it('refuses to push the list past the ceiling a small model can hold', () => {
    const todos = new TodoList(['1', '2', '3', '4', '5', '6']);
    assert.strictEqual(todos.insertAfterCurrent(['7']), 0);
    assert.strictEqual(todos.items.length, 6);
  });

  it('adds only as many as there is room for', () => {
    const todos = new TodoList(['1', '2', '3', '4', '5']);
    assert.strictEqual(todos.insertAfterCurrent(['6', '7', '8']), 1);
    assert.strictEqual(todos.items.length, 6);
  });

  it('rewords the active item and keeps what it was', () => {
    const todos = new TodoList(['Do the thing', 'Two']);
    assert.strictEqual(todos.replaceCurrent('Do the specific thing'), true);

    assert.strictEqual(todos.current().text, 'Do the specific thing');
    // The summary has to be able to say what it was, or a user cannot tell that their
    // answer is why it succeeded.
    assert.match(todos.describeChanges(), /Do the thing.*Do the specific thing/);
  });

  it('ignores a reword that changes nothing', () => {
    const todos = new TodoList(['One', 'Two']);
    assert.strictEqual(todos.replaceCurrent('One'), false);
    assert.strictEqual(todos.replaceCurrent('   '), false);
    assert.strictEqual(todos.changes.length, 0);
  });

  it('skips one item without giving up on the rest', () => {
    const todos = new TodoList(['One', 'Two', 'Three']);
    const next = todos.skipCurrent('you asked me to skip this one');

    assert.strictEqual(todos.items[0].status, 'skipped');
    assert.strictEqual(next.text, 'Two');
    assert.strictEqual(todos.items[2].status, 'pending', 'skipping one must not abandon the others');
  });

  it('says nothing about a list that ran as planned', () => {
    const todos = new TodoList(['One', 'Two']);
    todos.finishCurrent('done');
    assert.strictEqual(todos.describeChanges(), '');
  });

  it('reports every change it made, in order', () => {
    const todos = new TodoList(['One', 'Two']);
    todos.replaceCurrent('One, precisely');
    todos.insertAfterCurrent(['One and a half']);
    todos.skipCurrent('you asked me to skip this one');

    const described = todos.describeChanges();
    assert.match(described, /reworded/);
    assert.match(described, /Added at position 2: One and a half/);
    assert.match(described, /dropped/);
  });
});
