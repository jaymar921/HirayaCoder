'use strict';

const assert = require('assert');

const clarification = require('../../app/agent/clarification');

describe('clarification.build', () => {
  /** @param {number} count */
  function options(count) {
    return Array.from({ length: count }, (_, index) => ({
      id: `o${index + 1}`,
      label: `Option ${index + 1}`,
      effect: 'instruct',
      recommended: index === 0,
    }));
  }

  it('builds a question with its options', () => {
    const request = clarification.build({
      kind: 'error',
      question: 'How should I carry on?',
      context: 'It failed three times.',
      options: options(3),
    });

    assert.strictEqual(request.question, 'How should I carry on?');
    assert.strictEqual(request.options.length, 3);
    assert.ok(request.id);
  });

  it('refuses fewer than two options, because that is not a choice', () => {
    assert.throws(() => clarification.build({ question: 'Which?', options: options(1) }), /between 2 and 4/);
  });

  it('refuses more than four, because that is a second task for the user', () => {
    assert.throws(() => clarification.build({ question: 'Which?', options: options(5) }), /between 2 and 4/);
  });

  it('refuses a set that recommends two things at once', () => {
    const both = options(2).map((option) => ({ ...option, recommended: true }));
    assert.throws(() => clarification.build({ question: 'Which?', options: both }), /exactly one/);
  });

  it('promotes the first option rather than failing a run with no recommendation', () => {
    // A blocked run must not also throw. "Here are your choices" with nothing marked is
    // a worse question, not an unanswerable one.
    const none = options(2).map((option) => ({ ...option, recommended: false }));
    const request = clarification.build({ question: 'Which?', options: none });
    assert.strictEqual(request.options[0].recommended, true);
    assert.strictEqual(request.options[1].recommended, false);
  });

  it('always allows free text, whatever the caller asked for', () => {
    // Not settable on purpose: the options are the agent's reading of a situation it
    // has just shown it does not fully understand.
    const request = clarification.build({ question: 'Which?', options: options(2), allowFreeText: false });
    assert.strictEqual(request.allowFreeText, true);
  });

  it('trims a question and a label down to what a card can hold', () => {
    const request = clarification.build({
      question: 'q'.repeat(400),
      options: [
        { label: 'l'.repeat(200), effect: 'skip', recommended: true },
        { label: 'Second', effect: 'stop' },
      ],
    });

    assert.ok(request.question.length <= clarification.MAX_QUESTION_CHARS);
    assert.ok(request.options[0].label.length <= clarification.MAX_LABEL_CHARS);
    assert.ok(request.question.endsWith('…'));
  });

  it('refuses a question with nothing in it', () => {
    assert.throws(() => clarification.build({ question: '   ', options: options(2) }), /needs a question/);
  });

  it('gives every question its own id', () => {
    const a = clarification.build({ question: 'One?', options: options(2) });
    const b = clarification.build({ question: 'Two?', options: options(2) });
    assert.notStrictEqual(a.id, b.id);
  });
});

describe('clarification.resolve', () => {
  const request = clarification.build({
    kind: 'error',
    question: 'How should I carry on?',
    options: [
      { id: 'skip', label: 'Skip it', effect: 'skip', recommended: true, guidance: 'Leave it alone.' },
      { id: 'stop', label: 'Stop', effect: 'stop' },
    ],
  });

  it('resolves a chosen option to its effect and guidance', () => {
    const resolved = clarification.resolve(request, { id: request.id, optionId: 'skip' });
    assert.strictEqual(resolved.effect, 'skip');
    assert.strictEqual(resolved.guidance, 'Leave it alone.');
  });

  it('falls back to the label when an option carries no guidance', () => {
    const resolved = clarification.resolve(request, { id: request.id, optionId: 'stop' });
    assert.strictEqual(resolved.guidance, 'Stop');
  });

  it('prefers what the user typed over what they clicked', () => {
    // They meant the words. The option may have been clicked on the way to the box.
    const resolved = clarification.resolve(request, {
      id: request.id,
      optionId: 'skip',
      text: 'use the other config file',
    });
    assert.strictEqual(resolved.effect, 'instruct');
    assert.strictEqual(resolved.guidance, 'use the other config file');
  });

  it('stops on a cancelled answer', () => {
    assert.strictEqual(clarification.resolve(request, { id: request.id, cancelled: true }).effect, 'stop');
  });

  it('stops when there is no answer at all', () => {
    assert.strictEqual(clarification.resolve(request, null).effect, 'stop');
  });

  it('stops rather than guessing when the option is unknown', () => {
    // The run is blocked, so this has to resolve to something — and picking an option
    // on the user's behalf is the one thing it must not do.
    assert.strictEqual(clarification.resolve(request, { id: request.id, optionId: 'nope' }).effect, 'stop');
  });

  it('ignores whitespace-only free text rather than treating it as an instruction', () => {
    const resolved = clarification.resolve(request, { id: request.id, optionId: 'skip', text: '   ' });
    assert.strictEqual(resolved.effect, 'skip');
  });
});
