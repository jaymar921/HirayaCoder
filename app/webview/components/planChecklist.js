/**
 * Plan mode's result: an editable checklist with a handoff into Agent mode.
 *
 * Plan mode exists so the user can see what the agent intends *before* it touches
 * anything. That only pays off if the plan is genuinely editable — a checklist you
 * can read but not change is just a slower way of saying yes. So steps can be
 * reworded, removed, and reordered, and what gets handed to Agent mode is whatever
 * the user ended up with, not what the model originally proposed.
 */

/**
 * @param {string[]} steps
 * @param {(steps: string[]) => void} onRun
 * @returns {HTMLElement}
 */
export function renderPlanChecklist(steps, onRun) {
  /** @type {string[]} */
  let working = steps.slice();

  const wrapper = document.createElement('div');
  wrapper.className = 'plan';

  const list = document.createElement('ol');
  list.className = 'todo-list';

  function redraw() {
    list.replaceChildren();

    working.forEach((step, index) => {
      const row = document.createElement('li');
      row.className = 'todo-item';

      const text = document.createElement('input');
      text.type = 'text';
      text.className = 'control plan-step';
      text.value = step;
      text.setAttribute('aria-label', `Step ${index + 1}`);
      text.addEventListener('change', () => {
        // `index` is the forEach counter over `working`, a local string array.
        // eslint-disable-next-line security/detect-object-injection
        working[index] = text.value;
      });

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'chip-remove';
      up.textContent = '↑';
      up.title = 'Move up';
      up.disabled = index === 0;
      up.addEventListener('click', () => {
        const [moved] = working.splice(index, 1);
        working.splice(index - 1, 0, moved);
        redraw();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'chip-remove';
      remove.textContent = '×';
      remove.title = 'Remove this step';
      remove.addEventListener('click', () => {
        working = working.filter((_, i) => i !== index);
        redraw();
      });

      row.appendChild(text);
      row.appendChild(up);
      row.appendChild(remove);
      list.appendChild(row);
    });

    run.disabled = working.filter((s) => s.trim()).length === 0;
  }

  const actions = document.createElement('div');
  actions.className = 'welcome-tips';

  const run = document.createElement('button');
  run.type = 'button';
  run.className = 'send';
  run.textContent = 'Run this plan';
  run.addEventListener('click', () => {
    const finalSteps = working.map((s) => s.trim()).filter(Boolean);
    if (finalSteps.length > 0) onRun(finalSteps);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'control';
  add.textContent = '+ Add step';
  add.addEventListener('click', () => {
    working.push('');
    redraw();
    const inputs = list.querySelectorAll('.plan-step');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });

  actions.appendChild(run);
  actions.appendChild(add);

  wrapper.appendChild(list);
  wrapper.appendChild(actions);
  redraw();
  return wrapper;
}
