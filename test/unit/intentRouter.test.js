'use strict';

/**
 * Chat versus task.
 *
 * The asymmetry this file mostly asserts: being wrong toward `task` costs one loop that
 * reads a file and answers, which is what happened to every message before 0.4.0. Being
 * wrong toward `chat` costs the user a request that was silently not carried out. So
 * the cases that matter most here are the ones where a greeting has work attached.
 */

const assert = require('assert');

const { classify, requiresChange } = require('../../app/core/intentRouter');

/** @param {string} text */
const intentOf = (text) => classify(text).intent;

describe('intentRouter.classify', () => {
  describe('conversation', () => {
    it('recognises greetings, including Tagalog', () => {
      for (const text of ['hi', 'hello', 'hey there', 'yo', 'good morning', 'kumusta', 'kamusta ka']) {
        assert.strictEqual(intentOf(text), 'chat', `"${text}" was treated as work`);
      }
    });

    it('recognises pleasantries', () => {
      for (const text of ['thanks', 'thank you', 'salamat po', 'thanks a lot', 'cool', 'nice one', 'bye']) {
        assert.strictEqual(intentOf(text), 'chat', `"${text}" was treated as work`);
      }
    });

    it('recognises questions about the assistant', () => {
      // Every one of these was answered with a read_file loop in the evaluation
      // sessions, because Agent mode's grammar has no branch for an answer.
      for (const text of [
        'what model are you',
        'what llm model are you?',
        'who are you',
        'which model is this',
        'you are deepseek-coder-v2:latest',
      ]) {
        assert.strictEqual(intentOf(text), 'chat', `"${text}" was treated as work`);
      }
    });

    it('recognises questions about the conversation', () => {
      for (const text of [
        'can you remember our first conversation?',
        'do you remember what we were doing',
        'what did I ask you earlier',
        'our previous conversation',
      ]) {
        assert.strictEqual(intentOf(text), 'chat', `"${text}" was treated as work`);
      }
    });
  });

  describe('work', () => {
    it('treats an instruction as work', () => {
      for (const text of [
        'create a java todo app',
        'convert the python todo app to html',
        'fix the bug',
        'remove the java source codes',
        'proceed',
      ]) {
        assert.strictEqual(intentOf(text), 'task', `"${text}" was treated as conversation`);
      }
    });

    it('lets an instruction override a greeting that precedes it', () => {
      // The failure this must never have: dropping a request because it was polite.
      assert.strictEqual(intentOf('hi, can you add a delete button to todoapp.html'), 'task');
      assert.strictEqual(intentOf('thanks! now fix the modify function'), 'task');
      assert.strictEqual(intentOf('good morning — please compile the project'), 'task');
    });

    it('treats a bare filename as work', () => {
      assert.strictEqual(intentOf('todoapp.html'), 'task');
      assert.strictEqual(intentOf('src/todo_manager.py'), 'task');
    });

    it('falls back to work when there is no conversational signal', () => {
      assert.strictEqual(intentOf('the delete feature is broken'), 'task');
      assert.strictEqual(intentOf(''), 'task');
    });

    it('does not read a long message as a pleasantry because it opens with one', () => {
      const long = 'ok so the next thing is that the priority field needs to persist between sessions somehow';
      assert.strictEqual(intentOf(long), 'task');
    });

    it('does not read a pleasantry prefix as the whole message', () => {
      // The regression, verbatim. `"okay proceed"` matched a pleasantry at the start and
      // was under the old six-word cap, so it went to chat — where the model had no
      // tools, replied with the complete HTML in a code fence, and wrote "Saved to
      // todoapp.html." Nothing was saved, and the user asked three more times.
      assert.strictEqual(intentOf('okay proceed'), 'task');
      assert.strictEqual(intentOf('okay, proceed'), 'task');
      assert.strictEqual(intentOf('thanks, now the other file'), 'task');
      assert.strictEqual(intentOf('cool do the same for python'), 'task');
    });

    it('answers "how are you" instead of reading the project', () => {
      // Sent to the agent, which read two source files and reported on them. The user's
      // next message was "why are you reading the files, i just asked how are you".
      for (const text of ['how are you', "how's it going", 'what\'s up', 'kumusta ka']) {
        assert.strictEqual(intentOf(text), 'chat', `"${text}" was treated as work`);
      }
    });

    it('answers a greeting that has a name on it', () => {
      // "gemma4" is in no vocabulary and never could be — it is whatever the user has
      // installed. The model replied by asking for "the full task description".
      assert.strictEqual(intentOf('hello gemma4'), 'chat');
      assert.strictEqual(intentOf('hi claude'), 'chat');
    });

    it('answers a question about where the work has got to', () => {
      // These contain a word from WORK_VERB — "verify" — and used to be claimed by it,
      // so the agent re-read the same file until the repeat guard stopped it. Twice:
      // the user rephrased, and the rephrasing contained "created".
      for (const text of [
        'can you verify our conversation, where are we currently right now?',
        'what is the state',
        'where did we leave off',
        'can you give me a recap',
        'on this session, what is my initial conversation',
      ]) {
        assert.strictEqual(intentOf(text), 'chat', `"${text}" was treated as work`);
      }
    });

    it('takes assent plus a pleasantry as an acknowledgement', () => {
      // The first fix over-corrected: excluding assent words outright made any message
      // containing one a task, so "okay thank you" ran a four-item TODO list that
      // re-analysed five files, and "it's okay" spent its budget on refused commands.
      for (const text of ['okay thank you', 'okay, thank you again', "it's okay", 'ok cool thanks']) {
        assert.strictEqual(intentOf(text), 'chat', `"${text}" was treated as work`);
      }
    });

    it('treats bare assent as work, never as small talk', () => {
      // Every one of these routinely means "carry on with what I just asked for", and
      // answering one conversationally drops the request. Routing them to the agent
      // costs a loop — and since the conversation is in its context, the loop can see
      // what it is being told to carry on with.
      for (const text of ['ok', 'okay', 'sure', 'yes', 'yeah', 'alright', 'go ahead', 'proceed']) {
        assert.strictEqual(intentOf(text), 'task', `"${text}" was treated as small talk`);
      }
    });
  });

  it('explains itself, for the log', () => {
    assert.match(classify('hello').reason, /pleasantries/);
    assert.match(classify('fix it').reason, /asks for a change/);
    assert.match(classify('read src/app.js').reason, /instruction|file/);
  });

  describe('requiresChange', () => {
    it('holds a plain instruction to a change on disk', () => {
      for (const text of ['add a dark mode toggle', 'fix the bug in app.js', 'delete src/old.js']) {
        assert.strictEqual(requiresChange(text), true, `"${text}" was treated as finishable without a change`);
      }
    });

    it('lets a request to look, check, or explain finish having written nothing', () => {
      for (const text of ['explain the auth flow', 'check whether the tests pass', 'review src/app.js']) {
        assert.strictEqual(requiresChange(text), false, `"${text}" was required to change a file`);
      }
    });

    describe('a TODO item the planner wrote', () => {
      it('counts the vocabulary a planner uses to describe producing a file', () => {
        // qwen3.5:4b's own items on the React benchmark. Neither verb was recognised, so
        // both were reported `done (no files changed)` — including the one whose entire
        // job was App.jsx, which ended the run holding Vite's counter demo.
        const items = [
          'Assemble App.jsx layout with glassmorphism styling, floating circles, and responsive design',
          'Configure exact folder structure including components, hooks, assets, and config files',
          'Wire up TodoList to the useTodos hook',
          'Style the glass panel with Tailwind utilities',
          'Persist todos to localStorage',
        ];
        for (const item of items) {
          assert.strictEqual(requiresChange(item), false, `"${item}" already matched without the planned flag`);
          assert.strictEqual(requiresChange(item, { planned: true }), true, `"${item}" is still unrecognised`);
        }
      });

      it('does not widen the vocabulary for a message the user typed', () => {
        // Every one of these is an ordinary question that finishes correctly having
        // written nothing, and half of them contain a planner verb.
        for (const text of [
          'explain how the router handles a request',
          'what does this component render',
          'does it support YAML',
          'where do we define the routes',
        ]) {
          assert.strictEqual(requiresChange(text), false, `"${text}" was required to change a file`);
        }
      });

      it('still lets a verification item finish without writing anything', () => {
        // `dropNonDeliverables` keeps these when the request asked for testing, and they
        // legitimately change nothing.
        for (const item of ['Verify the app builds cleanly', 'Confirm the tests pass']) {
          assert.strictEqual(requiresChange(item, { planned: true }), false, `"${item}" was required to write a file`);
        }
      });
    });
  });
});
