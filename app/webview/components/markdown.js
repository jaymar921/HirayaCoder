/**
 * The only thing in this extension that turns model text into DOM.
 *
 * ## It never produces HTML
 *
 * There is no `innerHTML` here, and there must never be. Everything this module
 * returns is built with `createElement` and `textContent`, so a model that emits
 * `<img src=x onerror=...>` — or a file it read that contained one — puts those
 * characters on screen as characters. Escaping-then-concatenating is the usual
 * approach and the usual source of XSS: one missed branch is a hole. Building nodes
 * has no such branch.
 *
 * The webview's CSP already forbids inline and remote script, so this is the second
 * layer rather than the only one. Both are cheap; neither is sufficient alone.
 *
 * ## Scope
 *
 * A deliberately small subset of Markdown: fenced code, inline code, and paragraphs.
 * Chat output from a coding agent is prose and code, and every construct beyond that
 * is another parser branch operating on hostile input for very little benefit.
 */

/** ```lang\n…\n``` — the fence must start a line. */
const FENCE = /^```([\w+-]*)[ \t]*\r?\n([\s\S]*?)```[ \t]*$/gm;

/**
 * Split text into code and non-code segments.
 *
 * Exported for tests: the segmentation is the part worth checking, since the
 * rendering below is a mechanical walk over it.
 *
 * @param {string} text
 * @returns {Array<{type: 'text' | 'code', content: string, lang?: string}>}
 */
export function segment(text) {
  const source = String(text == null ? '' : text);
  /** @type {Array<{type: 'text' | 'code', content: string, lang?: string}>} */
  const parts = [];
  let index = 0;

  FENCE.lastIndex = 0;
  let match = FENCE.exec(source);
  while (match) {
    if (match.index > index) {
      parts.push({ type: 'text', content: source.slice(index, match.index) });
    }
    parts.push({ type: 'code', lang: match[1] || '', content: match[2].replace(/\r?\n$/, '') });
    index = match.index + match[0].length;
    match = FENCE.exec(source);
  }

  if (index < source.length) parts.push({ type: 'text', content: source.slice(index) });
  // An unterminated fence is common mid-stream, while tokens are still arriving.
  // Treating the remainder as text keeps it readable instead of hiding it.
  return parts.filter((part) => part.type === 'code' || part.content.trim().length > 0);
}

/** `code` — no newlines inside, so an unmatched backtick cannot swallow a paragraph. */
const INLINE_CODE = /`([^`\r\n]+)`/g;

/**
 * Append a run of text, turning `inline code` into <code> elements.
 *
 * @param {HTMLElement} parent
 * @param {string} text
 */
function appendInline(parent, text) {
  let cursor = 0;
  INLINE_CODE.lastIndex = 0;

  let match = INLINE_CODE.exec(text);
  while (match) {
    if (match.index > cursor) {
      parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    }
    const code = document.createElement('code');
    code.className = 'inline-code';
    code.textContent = match[1];
    parent.appendChild(code);
    cursor = match.index + match[0].length;
    match = INLINE_CODE.exec(text);
  }

  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

/**
 * Build a code block with a language label and a copy button.
 *
 * @param {string} code
 * @param {string} lang
 * @returns {HTMLElement}
 */
function buildCodeBlock(code, lang) {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';

  const header = document.createElement('div');
  header.className = 'code-block-header';

  const label = document.createElement('span');
  label.className = 'code-lang';
  label.textContent = lang || 'code';
  header.appendChild(label);

  const copy = document.createElement('button');
  copy.className = 'code-copy';
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    // `writeText` can reject when the webview lacks focus; the label is the only
    // feedback the user gets, so it must not claim success on failure.
    navigator.clipboard.writeText(code).then(
      () => {
        copy.textContent = 'Copied';
        setTimeout(() => {
          copy.textContent = 'Copy';
        }, 1200);
      },
      () => {
        copy.textContent = 'Press Ctrl+C';
      }
    );
  });
  header.appendChild(copy);

  const pre = document.createElement('pre');
  const codeEl = document.createElement('code');
  if (lang) codeEl.dataset.lang = lang;
  codeEl.textContent = code;
  pre.appendChild(codeEl);

  wrapper.appendChild(header);
  wrapper.appendChild(pre);
  return wrapper;
}

/**
 * Render text into a fragment of safe DOM nodes.
 *
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function render(text) {
  const fragment = document.createDocumentFragment();

  for (const part of segment(text)) {
    if (part.type === 'code') {
      fragment.appendChild(buildCodeBlock(part.content, part.lang || ''));
      continue;
    }

    // Blank lines separate paragraphs; single newlines are kept inside one.
    for (const block of part.content.split(/\n{2,}/)) {
      if (!block.trim()) continue;
      const paragraph = document.createElement('p');
      paragraph.className = 'md-p';
      const lines = block.split('\n');
      lines.forEach((line, i) => {
        appendInline(paragraph, line);
        if (i < lines.length - 1) paragraph.appendChild(document.createElement('br'));
      });
      fragment.appendChild(paragraph);
    }
  }

  return fragment;
}
