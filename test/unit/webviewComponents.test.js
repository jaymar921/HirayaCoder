'use strict';

/**
 * The webview's pure logic.
 *
 * These modules are ES modules meant for a browser, so they are pulled in with a
 * dynamic `import()` rather than `require`. Only the parts that do not touch the DOM
 * are exercised here — the rendering itself needs a document, which belongs in the
 * integration suite.
 */

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const moduleUrl = (relative) =>
  pathToFileURL(path.join(__dirname, '..', '..', 'app', 'webview', relative)).href;

describe('webview markdown segmentation', () => {
  /** @type {(text: string) => Array<{type: string, content: string, lang?: string}>} */
  let segment;

  before(async () => {
    // The specifier is built from `__dirname` and a literal in this file — no input
    // reaches it. The rule cannot see that, and turning it off for the whole test
    // tree would also disarm it where it matters.
    // eslint-disable-next-line no-unsanitized/method
    ({ segment } = await import(moduleUrl('components/markdown.js')));
  });

  it('leaves ordinary prose as one text segment', () => {
    assert.deepStrictEqual(segment('Just a sentence.'), [{ type: 'text', content: 'Just a sentence.' }]);
  });

  it('extracts a fenced block with its language', () => {
    const parts = segment('Before\n\n```js\nconst a = 1;\n```\n\nAfter');

    assert.strictEqual(parts.length, 3);
    assert.strictEqual(parts[1].type, 'code');
    assert.strictEqual(parts[1].lang, 'js');
    assert.strictEqual(parts[1].content, 'const a = 1;');
  });

  it('handles a fence with no language', () => {
    const parts = segment('```\nplain\n```');
    assert.strictEqual(parts[0].type, 'code');
    assert.strictEqual(parts[0].lang, '');
    assert.strictEqual(parts[0].content, 'plain');
  });

  it('keeps braces and backticks inside a code block', () => {
    // Agent output is full of these; a naive splitter mangles them.
    const code = 'function f() {\n  return `a${b}c`;\n}';
    const parts = segment('```js\n' + code + '\n```');
    assert.strictEqual(parts[0].content, code);
  });

  it('extracts several blocks in one message', () => {
    const parts = segment('```js\none\n```\ntext\n```py\ntwo\n```');
    const code = parts.filter((p) => p.type === 'code');
    assert.strictEqual(code.length, 2);
    assert.strictEqual(code[0].content, 'one');
    assert.strictEqual(code[1].lang, 'py');
  });

  it('treats an unterminated fence as text rather than swallowing the message', () => {
    // Common while tokens are still arriving. Hiding the tail would look like a hang.
    const parts = segment('Here you go:\n```js\nconst a = 1;');
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0].type, 'text');
    assert.match(parts[0].content, /const a = 1;/);
  });

  it('is stable across repeated calls', () => {
    // The fence pattern is global and module-level; a stale lastIndex would make the
    // second call on identical input return something different.
    const text = '```js\nx\n```';
    assert.deepStrictEqual(segment(text), segment(text));
  });

  it('handles empty and null input', () => {
    assert.deepStrictEqual(segment(''), []);
    assert.deepStrictEqual(segment(null), []);
  });
});

/**
 * A DOM small enough to prove the one property that matters.
 *
 * `markdown.js` is allowed to call exactly four things — `createElement`,
 * `createTextNode`, `createDocumentFragment`, `appendChild` — plus `textContent`,
 * `className`, and `setAttribute`. There is deliberately no `innerHTML` on these nodes:
 * if the renderer ever reaches for one, these tests fail with a TypeError rather than
 * quietly passing, which is a stronger guarantee than asserting on output strings.
 */
