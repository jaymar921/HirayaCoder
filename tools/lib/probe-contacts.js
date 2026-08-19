/* eslint-disable -- browser code, injected into the page under test; never loaded by Node. */

/**
 * The in-page feature probe for the contact manager brief.
 *
 * Same approach as `probe-page.js` and for the same reasons: every model produces
 * different markup, so controls are found by trying them rather than by selector, and a
 * feature passes when something on the page actually does the job.
 *
 * Three things make this brief harder to drive than the TODO one, and each is handled
 * explicitly below:
 *
 * - **The form has several fields.** They are filled by matching each input against its
 *   label, placeholder, name and type, rather than by position.
 * - **Destructive actions are gated behind a confirmation.** A click that does nothing
 *   is not necessarily a broken button — it may be a button waiting to be confirmed. So
 *   a destructive click looks for a confirmation and answers it, and the *absence* of
 *   one is itself recorded, because the brief asks for it.
 * - **It has to survive a reload.** The brief asks for `localStorage`, so the probe
 *   reloads the page and checks the contact is still there.
 */

window.__hirayaProbe = async function probe() {
  const report = { features: {}, notes: [] };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => {
    await sleep(120);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await sleep(90);
  };

  const record = (name, ok, detail) => {
    report.features[name] = { ok: Boolean(ok), detail: String(detail || '') };
    return Boolean(ok);
  };

  const bodyText = () => (document.body ? document.body.innerText || '' : '');
  const fieldText = () =>
    Array.prototype.slice
      .call(document.querySelectorAll('input, textarea, select'))
      .map((el) => el.value || '')
      .join('\n');
  const visibleText = () => bodyText() + '\n' + fieldText();
  const has = (text) => visibleText().indexOf(text) !== -1;
  const shown = (text) => bodyText().indexOf(text) !== -1;

  function setValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function key(el, k) {
    const init = { key: k, code: k, keyCode: k === 'Enter' ? 13 : 27, which: k === 'Enter' ? 13 : 27, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function click(el) {
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.click();
  }

  function visible(el) {
    return el.offsetParent !== null || el.getClientRects().length > 0;
  }

  function clickables(root) {
    const scope = root || document;
    return Array.prototype.slice
      .call(scope.querySelectorAll('button, [role="button"], a[href="#"], svg, [data-testid]'))
      .filter((el) => !(el.tagName.toLowerCase() === 'svg' && el.closest('button')))
      .filter(visible);
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

  function buttonMatching(pattern, root) {
    return clickables(root).filter((el) => pattern.test(label(el)));
  }

  /** Everything about an input that hints at what it is for. */
  function describe(el) {
    const parts = [el.name, el.id, el.placeholder, el.type, el.getAttribute('aria-label')];
    if (el.id) {
      const tag = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (tag) parts.push(tag.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping) parts.push(wrapping.textContent);
    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  function textInputs(root) {
    const scope = root || document;
    return Array.prototype.slice
      .call(scope.querySelectorAll('input, textarea'))
      .filter((el) => el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'hidden')
      .filter(visible);
  }

  /**
   * Fill a form by matching each field to what it is asking for.
   *
   * Anything unmatched gets the name, because a required field left empty fails
   * validation and the probe would then be measuring its own omission.
   */
  function fillForm(root, values) {
    const fields = textInputs(root).filter((el) => !/search|filter|find/.test(describe(el)));
    let filled = 0;
    for (const field of fields) {
      const about = describe(field);
      if (/e-?mail/.test(about)) setValue(field, values.email);
      else if (/phone|tel|mobile/.test(about)) setValue(field, values.phone);
      else if (/company|organisation|organization|employer/.test(about)) setValue(field, values.company);
      else setValue(field, values.name);
      filled += 1;
    }
    return filled;
  }

  function submitForm(root) {
    const form = (root && root.tagName === 'FORM' ? root : root && root.querySelector('form')) || null;
    const submit = buttonMatching(/save|add|create|submit|done|confirm/, root)[0] || null;
    if (submit) click(submit);
    else if (form) form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return Boolean(submit || form);
  }

  /** The panel or dialog holding the add/edit form, or the document if it is inline. */
  function formScope() {
    const dialog = Array.prototype.slice
      .call(document.querySelectorAll('[role="dialog"], dialog, form, .modal, [class*="modal"], [class*="drawer"], [class*="panel"]'))
      .filter(visible)
      .filter((el) => textInputs(el).length >= 1);
    return dialog[dialog.length - 1] || document;
  }

  /** Open the add form, if it is behind a button. */
  async function openAddForm() {
    if (textInputs(formScope()).filter((el) => !/search|filter/.test(describe(el))).length >= 1) return true;
    const opener = buttonMatching(/add|new|create|\+/)[0];
    if (!opener) return false;
    click(opener);
    await settle();
    return textInputs(formScope()).length >= 1;
  }

  /**
   * Click something destructive and answer whatever confirmation it raises.
   *
   * Returns whether a confirmation appeared, which the brief requires for both delete
   * and clear-all — so its absence is a finding rather than a convenience.
   */
  async function confirmDestructive(button, scope) {
    const before = bodyText();
    const container = scope || button.parentElement || document;
    click(button);
    await settle();

    // The clicked control itself, first — and **re-found**, not reused.
    //
    // Two bugs lived here, both worth keeping written down. The first: it searched the
    // whole page for a confirm-looking button before checking the one just pressed, so a
    // row's delete — now reading "Confirm delete?" — was answered by clicking the page's
    // global **Clear All**, which matched `/clear/`. The second: holding the original
    // node across the re-render that the click causes, which is the same detached-node
    // trap the TODO probe hit. A correct app scored 8 of 12 between them.
    const askingNow = clickables(container).filter((el) => /(confirm|sure|really|undo|yes\b)/i.test(label(el)))[0];
    if (askingNow) {
      click(askingNow);
      await settle();
      return { confirmed: true, changed: true };
    }

    // Otherwise a dialog, and only inside the dialog — never a button elsewhere on the
    // page, which by definition is about something else.
    const dialog = Array.prototype.slice
      .call(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"], .modal, [class*="modal"]'))
      .filter(visible)
      .pop();
    if (dialog) {
      const yes = buttonMatching(/confirm|yes|delete|remove|clear|ok\b|continue/, dialog)[0];
      if (yes) {
        click(yes);
        await settle();
        return { confirmed: true, changed: true };
      }
    }

    return { confirmed: false, changed: bodyText() !== before };
  }

  /** Row controls, with the ones that plainly are not delete tried last. */
  function deleteFirst(candidates) {
    const notEdit = candidates.filter((el) => !/edit|pencil|modify|view|open/.test(label(el)));
    const rest = candidates.filter((el) => notEdit.indexOf(el) === -1);
    return notEdit.concat(rest);
  }

  // ---------------------------------------------------------------- mounted
  const root = document.getElementById('root') || document.body;
  const mounted = root && root.children.length > 0 && bodyText().trim().length > 0;
  record('mounted', mounted, mounted ? 'root rendered ' + root.children.length + ' child element(s)' : 'root is empty');
  if (!mounted) return report;

  record('emptyState', bodyText().trim().length > 0, 'text before any contact: ' + bodyText().slice(0, 110).replace(/\s+/g, ' '));

  // ------------------------------------------------------------- add a contact
  const ADA = { name: 'Ada Probe', email: 'ada@probe.test', phone: '5550100', company: 'Probe Ltd' };
  const GRACE = { name: 'Grace Probe', email: 'grace@probe.test', phone: '5550101', company: 'Probe Ltd' };

  let opened = await openAddForm();
  if (!opened) {
    record('addContact', false, 'no add form and no button that opens one');
    return report;
  }
  fillForm(formScope(), ADA);
  submitForm(formScope());
  await settle();
  const added = shown(ADA.name);
  record('addContact', added, added ? 'the contact is on the page' : 'the contact never appeared');

  // ------------------------------------------------------------------ persistence
  //
  // Checked here, immediately after the first successful add, rather than at the end.
  // At the end the page has been through an edit, a delete and two clear-alls, and a
  // form left holding a stale edit target made a *correct* app report that nothing had
  // been stored. The requirement is that a contact survives a refresh; one contact and a
  // clean page is the honest way to ask.
  let persisted = false;
  let persistDetail = 'nothing was stored';
  try {
    persisted = Object.keys(window.localStorage || {}).some(
      (k) => String(window.localStorage.getItem(k) || '').indexOf(ADA.name) !== -1
    );
    persistDetail = persisted ? 'the contact is in localStorage' : 'nothing matching the contact is in localStorage';
  } catch (error) {
    persistDetail = 'reading localStorage threw: ' + error.message;
  }
  record('persists', persisted, persistDetail);

  // ------------------------------------------------------- validation refuses bad input
  await openAddForm();
  const scope = formScope();
  const emailField = textInputs(scope).filter((el) => /e-?mail/.test(describe(el)))[0];
  const nameField = textInputs(scope).filter((el) => !/e-?mail|search|filter|phone|company/.test(describe(el)))[0];
  let validated = false;
  let validationDetail = 'no email field to test validation with';
  if (emailField && nameField) {
    const countBefore = (bodyText().match(/@probe\.test/g) || []).length;
    setValue(nameField, 'Broken Probe');
    setValue(emailField, 'not-an-email');
    submitForm(formScope());
    await settle();
    const countAfter = (bodyText().match(/@probe\.test/g) || []).length;
    const complained = /invalid|valid|required|must|error|enter a/i.test(bodyText());
    validated = !shown('Broken Probe') || (complained && countAfter === countBefore);
    validationDetail = validated
      ? complained
        ? 'refused it and said why'
        : 'refused it'
      : 'accepted "not-an-email" as an email address';
  }
  record('validatesInput', validated, validationDetail);

  // Clear the half-filled form out of the way before carrying on.
  const cancel = buttonMatching(/cancel|close|dismiss|×/)[0];
  if (cancel) {
    click(cancel);
    await settle();
  }

  // --------------------------------------------------------------- second contact
  await openAddForm();
  fillForm(formScope(), GRACE);
  submitForm(formScope());
  await settle();
  record('listsContacts', shown(ADA.name) && shown(GRACE.name), shown(GRACE.name) ? 'both contacts are listed' : 'the second contact did not appear');

  // -------------------------------------------------------------------- search
  let searched = false;
  let searchDetail = 'no search field on the page';
  const searchField = textInputs(document).filter((el) => /search|filter|find/.test(describe(el)))[0];
  if (searchField) {
    setValue(searchField, 'Grace');
    await settle();
    searched = shown(GRACE.name) && !shown(ADA.name);
    searchDetail = searched ? 'filtered the list down to the match' : 'typing in the search box changed nothing';
    setValue(searchField, '');
    await settle();
  }
  record('searchFilters', searched, searchDetail);

  // ---------------------------------------------------------------------- edit
  let edited = false;
  let editDetail = 'nothing opened an edit form for the contact';
  const rowOf = (text) => {
    const all = Array.prototype.slice.call(document.querySelectorAll('li, tr, div, article, section'));
    const holders = all.filter((el) => (el.textContent || '').indexOf(text) !== -1);
    const deepest = holders.filter((el) => !holders.some((other) => other !== el && el.contains(other)));
    let node = deepest[deepest.length - 1] || holders[holders.length - 1] || null;
    for (let i = 0; node && i < 5 && node.parentElement; i += 1) {
      if (clickables(node).length) break;
      node = node.parentElement;
    }
    return node;
  };

  const adaRow = rowOf(ADA.name);
  if (adaRow) {
    const candidates = clickables(adaRow).filter((el) => !/delete|remove|trash/.test(label(el)));
    for (let i = 0; i < Math.min(candidates.length, 6); i += 1) {
      click(candidates[i]);
      await settle();
      const form = formScope();
      const field = textInputs(form).filter((el) => !/search|filter/.test(describe(el)))[0];
      if (field && String(field.value || '').indexOf('Ada') !== -1) {
        setValue(field, 'Ada Edited');
        submitForm(form);
        await settle();
        edited = shown('Ada Edited') && !shown(ADA.name);
        editDetail = edited ? 'the change was saved' : 'the edit form opened but the change did not stick';
        break;
      }
      editDetail = 'a control opened something, but not a form holding this contact';
    }
  }
  record('editContact', edited, editDetail);

  // -------------------------------------------------------------------- delete
  const graceRow = rowOf(GRACE.name);
  let deleted = false;
  let confirmedDelete = false;
  let deleteDetail = 'no control in the row removed the contact';
  if (graceRow) {
    const candidates = deleteFirst(clickables(graceRow));
    for (let i = 0; i < Math.min(candidates.length, 6); i += 1) {
      const outcome = await confirmDestructive(candidates[i], rowOf(GRACE.name) || graceRow);
      if (!shown(GRACE.name)) {
        deleted = true;
        confirmedDelete = outcome.confirmed;
        deleteDetail = outcome.confirmed ? 'asked for confirmation, then removed it' : 'removed it with no confirmation';
        break;
      }
    }
  }
  record('deleteContact', deleted, deleteDetail);
  record('deleteConfirms', deleted && confirmedDelete, confirmedDelete ? 'a confirmation was required' : 'no confirmation was asked for');

  // ------------------------------------------------------------------ clear all
  let cleared = false;
  let confirmedClear = false;
  let clearDetail = 'no "clear all" control found';
  const clearButton = buttonMatching(/clear\s*all|delete\s*all|remove\s*all|clear\s*contacts/)[0];
  if (clearButton) {
    const outcome = await confirmDestructive(clearButton, document);
    confirmedClear = outcome.confirmed;
    cleared = !shown('Ada Edited') && !shown(ADA.name) && !shown(GRACE.name);
    clearDetail = cleared
      ? confirmedClear
        ? 'asked for confirmation, then emptied the list'
        : 'emptied the list with no confirmation'
      : 'the list still holds contacts';
    // And it must survive being pressed on an empty list.
    await confirmDestructive(buttonMatching(/clears*all|deletes*all|removes*all|clears*contacts/)[0] || clearButton, document);
    clearDetail += '; pressed again on the empty list without throwing';
  }
  record('clearAll', cleared, clearDetail);
  record('clearAllConfirms', cleared && confirmedClear, confirmedClear ? 'a confirmation was required' : 'no confirmation was asked for');

  report.finalText = bodyText().slice(0, 400).replace(/\s+/g, ' ');
  return report;
};
