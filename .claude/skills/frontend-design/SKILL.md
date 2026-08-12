---
name: frontend-design
description: Conventions for building HirayaCoder's webview UI — spacing, type scale, colour, accent use, motion, and the componentisation rules. Read this before writing or changing anything under app/webview/.
---

# Frontend design conventions

These are the rules `app/webview/style.css` and `app/webview/components/*` already
follow. That code is the worked example: when this file and the CSS disagree, read the
CSS first — it was written against a real editor and a real theme, and it is more
likely to be right.

The context these rules are for: a **VS Code webview panel** that is a guest inside
someone else's editor, rendering text produced by a **local language model** that must
never be trusted as markup.

## 1. Inherit the host theme

Colour comes from `--vscode-*` variables. Never a hardcoded hex for anything
structural — background, foreground, border, surface.

```css
background: var(--vscode-editor-background);
color: var(--vscode-foreground);
font-family: var(--vscode-font-family);
font-size: var(--vscode-font-size);
```

Give every `--vscode-*` reference a fallback, because not every theme defines every
token:

```css
--border: var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
--muted: var(--vscode-descriptionForeground, rgba(128, 128, 128, 0.9));
--surface: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
```

A panel that ignores the user's theme looks broken no matter how good its palette is,
and there is no way to test against every theme they might have installed. Inheriting
is the only approach that survives contact with a theme nobody anticipated.

The same reasoning applies to type: body text inherits the editor's font size rather
than setting its own, so the panel matches whatever the user has already tuned.

## 2. One spacing scale

A 4px base, as tokens. Everything lands on a common grid.

```css
--sp-1: 4px;  --sp-2: 8px;   --sp-3: 12px;
--sp-4: 16px; --sp-5: 24px;  --sp-6: 32px;
```

No ad-hoc pixel values in rules. If a gap needs 10px, it needs `--sp-2` or `--sp-3` —
the specific number is never the point, and one-off values are what turn a layout into
something nobody can adjust later. Radii (`--radius`, `--radius-lg`) and the small type
steps (`--fs-sm`, `--fs-xs`) are tokens for the same reason.

## 3. Accent sparingly

The sunrise gradient — "hiraya", the spark — appears on exactly four things:

1. the send button,
2. the active step,
3. the thinking dots,
4. the welcome glyph.

```css
--sunrise-a: #ff9a3c;
--sunrise-b: #ff5f6d;
--sunrise: linear-gradient(115deg, var(--sunrise-a), var(--sunrise-b));
```

These are the only hardcoded colours in the stylesheet, and they are deliberate: the
accent is the extension's identity, not the theme's. Spread onto a fifth and sixth
element it stops reading as an accent and starts reading as decoration. Before adding
it somewhere new, ask what it is marking; if the answer is "this looks nice here",
that is the wrong answer.

## 4. Wide content scrolls inside its own box

Code blocks, tables, and traces get `overflow-x: auto` on their own container. The page
body must never scroll sideways.

```css
.code-block {
  overflow-x: auto;
}
```

A model emits a 200-character line eventually. When it does, the panel should show a
scrollbar on that block — not shove the composer off screen.

## 5. Respect `prefers-reduced-motion`

Under `prefers-reduced-motion: reduce`, animation stops. The element does not.

```css
@media (prefers-reduced-motion: reduce) {
  .thinking-spark i {
    animation: none;
    opacity: 0.8;
  }
}
```

A static indicator still says "working". A missing one says "finished", which is a
lie — and during a two-minute local inference on a CPU-only machine, it is the lie that
matters most.

## 6. Never build markup from model text

`createElement` + `textContent`. Never `innerHTML`, never string-concatenated HTML,
never `insertAdjacentHTML`.

```js
const text = document.createElement('span');
text.className = 'todo-text';
text.textContent = item.text;   // model output — data, never markup
```

This is a security rule and it lives in the design guide on purpose: it is a rule
someone breaks while adding a component, not while thinking about security. Everything
the panel renders — summaries, observations, file paths, TODO items — originated
either in the model or in a file the model read. Markdown rendering goes through
`components/markdown.js`, which builds nodes; extending that file means extending the
node builder, not reaching for `innerHTML`.

The webview is also the only place in the extension that must not be trusted. It
renders and collects clicks; it never names a file to open or a path to read. It asks
the host to open VS Code's own picker instead. Keep new controls on that side of the
line.

## 7. Componentise by behaviour, not by control

`app/webview/components/` holds modules with real logic: `markdown.js`,
`messageBubble.js`, `thinkingIndicator.js`, `planChecklist.js`. A 15-line dropdown that
posts one message stays inline in `main.js`.

Splitting a trivial control into its own module buys a file, an import, and a message
protocol, and costs the ability to read the thing in one place. Extract when there is
state to own or a rendering decision to make — not to satisfy a file layout.
