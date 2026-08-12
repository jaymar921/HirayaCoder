'use strict';

/**
 * The TODO planner's filter.
 *
 * `TODO_PROMPT` asks for one item per deliverable and gives "Read the file" as the
 * counter-example. Models ignore it — measured on the one-file benchmark task, both
 * `qwen3.5:2b` and `gemma4:e2b` returned three or four items to make one edit. These
 * tests are written from those two real replies.
 */

const assert = require('assert');

const { dropNonDeliverables, planTodos } = require('../../app/agent/plannerAgent');

/** A mock Ollama that returns one scripted list. */
function clientReturning(content) {
  return {
    bodies: /** @type {any[]} */ ([]),
    async chat(body) {
      this.bodies.push(body);
      return { message: { content } };
    },
  };
}

describe('plannerAgent.dropNonDeliverables', () => {
  const TASK = 'Update the greet function in src/greet.js so that an empty name returns "Hello there".';

  it('drops an item that can only read', () => {
    assert.deepStrictEqual(dropNonDeliverables(['Read src/greet.js', 'Update the greet function'], TASK), [
      'Update the greet function',
    ]);
  });

  it('drops the openers and savers a planner wraps around one edit', () => {
    // qwen3.5:2b and gemma4:e2b, verbatim, on the single-file benchmark task.
    const observed = [
      'Open src/greet.js.',
      'Update the greet function to handle an empty name.',
      'Ensure the function returns "Hello there" for an empty name.',
      'Save changes to src/greet.js.',
    ];

    assert.deepStrictEqual(dropNonDeliverables(observed, TASK), [
      'Update the greet function to handle an empty name.',
    ]);
  });

  it('drops a verification item the request never asked for', () => {
    const items = ['Update greet function', 'Verify updated behavior in browser or test runner'];
    assert.deepStrictEqual(dropNonDeliverables(items, TASK), ['Update greet function']);
  });

  it('keeps a verification item when the request asked for one', () => {
    const task = 'Update the greet function and make sure the tests still pass.';
    const items = ['Update the greet function', 'Run the test suite and confirm it passes'];
    assert.deepStrictEqual(dropNonDeliverables(items, task), items);
  });

  it('keeps every part of a genuinely multi-part request', () => {
    const task =
      'The greet function should also handle an empty name. Update it, add a short note ' +
      'to README.md, and delete the obsolete file.';
    const items = [
      'Update src/greet.js to return "Hello there" for an empty name',
      'Add a note about it to README.md',
      'Delete src/obsolete.js',
    ];
    assert.deepStrictEqual(dropNonDeliverables(items, task), items);
  });

  it('does not mistake real work for inspection because of its first word', () => {
    // The verbs only mean "look at it" at the start of a TODO item; these are
    // deliverables and dropping them would be obstruction.
    const items = [
      'Open a websocket connection in src/client.js',
      'Save the parsed report to reports/output.json',
      'Check-in workflow: add the missing validation to src/checkin.js',
    ];
    assert.deepStrictEqual(dropNonDeliverables(items, 'Build the reporting pipeline'), items);
  });

  it('keeps a verification-sounding item that names a file the request mentions', () => {
    // "Ensure README.md mentions it" is plausibly one of the parts the user asked for.
    // Dropping it would mean that work silently never happens, which is far worse than
    // running one wasted loop.
    const items = ['Update src/greet.js for an empty name', 'Ensure README.md mentions the new behaviour'];
    assert.deepStrictEqual(dropNonDeliverables(items, 'Update greet and note it in the README'), items);
  });

  it('drops a check against a file the planner brought up on its own', () => {
    // qwen3.5:2b, verbatim, on the single-file task — obsolete.js is nowhere in the
    // request. It cost a whole loop and came back as a failed item.
    const items = [
      'Update src/greet.js so that greet(\'\') returns "Hello there".',
      'Check if obsolete.js is still needed after this change.',
      'Run tests to ensure no existing functionality was broken by the update.',
    ];
    assert.deepStrictEqual(dropNonDeliverables(items, TASK), [
      'Update src/greet.js so that greet(\'\') returns "Hello there".',
    ]);
  });

  it('matches a file the request names only in prose', () => {
    // The request says "the obsolete file"; the plan says `src/obsolete.js`.
    const task = 'Update greet, note it in README.md, and delete the obsolete file.';
    const items = ['Update src/greet.js', 'Confirm src/obsolete.js is gone'];
    assert.deepStrictEqual(dropNonDeliverables(items, task), items);
  });

  it('drops an item that only creates folders, which no tool can do and none needs to', () => {
    // ornith:9b, verbatim, on a plain-Java task. The first item burned three loops on
    // refused `mkdir` calls and was reported as failed — while the second and third
    // items created `src/main/java` on their way to writing the files.
    const task = 'Create a simple Java TODO application with src/main/java and build folders.';
    const items = [
      'Create project directory structure (src/main/java and build folders)',
      'Implement TodoManager.java with ArrayList-based TODO storage',
      'Implement TodoApp.java with console text menu interface',
    ];
    assert.deepStrictEqual(dropNonDeliverables(items, task), [
      'Implement TodoManager.java with ArrayList-based TODO storage',
      'Implement TodoApp.java with console text menu interface',
    ]);
  });

  it('keeps a folder item that also delivers a file', () => {
    // The folder is incidental; the file is the work, and write_file makes both.
    const task = 'Add a config directory with default settings.';
    const items = ['Create the config directory with config/settings.json'];
    assert.deepStrictEqual(dropNonDeliverables(items, task), items);
  });

  it('keeps real work that merely mentions a directory', () => {
    const task = 'Make the build output configurable.';
    const items = ['Make the output directory configurable via a CLI flag'];
    assert.deepStrictEqual(dropNonDeliverables(items, task), items);
  });

  it('leaves an empty list empty rather than inventing one', () => {
    assert.deepStrictEqual(dropNonDeliverables([], TASK), []);
  });
});

describe('plannerAgent.planTodos', () => {
  it('filters what the model proposed before returning it', async () => {
    const client = clientReturning('1. Read src/greet.js\n2. Update the greet function\n3. Verify it works');
    const items = await planTodos({
      client,
      model: 'qwen3.5:2b',
      task: 'Update the greet function so an empty name returns "Hello there".',
    });

    // One deliverable left, which is below the two-item floor — so the caller runs the
    // task as a single pass instead of three loops over one edit.
    assert.deepStrictEqual(items, ['Update the greet function']);
  });

  it('never turns on the model\'s own thinking mode', async () => {
    // A hybrid model with `think: true` spends the whole budget reasoning and returns
    // empty content, which silently disables the feature. This has broken twice.
    const client = clientReturning('1. Update a.js\n2. Update b.js');
    await planTodos({ client, model: 'qwen3.5:2b', task: 'Update a and b' });
    assert.strictEqual(client.bodies[0].think, false);
  });

  it('returns nothing when the model reasons instead of replying', async () => {
    const client = {
      async chat() {
        return { message: { content: '', thinking: 'a very long deliberation'.repeat(50) } };
      },
    };
    assert.deepStrictEqual(await planTodos({ client, model: 'qwen3.5:2b', task: 'Update a and b' }), []);
  });
});
