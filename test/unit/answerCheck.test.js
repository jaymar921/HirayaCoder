'use strict';

/**
 * Every `mismatched` case here is quoted from a real session transcript. The wording is
 * not illustrative — it is what the models actually emitted, and the point of keeping it
 * verbatim is that a future change to the patterns gets measured against the failures
 * they were written for rather than against a tidied-up paraphrase.
 */

const assert = require('assert');

const answerCheck = require('../../app/agent/answerCheck');

/** The opener that appeared, unprompted, in five separate answers in one session. */
const CHANGELOG =
  'Here are 2-4 bullet points summarizing the changes:\n\n' +
  '* The `api/package.json` file has been updated with a new version number (`1.0.0`).\n' +
  '* The `server.js` file has been updated to include middleware functions.';

describe('answerCheck — a changelog offered as an answer', () => {
  it('catches it for a question about the assistant itself', () => {
    const verdict = answerCheck.check({ task: 'how about yours?', answer: CHANGELOG, changedFiles: false });
    assert.strictEqual(verdict.mismatched, true);
    assert.match(verdict.reason, /about yourself/);
  });

  it('catches it for a question about the project', () => {
    const verdict = answerCheck.check({
      task: 'wow good, can you explain more about the readme.md?',
      answer: CHANGELOG,
      changedFiles: false,
    });
    assert.strictEqual(verdict.mismatched, true);
  });

  it('catches it for a message that asked nothing at all', () => {
    // "wow impressive" got a four-bullet summary of package.json.
    const verdict = answerCheck.check({ task: 'wow impressive', answer: CHANGELOG, changedFiles: false });
    assert.strictEqual(verdict.mismatched, true);
  });

  it('allows it when files really were changed', () => {
    const verdict = answerCheck.check({ task: 'add a login route', answer: CHANGELOG, changedFiles: true });
    assert.strictEqual(verdict.mismatched, false);
  });

  it('allows it when the user asked for a change, even before the change set is seen', () => {
    const verdict = answerCheck.check({ task: 'fix the bug in server.js', answer: CHANGELOG, changedFiles: false });
    assert.strictEqual(verdict.mismatched, false);
  });

  it('tells the model what to do instead, not merely that it was wrong', () => {
    const verdict = answerCheck.check({ task: 'what version are you?', answer: CHANGELOG, changedFiles: false });
    assert.match(verdict.instruction, /answer the question they actually asked/i);
  });
});

describe('answerCheck — an answer repeated for a different question', () => {
  const conversation = [
    { role: 'user', text: 'what is 1+1' },
    {
      role: 'assistant',
      text: "Hello Jay! How are you doing? Is there anything specific you'd like me to assist with or would you prefer to chat about something else?",
    },
  ];

  it('catches a verbatim restatement', () => {
    const verdict = answerCheck.check({
      task: 'give me a joke',
      answer:
        "Hello Jay! How are you doing? Is there anything specific you'd like me to assist with or would you prefer to chat about something else?",
      conversation,
    });
    assert.strictEqual(verdict.mismatched, true);
    assert.match(verdict.reason, /repeated the previous answer/);
  });

  it('allows the same answer when the same thing was asked again', () => {
    const verdict = answerCheck.check({
      task: 'what is 1+1',
      answer:
        "Hello Jay! How are you doing? Is there anything specific you'd like me to assist with or would you prefer to chat about something else?",
      conversation,
    });
    assert.strictEqual(verdict.mismatched, false);
  });

  it('does not judge a short answer as a repeat', () => {
    // "Yes." after "Yes." is not evidence of anything.
    const verdict = answerCheck.check({
      task: 'is it done?',
      answer: 'Yes.',
      conversation: [
        { role: 'user', text: 'did it work?' },
        { role: 'assistant', text: 'Yes.' },
      ],
    });
    assert.strictEqual(verdict.mismatched, false);
  });
});

describe('answerCheck — what it must leave alone', () => {
  it('passes a plain prose answer to a plain question', () => {
    const verdict = answerCheck.check({
      task: 'what is this project about?',
      answer: 'LocoMenu is a hyper-local food price comparison platform for finding real prices from nearby vendors.',
    });
    assert.strictEqual(verdict.mismatched, false);
  });

  it('passes a report that a step failed', () => {
    // `appendUnfinishedNote` writes these, not the model, and smoothing one over would
    // hide a real failure from the user.
    const verdict = answerCheck.check({
      task: 'proceed',
      answer: 'These steps did not complete:\n- `node api/server.js` finished with exit code 1.',
    });
    assert.strictEqual(verdict.mismatched, false);
  });

  it('passes an unreachable model rather than trying to redraft it', () => {
    const verdict = answerCheck.check({
      task: 'how about yours?',
      answer: 'The model could not be reached: Request aborted.',
    });
    assert.strictEqual(verdict.mismatched, false);
  });

  it('passes an empty answer without throwing', () => {
    assert.strictEqual(answerCheck.check({ task: 'hi', answer: '' }).mismatched, false);
  });

  it('does not fire on prose that merely names a file', () => {
    const verdict = answerCheck.check({
      task: 'what is in the readme?',
      answer: 'The README.md describes the API and links to the contributing guide.',
    });
    assert.strictEqual(verdict.mismatched, false);
  });
});

describe('answerCheck.overlap', () => {
  it('scores identical text as 1', () => {
    assert.strictEqual(answerCheck.overlap('the same words here', 'the same words here'), 1);
  });

  it('scores unrelated text near 0', () => {
    assert.ok(answerCheck.overlap('rainfall gauge measurement', 'quantum banana telephone') < 0.2);
  });

  it('ignores punctuation and case', () => {
    assert.strictEqual(answerCheck.overlap('Hello, Jay!', 'hello jay'), 1);
  });
});
