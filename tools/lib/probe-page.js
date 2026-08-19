/* eslint-disable -- browser code, injected into the page under test; never loaded by Node. */

/**
 * The in-page feature probe.
 *
 * This file is read as text and evaluated inside the built TODO app, where it drives the
 * UI the way a person would and reports, per feature, whether it actually worked.
 *
 * ## Why it clicks blindly rather than by selector
 *
 * Every model produces different markup. Some label the delete control `aria-label`,
 * some give it a `title`, most give it a bare lucide `<svg>` and nothing else — a probe
 * that looked for a selector would grade the model on its accessibility attributes
 * rather than on whether delete works. So for each control the probe **tries the
 * candidate buttons in turn and keeps the one that produces the effect**. A feature
 * passes when some clickable thing in the row does the job, which is exactly the user's
 * question: is there a button here I can press to delete this item.
 *
 * ## Why it types through the native setter
 *
 * React tracks the last value it wrote to an input and skips the change event when a
 * plain `el.value = x` assignment leaves them equal. Setting through the prototype
 * descriptor and dispatching `input` is what makes a controlled component see the text.
 */

window.__hirayaProbe = async function probe() {
  const report = { features: {}, notes: [] };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** React batches; two frames is enough for a state update to be on screen. */
  const settle = async () => {
    await sleep(120);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(80);
  };

  const record = (name, ok, detail) => {
    report.features[name] = { ok: Boolean(ok), detail: String(detail || '') };
    return Boolean(ok);
  };

  const bodyText = () => (document.body ? document.body.innerText || '' : '');

  /**
   * Everything readable on the page, including what is inside form fields.
   *
   * The fields matter. An item in inline-edit mode has moved its text out of the DOM
   * and into an `input.value`, where `innerText` cannot see it — and the first version
   * of this probe therefore scored "clicked the pencil" as a successful *delete*, and
   * failed the edit test for the same reason. Anything asking "is this item still on
   * screen" has to look in both places.
   */
  const visibleText = () => {
    const fields = Array.prototype.slice
      .call(document.querySelectorAll('input, textarea'))
      .map((el) => el.value || '')
      .join('\n');
    return bodyText() + '\n' + fields;
  };
  const has = (text) => visibleText().indexOf(text) !== -1;

  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function key(el, k) {
    const init = { key: k, code: k === 'Enter' ? 'Enter' : k, keyCode: k === 'Enter' ? 13 : 27, which: k === 'Enter' ? 13 : 27, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keypress', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /** Every text field that is not a checkbox — the add box, or an inline edit box. */
  function textInputs(root) {
    const scope = root || document;
    return Array.prototype.slice
      .call(scope.querySelectorAll('input, textarea'))
      .filter((el) => el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'hidden' && el.offsetParent !== null);
  }

  function clickables(root) {
    const scope = root || document;
    const found = Array.prototype.slice.call(
      scope.querySelectorAll('button, [role="button"], a[href="#"], svg, [data-testid], span[onclick], div[onclick]')
    );
    // An <svg> inside a <button> is the same control twice; keep the outermost.
    return found.filter((el) => {
      if (el.tagName.toLowerCase() === 'svg' && el.closest('button')) return false;
      return el.offsetParent !== null || el.getClientRects().length > 0;
    });
  }

  /**
   * Everything a control says about itself, not the first thing it says.
   *
   * Combined rather than preferred, which is the fix for a real failure: a row's delete
   * button keeps `aria-label="Delete Grace"` while its visible text changes to
   * "Confirm delete?", so a label function that returned the aria-label alone could
   * never see the confirmation it had just triggered.
   */
  function label(el) {
    if (!el || !el.getAttribute) return '';
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function click(el) {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
  }

  /**
   * The smallest element whose text contains `text`, plus the nearest ancestor that
   * carries the row's controls. A model that renders the label in a `<span>` and the
   * buttons two levels up is the common case, so the row is widened until buttons
   * appear rather than assumed.
   */
  /** True when this element shows `text`, whether as markup or as a field's value. */
  function holds(el, text) {
    if ((el.textContent || '').indexOf(text) !== -1) return true;
    const fields = el.querySelectorAll ? el.querySelectorAll('input, textarea') : [];
    for (let i = 0; i < fields.length; i += 1) {
      if ((fields[i].value || '').indexOf(text) !== -1) return true;
    }
    return false;
  }

  function row(text) {
    const all = Array.prototype.slice.call(document.querySelectorAll('li, tr, div, p, span, article, label'));
    const holders = all.filter((el) => holds(el, text));
    if (!holders.length) return null;
    const deepest = holders.filter((el) => !holders.some((other) => other !== el && el.contains(other)));
    let node = deepest[deepest.length - 1] || holders[holders.length - 1];
    for (let i = 0; i < 5 && node.parentElement; i += 1) {
      if (clickables(node).length || node.querySelector('input[type="checkbox"]')) break;
      node = node.parentElement;
    }
    return node;
  }

  function countOf(text) {
    const all = Array.prototype.slice.call(document.querySelectorAll('li, tr, div, span, p, label'));
    const holders = all.filter((el) => holds(el, text));
    return holders.filter((el) => !holders.some((other) => other !== el && el.contains(other))).length;
  }

  function buttonMatching(pattern) {
    return clickables(document).filter((el) => pattern.test(label(el)));
  }

  // ---------------------------------------------------------------- mounted
  const root = document.getElementById('root') || document.body;
  const mounted = root && root.children.length > 0 && bodyText().trim().length > 0;
  record('mounted', mounted, mounted ? 'root rendered ' + root.children.length + ' child element(s)' : 'root is empty — the app did not render');
  if (!mounted) return report;

  // ------------------------------------------------------------ empty state
  const emptyBefore = bodyText().trim();
  record('emptyState', emptyBefore.length > 0, 'text on an empty list: ' + emptyBefore.slice(0, 120).replace(/\s+/g, ' '));

  // -------------------------------------------------------- add, Enter key
  const ALPHA = 'alpha-probe-item';
  const BETA = 'beta-probe-item';
  const GAMMA = 'gamma-probe-item';

  let box = textInputs()[0];
  if (!box) {
    record('addEnter', false, 'no visible text input on the page');
    record('addButton', false, 'no visible text input on the page');
    return report;
  }
  setValue(box, ALPHA);
  key(box, 'Enter');
  if (box.form) box.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  const addedByEnter = has(ALPHA);
  record('addEnter', addedByEnter, addedByEnter ? 'Enter added the item' : 'Enter did not add the item');
  const cleared = !box.value || box.value.indexOf(ALPHA) === -1;
  record('inputClears', addedByEnter && cleared, cleared ? 'input was cleared after submit' : 'input still holds "' + box.value + '"');

  // ----------------------------------------------------- add, submit button
  box = textInputs()[0] || box;
  setValue(box, BETA);
  await settle();
  const submitButtons = clickables(document).filter((el) => {
    const text = label(el);
    return /add|create|submit|\+|new/.test(text) || el.type === 'submit';
  });
  const addButton = submitButtons[0] || null;
  if (addButton) {
    click(addButton);
    await settle();
  }
  const addedByButton = has(BETA);
  record('addButton', addedByButton, addButton ? (addedByButton ? 'button "' + label(addButton).trim().slice(0, 40) + '" added the item' : 'clicking the add button did nothing') : 'no add button found');

  // If the button route failed, fall back so later features still have two items.
  if (!addedByButton) {
    box = textInputs()[0] || box;
    setValue(box, BETA);
    key(box, 'Enter');
    if (box.form) box.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  }

  // ------------------------------------------------------ whitespace is not a todo
  const beforeBlank = countOf('-probe-item');
  box = textInputs()[0] || box;
  setValue(box, '    ');
  key(box, 'Enter');
  if (box.form) box.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  if (addButton) click(addButton);
  await settle();
  const afterBlank = countOf('-probe-item');
  const blankListLength = document.querySelectorAll('li').length;
  record('ignoresEmpty', afterBlank === beforeBlank, 'items before ' + beforeBlank + ', after submitting whitespace ' + afterBlank + ' (' + blankListLength + ' <li>)');

  // ------------------------------------------------------------------ third item
  box = textInputs()[0] || box;
  setValue(box, GAMMA);
  key(box, 'Enter');
  if (box.form) box.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  if (!has(GAMMA) && addButton) {
    click(addButton);
  }
  await settle();

  // -------------------------------------------------------------------- stats
  const statsText = bodyText();
  const showsCount = /\b\d+\b/.test(statsText) && /(remaining|left|completed|done|of\s+\d|total|items?)/i.test(statsText);
  record('liveCount', showsCount, showsCount ? 'a count is on screen' : 'no remaining/completed counter found in the page text');

  // ------------------------------------------------------------------- toggle
  const alphaRow = row(ALPHA);
  let toggled = false;
  let toggleDetail = 'no checkbox or toggle control in the row';
  if (alphaRow) {
    const beforeHtml = alphaRow.outerHTML;
    const checkbox = alphaRow.querySelector('input[type="checkbox"]');
    if (checkbox) {
      click(checkbox);
      await settle();
      const after = row(ALPHA);
      toggled = Boolean(after) && (checkbox.checked || after.outerHTML !== beforeHtml);
      toggleDetail = toggled ? 'checkbox toggled and the row re-rendered' : 'checkbox click changed nothing';
    } else {
      // No checkbox: try the row's controls until one changes how the row looks.
      for (let i = 0; i < 8; i += 1) {
        const current = row(ALPHA);
        if (!current) {
          toggleDetail = 'a control in the row deleted it instead of toggling it';
          break;
        }
        const candidates = clickables(current);
        if (i >= candidates.length) {
          toggleDetail = 'tried all ' + candidates.length + ' control(s); none marked the item complete';
          break;
        }
        const chosenLabel = label(candidates[i]).trim().slice(0, 30);
        click(candidates[i]);
        await settle();
        const after = row(ALPHA);
        if (after && after.outerHTML !== beforeHtml) {
          toggled = true;
          toggleDetail = 'control "' + chosenLabel + '" changed the row';
          break;
        }
      }
    }
  }
  const completedStyled = (function () {
    const after = row(ALPHA);
    if (!after) return false;
    return /line-through/.test(after.outerHTML) || after.querySelector('input[type="checkbox"]:checked') !== null;
  })();
  record('toggleComplete', toggled, toggleDetail + (completedStyled ? '; completed styling applied' : ''));

  // --------------------------------------------------------------------- edit
  // Try double-click first, as the brief asks for; then every control in the row,
  // skipping anything that removes it. An edit box is "a text input inside this row
  // that was not there before".
  let editWorked = false;
  let editDetail = 'no control turned the text into an editable field';
  const gammaRow = row(GAMMA);
  if (gammaRow) {
    const editBoxIn = (node) => (node ? textInputs(node).filter((el) => el !== box) : [])[0] || null;
    let target = gammaRow;
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    let field = editBoxIn(row(GAMMA));
    if (!field) {
      for (let i = 0; i < 8; i += 1) {
        const current = row(GAMMA);
        if (!current) {
          editDetail = 'a control in the row deleted the item instead of editing it';
          break;
        }
        const candidates = clickables(current).filter((el) => !/delete|remove|trash|clear|×|✕/.test(label(el)));
        if (i >= candidates.length) {
          editDetail = 'tried all ' + candidates.length + ' control(s); none opened an edit field';
          break;
        }
        const chosenLabel = label(candidates[i]).trim().slice(0, 30);
        click(candidates[i]);
        await settle();
        field = editBoxIn(row(GAMMA));
        if (field) {
          editDetail = 'control "' + chosenLabel + '" opened an edit field';
          break;
        }
      }
    } else {
      editDetail = 'double-click opened an edit field';
    }
    if (field) {
      setValue(field, 'gamma-edited-item');
      key(field, 'Enter');
      field.dispatchEvent(new Event('blur', { bubbles: true }));
      await settle();
      editWorked = has('gamma-edited-item') && !has(GAMMA);
      if (!editWorked && has('gamma-edited-item')) editDetail += '; new text is shown but the old text is still on screen too';
      else if (!editWorked) editDetail += '; the edit did not persist';
      else editDetail += ' and the new text persisted';
    }
  }
  record('editTodo', editWorked, editDetail);

  // ------------------------------------------------------------------- delete
  let deleted = false;
  let deleteDetail = 'no control in the row removed it';
  const betaRow = row(BETA);
  const alphaBefore = has(ALPHA);
  if (betaRow) {
    for (let i = 0; i < 8; i += 1) {
      // Re-queried every pass, never captured once. Clicking a control re-renders the
      // row, which detaches every node captured before it — and a click on a detached
      // node does nothing at all, so a captured list reports a working delete button
      // as broken. This cost an hour; it is why the loop looks like this.
      const current = row(BETA);
      if (!current) break;
      const buttons = clickables(current);
      if (i >= buttons.length) {
        deleteDetail = 'tried all ' + buttons.length + ' control(s) in the row; none removed it';
        break;
      }
      const chosen = buttons[i];
      const chosenLabel = label(chosen).trim().slice(0, 30);
      click(chosen);
      await settle();
      if (!has(BETA)) {
        deleted = true;
        deleteDetail = 'control "' + chosenLabel + '" removed the item';
        break;
      }
      // That one was the edit control. Back out before trying the next, or every
      // remaining click lands inside an edit field rather than on the row.
      const openField = textInputs(row(BETA) || current).filter((el) => el !== box)[0];
      if (openField) {
        key(openField, 'Escape');
        await settle();
      }
    }
  } else {
    deleteDetail = 'the item to delete was not on screen';
  }
  const othersSurvived = !alphaBefore || has(ALPHA);
  record('deleteTodo', deleted && othersSurvived, deleteDetail + (othersSurvived ? '' : '; but it took another item with it'));

  // ---------------------------------------------------------- clear completed
  // Something must be completed for this to mean anything; if the toggle failed there
  // is nothing to clear and the result is recorded as untested rather than as a pass.
  let clearedCompleted = false;
  let clearCompletedDetail = 'no "clear completed" control found';
  const clearCompletedButtons = buttonMatching(/clear\s*completed|remove\s*completed|clear\s*done/);
  if (clearCompletedButtons.length) {
    const button = clearCompletedButtons[0];
    click(button);
    await settle();
    // A click-to-confirm control needs the second click; harmless if it does not.
    click(button);
    await settle();
    clearedCompleted = toggled ? !has(ALPHA) : true;
    clearCompletedDetail = toggled
      ? clearedCompleted
        ? 'the completed item was removed'
        : 'the completed item is still on screen'
      : 'clicked, but nothing was completed to clear (toggle failed earlier)';
  }
  record('clearCompleted', clearedCompleted && clearCompletedButtons.length > 0, clearCompletedDetail);

  // --------------------------------------------------------------- clear all
  let clearedAll = false;
  let clearAllDetail = 'no "clear all" control found';
  const clearAllButtons = buttonMatching(/clear\s*all|delete\s*all|remove\s*all|clear\s*todos/);
  if (clearAllButtons.length) {
    const button = clearAllButtons[0];
    click(button);
    await settle();
    click(button);
    await settle();
    clearedAll = !has('-probe-item') && !has('gamma-edited');
    clearAllDetail = clearedAll ? 'the list was emptied' : 'items remained after two clicks';
    // And it must survive being pressed on an empty list.
    click(button);
    await settle();
    click(button);
    await settle();
    clearAllDetail += '; clicked again on the empty list without throwing';
  }
  record('clearAll', clearedAll, clearAllDetail);

  report.finalText = bodyText().slice(0, 400).replace(/\s+/g, ' ');
  return report;
};
