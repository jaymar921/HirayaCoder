/**
 * The card the agent shows when it stops to ask the user something.
 *
 * A run is *blocked* while this is on screen, which is what shapes the design. Every
 * other component here reports on work that is happening; this one is the work not
 * happening, so it has to be answerable at a glance:
 *
 * - The recommended option is first and marked, because the agent has the trace and
 *   the user has a card. Presenting four equal choices moves the decision without
 *   helping with it.
 * - Every option says what happens next, not just what it is called.
 * - There is always a way to type something else. The options are the agent's reading
 *   of a situation it has just demonstrated it does not fully understand.
 * - Once answered the card stays, showing what was chosen. It is part of the record of
 *   the run — a summary that says "you told me to skip that" should have something to
 *   point at.
 *
 * Nothing here is built from a string of HTML: the question, the context and every
 * label originate in the extension host but describe model output and file paths, and
 * the rule in this folder is that model-adjacent text is data. See the frontend design
 * notes, §6.
 */

/**
 * @param {object} request         The clarification, as built by `agent/clarification`.
 * @param {(answer: object) => void} onAnswer
 * @returns {HTMLElement}
 */
export function renderClarification(request, onAnswer) {
  const wrapper = document.createElement('div');
  wrapper.className = 'clarify';

  const question = document.createElement('p');
  question.className = 'clarify-question';
  question.textContent = request.question;
  wrapper.appendChild(question);

  if (request.context) {
    const context = document.createElement('p');
    context.className = 'clarify-context';
    context.textContent = request.context;
    wrapper.appendChild(context);
  }

  const options = document.createElement('div');
  options.className = 'clarify-options';

  /** Answering twice would resolve a promise the host has already moved past. */
  let answered = false;

  /**
   * @param {object} answer
   * @param {string} chosenLabel
   */
  function answer(answer_, chosenLabel) {
    if (answered) return;
    answered = true;
    onAnswer({ ...answer_, id: request.id });

    // Replaced rather than disabled: a row of dead buttons reads as a card that failed,
    // and this one succeeded.
    const chosen = document.createElement('p');
    chosen.className = 'clarify-chosen';
    chosen.textContent = `You chose: ${chosenLabel}`;
    options.replaceWith(chosen);
    if (freeText.isConnected) freeText.remove();
  }

  for (const option of request.options || []) {
    const button = document.createElement('button');
    button.type = 'button';
    // The recommended option gets the send button's treatment — the one accent already
    // used for "this is the action". A fifth accent would stop it meaning anything.
    button.className = option.recommended ? 'send clarify-option' : 'control clarify-option';

    const label = document.createElement('span');
    label.className = 'clarify-label';
    label.textContent = option.recommended ? `${option.label} — recommended` : option.label;
    button.appendChild(label);

    if (option.detail) {
      const detail = document.createElement('span');
      detail.className = 'clarify-detail';
      detail.textContent = option.detail;
      button.appendChild(detail);
    }

    button.addEventListener('click', () => answer({ optionId: option.id }, option.label));
    options.appendChild(button);
  }

  wrapper.appendChild(options);

  const freeText = document.createElement('div');
  freeText.className = 'clarify-free';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'control clarify-input';
  input.placeholder = 'Or tell me what to do instead…';
  input.setAttribute('aria-label', 'Answer in your own words');

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'control';
  submit.textContent = 'Send';

  function sendTyped() {
    const text = input.value.trim();
    if (text) answer({ text }, text);
  }

  submit.addEventListener('click', sendTyped);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      sendTyped();
    }
  });

  freeText.appendChild(input);
  freeText.appendChild(submit);
  wrapper.appendChild(freeText);

  return wrapper;
}
