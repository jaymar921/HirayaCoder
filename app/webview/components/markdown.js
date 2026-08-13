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
 * Fenced code, inline code, paragraphs, headings, bold, italic, and lists.
 *
 * The original scope was the first three, on the reasoning that "chat output from a
 * coding agent is prose and code, and every construct beyond that is another parser
 * branch operating on hostile input for very little benefit". The benefit turned out
 * not to be little. Models write structured answers whether or not anything renders
 * them, and the larger the model the more structure it uses — a perfectly good answer
 * about a project came back as a wall of text reading `## **LocoMenu - Hyper-Local
 * Food Price Intelligence Platform**` and `### Core Purpose`, with every `#` and `**`
 * on screen as punctuation.
 *
 * The hostile-input concern is answered by construction rather than by scope. Every
 * addition below emits elements and text nodes; none concatenates markup. Adding a
 * heading is `createElement('h3')`, which cannot be made to inject anything no matter
 * what the model puts in the text.
 *
 * Still deliberately absent: links, images, tables, and blockquotes. Links and images
 * carry a URL, which is the one piece of markdown that can *reach* somewhere, and the
 * CSP that would have to allow it is the CSP protecting everything else. Tables and
 * blockquotes are a real parser rather than a line classifier.
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

/**
 * The inline constructs. Each captures its content in group 1.
 *
 * Bold precedes italic so that `**x**` is not read as an italic `*` wrapping `x`
 * wrapping `*` — but that ordering only settles ties, since the scanner below picks by
 * position first. Both emphasis rules require a non-space first character so that
 * arithmetic and globs — `2 * 3 * 4`, `src/**` — do not become emphasis, and the
 * underscore rule additionally refuses to fire between word characters so that
 * `snake_case_name` survives.
 */
const INLINE_RULES = [
  // No newlines inside, so an unmatched backtick cannot swallow a paragraph.
  { pattern: /`([^`\r\n]+)`/, tag: 'code', className: 'inline-code', opaque: true },
  { pattern: /\*\*(\S[^*\r\n]*?)\*\*/, tag: 'strong' },
  { pattern: /__(\S[^_\r\n]*?)__/, tag: 'strong' },
  { pattern: /\*(\S[^*\r\n]*?)\*/, tag: 'em' },
  { pattern: /(?<![\w`])_(\S[^_\r\n]*?)_(?![\w`])/, tag: 'em' },
];

/**
 * How deep emphasis may nest before the rest is emitted as plain text.
 *
 * Every rule strips at least two delimiter characters, so the recursion below is
 * already bounded by the input length. This is a second, much smaller bound: real
 * output nests two or three deep, and a cap keeps a pathological line from building a
 * tree thousands of elements tall.
 */
const MAX_INLINE_DEPTH = 8;

/**
 * Find the match that starts earliest in the text.
 *
 * ## Why position beats rule order
 *
 * The first version tried each rule over the whole string in turn, code first. That
 * made a backtick span opaque, which is right — `` `**kwargs` `` must not become
 * emphasis — but it also meant a bold span *containing* code could never match, because
 * the code rule had already cut the string into three pieces and the `**` markers
 * ended up in different pieces. ``**run `npm test` now**`` rendered with its asterisks
 * showing, which is the same class of bug this module was being fixed for.
 *
 * Scanning by position handles both: in ``**run `npm test` now**`` the bold starts at 0
 * and the code at 6, so bold wins and its content is re-scanned, picking up the code
 * inside. In ``use `**kwargs` here`` no bold match exists at all, so the code wins and
 * its content is left alone.
 *
 * @param {string} text
 * @returns {{rule: typeof INLINE_RULES[number], match: RegExpExecArray} | null}
 */
function firstInlineMatch(text) {
  /** @type {{rule: typeof INLINE_RULES[number], match: RegExpExecArray} | null} */
  let best = null;

  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    // Strictly earlier only, so an earlier rule in the list wins a tie — which is what
    // keeps `**` from being claimed by the single-asterisk italic rule.
    if (!best || match.index < best.match.index) best = { rule, match };
  }

  return best;
}

/**
 * Append a run of text, converting inline markdown into elements.
 *
 * @param {HTMLElement} parent
 * @param {string} text
 * @param {number} [depth]
 */
function appendInline(parent, text, depth = 0) {
  if (!text) return;

  if (depth >= MAX_INLINE_DEPTH) {
    parent.appendChild(document.createTextNode(text));
    return;
  }

  let cursor = 0;

  for (;;) {
    const found = firstInlineMatch(text.slice(cursor));
    if (!found) break;

    const { rule, match } = found;
    const start = cursor + match.index;

    if (start > cursor) {
      parent.appendChild(document.createTextNode(text.slice(cursor, start)));
    }

    const element = document.createElement(rule.tag);
    if (rule.className) element.className = rule.className;
    if (rule.opaque) {
      // Code is opaque: its content is text, never markup, whatever it contains.
      element.textContent = match[1];
    } else {
      appendInline(element, match[1], depth + 1);
    }
    parent.appendChild(element);

    cursor = start + match[0].length;
  }

  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

/** `# ` through `###### ` at the start of a line. */
const HEADING = /^(#{1,6})\s+(.*)$/;

/** `- `, `* `, `+ ` — an unordered item. */
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;

/** `1. `, `2) ` — an ordered item. */
const ORDERED = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;

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
      appendBlock(fragment, block);
    }
  }

  return fragment;
}

/**
 * Render one blank-line-delimited block.
 *
 * A block is not necessarily one construct — models routinely emit a heading and its
 * first sentence with no blank line between them, and a list immediately under its
 * introduction. So this walks line by line and starts a new element whenever the line's
 * kind changes, rather than classifying the block as a whole.
 *
 * @param {DocumentFragment} fragment
 * @param {string} block
 */
function appendBlock(fragment, block) {
  /** @type {HTMLElement | null} */
  let list = null;
  /** @type {HTMLElement | null} */
  let paragraph = null;

  const closeAll = () => {
    list = null;
    paragraph = null;
  };

  for (const line of block.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading) {
      closeAll();
      // Clamped to h3–h6. The panel already has its own heading hierarchy, and a model
      // that opens with `#` should not be emitting a page title into the middle of a
      // conversation.
      const level = Math.min(6, heading[1].length + 2);
      const element = document.createElement(`h${level}`);
      element.className = 'md-h';
      appendInline(element, heading[2].trim());
      fragment.appendChild(element);
      continue;
    }

    const ordered = ORDERED.exec(line);
    const bullet = ordered ? null : BULLET.exec(line);

    if (ordered || bullet) {
      const wanted = ordered ? 'OL' : 'UL';
      if (!list || list.tagName !== wanted) {
        paragraph = null;
        list = document.createElement(ordered ? 'ol' : 'ul');
        list.className = 'md-list';
        // `1)` and `7.` both happen; honouring the first number keeps a list the model
        // started at 3 from silently renumbering to 1.
        if (ordered && ordered[1] !== '1') list.setAttribute('start', ordered[1]);
        fragment.appendChild(list);
      }
      const item = document.createElement('li');
      appendInline(item, (ordered ? ordered[2] : bullet[1]).trim());
      list.appendChild(item);
      continue;
    }

    if (!line.trim()) continue;

    // Ordinary prose. A continuation line joins the paragraph it follows.
    if (!paragraph) {
      list = null;
      paragraph = document.createElement('p');
      paragraph.className = 'md-p';
      fragment.appendChild(paragraph);
    } else {
      paragraph.appendChild(document.createElement('br'));
    }
    appendInline(paragraph, line);
  }
}