function installStubDom() {
  const makeNode = (tag) => ({
    tagName: String(tag).toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    className: '',
    type: '',
    _text: '',
    get textContent() {
      if (this._text) return this._text;
      return this.children.map((child) => child.textContent).join('');
    },
    set textContent(value) {
      this._text = String(value);
      this.children = [];
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    // Recorded rather than ignored: a button whose handler is never attached looks
    // identical to a wired one in a structural assertion, and that is precisely the
    // bug worth catching in a card made of buttons.
    listeners: {},
    addEventListener(event, handler) {
      this.listeners[event] = handler;
    },
    click() {
      if (this.listeners.click) this.listeners.click();
    },
  });

  const previous = global.document;
  global.document = {
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => ({ tagName: '#text', children: [], textContent: String(text) }),
    createDocumentFragment: () => makeNode('#fragment'),
  };
  return () => {
    global.document = previous;
  };
}

/** Flatten a node tree to `tag(children)` so a structural assertion reads as one line. */
function shape(node) {
  if (node.tagName === '#text') return JSON.stringify(node.textContent);
  const inner = node.children.map(shape).join(',');
  return node._text ? `${node.tagName}(${JSON.stringify(node._text)})` : `${node.tagName}(${inner})`;
}

describe('webview markdown rendering', () => {
  /** @type {(text: string) => any} */
  let render;
  /** @type {() => void} */
  let restore;

  before(async () => {
    // See the note above — the specifier is local and literal.
    // eslint-disable-next-line no-unsanitized/method
    ({ render } = await import(moduleUrl('components/markdown.js')));
  });

  beforeEach(() => {
    restore = installStubDom();
  });

  afterEach(() => restore());

  /** @param {string} text */
  const tags = (text) => render(text).children.map((child) => child.tagName);
  /** Shape of the single top-level node, without the fragment wrapper. */
  const one = (text) => shape(render(text).children[0]);

  it('renders headings as heading elements, not as hashes', () => {
    // The reported bug: "## **LocoMenu — …**" and "### Core Purpose" appeared on screen
    // with their punctuation intact.
    const out = render('## LocoMenu\n\n### Core Purpose');
    assert.deepStrictEqual(
      out.children.map((c) => c.tagName),
      ['H4', 'H5']
    );
    assert.strictEqual(out.children[0].textContent, 'LocoMenu');
    assert.strictEqual(out.children[1].textContent, 'Core Purpose');
  });

  it('renders bold and italic as elements', () => {
    assert.strictEqual(one('**bold** and *thin*'), 'P(STRONG("bold")," and ",EM("thin"))');
    assert.strictEqual(one('__bold__'), 'P(STRONG("bold"))');
  });

  it('renders a heading that is itself bold, without leaving asterisks', () => {
    // Exactly the reported line shape.
    const out = render('## **LocoMenu - Hyper-Local Food Price Intelligence Platform**');
    assert.strictEqual(out.children[0].tagName, 'H4');
    assert.strictEqual(out.children[0].textContent, 'LocoMenu - Hyper-Local Food Price Intelligence Platform');
    assert.strictEqual(shape(out.children[0].children[0]), 'STRONG("LocoMenu - Hyper-Local Food Price Intelligence Platform")');
  });

  it('renders bullet and numbered lists', () => {
    assert.deepStrictEqual(tags('- one\n- two'), ['UL']);
    assert.strictEqual(render('- one\n- two').children[0].children.length, 2);

    const ordered = render('1. first\n2. second');
    assert.strictEqual(ordered.children[0].tagName, 'OL');
    assert.strictEqual(ordered.children[0].children[0].textContent, 'first');
  });

  it('keeps a list numbered from where the model started it', () => {
    const out = render('3. third\n4. fourth');
    assert.strictEqual(out.children[0].attributes.start, '3');
  });

  it('starts a new element when the line kind changes mid-block', () => {
    // Models emit a heading and its list with no blank line between them.
    assert.deepStrictEqual(tags('### Features\n- one\n- two\nAnd some prose.'), ['H5', 'UL', 'P']);
  });

  it('leaves markdown inside a code fence completely alone', () => {
    const out = render('```md\n## Not a heading\n**not bold**\n```');
    assert.strictEqual(out.children[0].className, 'code-block');
    assert.match(out.children[0].textContent, /## Not a heading/);
    assert.match(out.children[0].textContent, /\*\*not bold\*\*/);
  });

  it('leaves emphasis inside inline code alone', () => {
    assert.strictEqual(one('use `**kwargs` here'), 'P("use ",CODE("**kwargs")," here")');
  });

  it('does not turn arithmetic or globs into emphasis', () => {
    assert.strictEqual(one('2 * 3 * 4'), 'P("2 * 3 * 4")');
    assert.strictEqual(one('snake_case_name and other_thing'), 'P("snake_case_name and other_thing")');
  });

  it('nests inline code inside bold', () => {
    assert.strictEqual(one('**run `npm test` now**'), 'P(STRONG("run ",CODE("npm test")," now"))');
  });

  it('never produces markup from hostile text — it produces characters', () => {
    // The property the whole module exists for. A heading is still just text.
    const out = render('## <img src=x onerror=alert(1)>\n\n- <script>alert(1)</script>');
    assert.strictEqual(out.children[0].textContent, '<img src=x onerror=alert(1)>');
    assert.strictEqual(out.children[1].children[0].textContent, '<script>alert(1)</script>');
    // And nothing anywhere claimed to be an IMG or a SCRIPT element.
    const everyTag = [];
    const walk = (n) => {
      everyTag.push(n.tagName);
      (n.children || []).forEach(walk);
    };
    walk(out);
    assert.ok(!everyTag.includes('IMG'));
    assert.ok(!everyTag.includes('SCRIPT'));
  });

  it('renders the reported answer without leaving any markdown punctuation', () => {
    const reported = [
      '## **LocoMenu - Hyper-Local Food Price Intelligence Platform**',
      '',
      '### Core Purpose',
      'A community-powered platform that helps people discover food prices.',
      '',
      '### Key Features',
      '1. **Price Discovery**: Interactive map showing live prices',
      '2. **Crowdsourced Contributions**: Users can submit new prices',
    ].join('\n');

    const out = render(reported);
    assert.deepStrictEqual(
      out.children.map((c) => c.tagName),
      ['H4', 'H5', 'P', 'H5', 'OL']
    );
    // No stray `#` or `**` survived anywhere in the rendered text.
    assert.doesNotMatch(out.textContent, /\*\*/);
    assert.doesNotMatch(out.textContent, /^#/m);
  });

  it('still handles plain prose and empty input', () => {
    assert.deepStrictEqual(tags('Just a sentence.'), ['P']);
    assert.deepStrictEqual(tags(''), []);
  });
});

describe('step panel rows', () => {
  /** @type {(action: object) => {verb: string, target: string, status: string, full: string}} */
  let describeStep;

  before(async () => {
    // eslint-disable-next-line no-unsanitized/method
    ({ describeStep } = await import(moduleUrl('components/messageBubble.js')));
  });

  it('names the action in the language of what it does', () => {
    // `read_file` is the identifier the model is required to emit. Showing it to the
    // user leaks the tool protocol into the surface that is meant to explain the run.
    assert.strictEqual(describeStep({ action: 'read_file', path: 'README.md' }).verb, 'Reading');
    assert.strictEqual(describeStep({ action: 'run_script', command: 'npm install' }).verb, 'Running');
    assert.strictEqual(describeStep({ action: 'write_file', path: 'src/App.jsx' }).verb, 'Editing');
  });

  it('falls back to the raw name for an action it does not know', () => {
    assert.strictEqual(describeStep({ action: 'some_new_tool' }).verb, 'some_new_tool');
  });

  it('shows what the step is being done to, whichever field carries it', () => {
    assert.strictEqual(describeStep({ action: 'read_file', path: 'src/App.jsx' }).target, 'src/App.jsx');
    assert.strictEqual(describeStep({ action: 'run_script', command: 'npm run build' }).target, 'npm run build');
    assert.strictEqual(describeStep({ action: 'search_workspace', query: 'useTodos' }).target, 'useTodos');
    assert.strictEqual(describeStep({ action: 'list_files' }).target, '');
  });

  it('carries the reason the model gave for the step', () => {
    const row = describeStep({ action: 'read_file', path: 'README.md', thought: 'extracting project structure' });
    assert.strictEqual(row.status, 'extracting project structure');
  });

  it('collapses a multi-line reason so one step stays one row', () => {
    const row = describeStep({ action: 'read_file', path: 'a.js', thought: 'first line\n\nsecond   line' });
    assert.strictEqual(row.status, 'first line second line');
  });

  it('cuts a long reason but keeps the whole of it for the tooltip', () => {
    const long = `I need to check ${'a lot of things '.repeat(20)}`;
    const row = describeStep({ action: 'read_file', path: 'a.js', thought: long });

    assert.ok(row.status.length <= 110, `the row would not fit on one line (${row.status.length})`);
    assert.match(row.status, /…$/);
    assert.ok(row.full.length > row.status.length, 'the full reason was lost');
  });

  it('reports no status at all when the model gave no reason', () => {
    assert.strictEqual(describeStep({ action: 'read_file', path: 'a.js' }).status, '');
    assert.strictEqual(describeStep({ action: 'read_file', path: 'a.js', thought: '   ' }).status, '');
  });

  it('survives an action object with nothing in it', () => {
    const row = describeStep({});
    assert.strictEqual(row.verb, '');
    assert.strictEqual(row.target, '');
    assert.strictEqual(row.status, '');
  });
});

describe('thinking indicator lines', () => {
  /** @type {any} */
  let mod;

  before(async () => {
    // See the note above — the specifier is local and literal.
    // eslint-disable-next-line no-unsanitized/method
    mod = await import(moduleUrl('components/thinkingIndicator.js'));
  });

  it('offers enough lines that a long wait does not visibly repeat', () => {
    assert.ok(mod.THINKING_LINES.length >= 8);
    assert.ok(mod.LONG_WAIT_LINES.length >= 3);
  });

  it('has no duplicate lines', () => {
    const all = [...mod.THINKING_LINES, ...mod.LONG_WAIT_LINES];
    assert.strictEqual(new Set(all).size, all.length);
  });

  it('never repeats the line it just showed', () => {
    // The rotation is what makes the wait feel alive; showing the same line twice in
    // a row reads as frozen, which is the thing this component exists to avoid.
    for (let i = 0; i < 200; i += 1) {
      const previous = mod.THINKING_LINES[i % mod.THINKING_LINES.length];
      assert.notStrictEqual(mod.pickLine(mod.THINKING_LINES, previous), previous);
    }
  });

  it('copes with a single-line pool', () => {
    assert.strictEqual(mod.pickLine(['only'], 'only'), 'only');
    assert.strictEqual(mod.pickLine([], 'x'), '');
  });
});

describe('the setup guide card', () => {
  /** @type {(onDismiss: () => void) => any} */
  let renderGuide;
  /** @type {{SETUP: any[], EXPECT: any[]}} */
  let sections;
  /** @type {() => void} */
  let restore;

  before(async () => {
    // See the note above — the specifier is local and literal.
    // eslint-disable-next-line no-unsanitized/method
    ({ renderGuide, sections } = await import(moduleUrl('components/guideCard.js')));
  });

  beforeEach(() => {
    restore = installStubDom();
  });

  afterEach(() => restore());

  /** Every node in the tree carrying this class. */
  const allWithClass = (node, className) => {
    const found = node.className === className ? [node] : [];
    for (const child of node.children) found.push(...allWithClass(child, className));
    return found;
  };

  const firstWithClass = (node, className) => allWithClass(node, className)[0];

  it('renders one item per documented step and expectation', () => {
    const card = renderGuide(() => {});
    const items = allWithClass(card, 'guide-item');
    assert.strictEqual(items.length, sections.SETUP.length + sections.EXPECT.length);
  });

  it('gives every item both a title and the detail under it', () => {
    const card = renderGuide(() => {});
    for (const item of allWithClass(card, 'guide-item')) {
      assert.ok(firstWithClass(item, 'guide-item-title').textContent.length > 0);
      assert.ok(firstWithClass(item, 'guide-item-detail').textContent.length > 0);
    }
  });

  it('closes through the callback rather than by touching the DOM itself', () => {
    // The card does not know where it was appended, so dismissal has to go back to
    // whoever put it there. A close button that removed its own wrapper would leave
    // the header button still reading "pressed".
    let closed = 0;
    const card = renderGuide(() => {
      closed += 1;
    });

    const close = allWithClass(card, 'chip-remove')[0];
    assert.ok(close, 'the card has a close button');
    assert.strictEqual(close.attributes['aria-label'], 'Close the guide');

    close.click();
    assert.strictEqual(closed, 1);
  });

  it('puts a command in a code element, not in prose', () => {
    const card = renderGuide(() => {});
    const commands = allWithClass(card, 'guide-command');
    assert.ok(commands.length > 0, 'at least one step has a command to paste');
    for (const command of commands) assert.strictEqual(command.tagName, 'CODE');
  });

  /*
    Content assertions, because this card is the only place a first-time user is told
    these things, and a well-meaning edit that drops one of them costs a user their
    first session. Each is checked as a fact the guide states, not as exact wording.
  */
  it('names what has to be installed and the one command that installs a model', () => {
    const text = renderGuide(() => {}).textContent;
    assert.match(text, /Ollama/);
    assert.match(text, /ollama pull/);
    assert.match(text, /Open Folder/i);
  });

  it('sets expectations about speed, approval, and the three modes', () => {
    const text = renderGuide(() => {}).textContent;
    assert.match(text, /1–5 minutes/);
    assert.match(text, /approve/i);
    for (const mode of ['Agent', 'Plan', 'Ask']) assert.match(text, new RegExp(mode));
  });
});
