/**
 * The setup guide — what to install, and what the thing actually does once installed.
 *
 * ## Why this is static text in the webview
 *
 * Every other control here posts to the host, because the host is the only side that
 * can do anything. This one has nothing to ask for: the guide is the same sentences on
 * every machine, in every workspace, whether or not Ollama is running. Routing it
 * through a message would buy a protocol and a round-trip for a string constant.
 *
 * ## Why it is a card in the transcript rather than a modal
 *
 * The most likely reader is someone whose first run did not go the way they expected —
 * a model that has not been pulled, a task that is taking four minutes, a write that
 * was refused. They need the guide *beside* the thing that confused them, and they need
 * to keep scrolling back to it. A modal takes the transcript away to show it.
 *
 * The content is deliberately blunt about the trade. A first-time user who is told to
 * expect ChatGPT and gets a 1B model will conclude the extension is broken; one who is
 * told a task takes one to five minutes on a laptop will wait for it.
 *
 * @module webview/components/guideCard
 */

/**
 * @typedef {object} GuideStep
 * @property {string} title
 * @property {string} detail
 * @property {string} [command]  A line to paste into a terminal, if the step has one.
 */

/** @type {GuideStep[]} */
const SETUP = [
  {
    title: 'Install Ollama and leave it running',
    detail:
      'Ollama is the free program that runs the AI on your own machine. Download it from ollama.com. It has no window — it sits in your system tray or menu bar, and that is normal.',
  },
  {
    title: 'Download one model',
    detail:
      'Paste this into a terminal. It downloads a few gigabytes once, then never again. On 8 GB of RAM use llama3.2:1b instead.',
    command: 'ollama pull gemma4:e2b',
  },
  {
    title: 'Open a folder',
    detail:
      'File → Open Folder. This is required, not a suggestion: HirayaCoder confines every file operation to the folder you opened, so with no folder open there is nowhere it is allowed to work.',
  },
  {
    title: 'Pick your model above and start typing',
    detail:
      'The dropdown in this header lists what Ollama has installed. Ask for one thing at a time — "add a delete button to index.html" goes much better than "build me a social network".',
  },
];

/** @type {Array<{title: string, detail: string}>} */
const EXPECT = [
  {
    title: 'It is slower than you are used to',
    detail:
      'A task takes 1–5 minutes on a laptop with no graphics card, 20–60 seconds with one. The step panel shows you each action as it happens so you can tell "thinking" from "stuck" — and stop it when it is the second one.',
  },
  {
    title: 'Nothing is saved until you approve it',
    detail:
      'Every write shows you a diff first. Turn on Auto Edit from the Permissions button once you trust it; deleting a file asks even then.',
  },
  {
    title: 'A refusal is usually the checks working',
    detail:
      'Writes that would truncate a file, drop an export, or leave a stub inside a function are blocked before they reach the disk. Ask again — it usually gets it right the second time.',
  },
  {
    title: 'Small models are capable, not clever',
    detail:
      'One file, one feature, one fix at a time is where a local model is genuinely good. Handed a whole application it will write plausible files that do not run together. That is a real limit, not a setting you have missed.',
  },
  {
    title: 'Three modes, and Agent is the right default',
    detail:
      'Agent reads and writes. Plan looks without touching anything and hands back a checklist you can edit and then run. Ask answers a question with no tools at all. You do not need to switch to Ask to ask something — Agent notices a question and just answers it.',
  },
];

/**
 * One titled paragraph, optionally with a copyable-looking command under it.
 *
 * @param {string} tag  The element for the title — `li` items carry their own marker.
 * @param {{title: string, detail: string, command?: string}} entry
 * @returns {HTMLElement}
 */
function renderEntry(tag, entry) {
  const item = document.createElement(tag);
  item.className = 'guide-item';

  const title = document.createElement('span');
  title.className = 'guide-item-title';
  title.textContent = entry.title;
  item.appendChild(title);

  const detail = document.createElement('span');
  detail.className = 'guide-item-detail';
  detail.textContent = entry.detail;
  item.appendChild(detail);

  if (entry.command) {
    const command = document.createElement('code');
    command.className = 'guide-command';
    command.textContent = entry.command;
    item.appendChild(command);
  }

  return item;
}

/**
 * @param {string} heading
 * @param {string} listTag  `ol` for the ordered setup steps, `ul` for the rest.
 * @param {Array<{title: string, detail: string, command?: string}>} entries
 * @returns {DocumentFragment}
 */
function renderSection(heading, listTag, entries) {
  const fragment = document.createDocumentFragment();

  const title = document.createElement('h3');
  title.className = 'guide-heading';
  title.textContent = heading;
  fragment.appendChild(title);

  const list = document.createElement(listTag);
  list.className = 'guide-list';
  for (const entry of entries) list.appendChild(renderEntry('li', entry));
  fragment.appendChild(list);

  return fragment;
}

/**
 * Build the guide card.
 *
 * @param {() => void} onDismiss  Called when the reader closes it.
 * @returns {HTMLElement}
 */
export function renderGuide(onDismiss) {
  const wrapper = document.createElement('section');
  wrapper.className = 'guide';
  wrapper.setAttribute('aria-label', 'Setup guide');

  const bar = document.createElement('div');
  bar.className = 'guide-bar';

  const title = document.createElement('h2');
  title.className = 'guide-title';
  title.textContent = 'Setting up, and what to expect';
  bar.appendChild(title);

  const close = document.createElement('button');
  close.className = 'chip-remove';
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close the guide');
  close.addEventListener('click', () => onDismiss());
  bar.appendChild(close);

  wrapper.appendChild(bar);

  const blurb = document.createElement('p');
  blurb.className = 'guide-blurb';
  blurb.textContent =
    'Everything runs on your machine. No account, no internet after setup, and nothing you type or open leaves this computer.';
  wrapper.appendChild(blurb);

  wrapper.appendChild(renderSection('Setup — four steps', 'ol', SETUP));
  wrapper.appendChild(renderSection('What to expect', 'ul', EXPECT));

  return wrapper;
}

/** Exported for the tests, which assert the guide covers each of these. */
export const sections = { SETUP, EXPECT };
