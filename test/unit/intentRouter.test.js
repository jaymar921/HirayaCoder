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

const { classify } = require('../../app/core/intentRouter');

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
      for (const text of ['thanks', 'thank you', 'salamat', 'ok', 'cool', 'nice one', 'got it', 'bye']) {
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
  });

  it('explains itself, for the log', () => {
    assert.match(classify('hello').reason, /greeting/);
    assert.match(classify('fix it').reason, /instruction/);
  });
});
