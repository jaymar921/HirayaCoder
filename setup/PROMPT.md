# HirayaCoder — Master Build Prompt

> Store this file at `/setup/PROMPT.md`. Feed it to a coding AI (Claude Code, Cursor, Copilot Workspace, etc.) as the top-level system/task prompt to scaffold and implement the extension end-to-end. It is written to be run once for the initial build and re-run per phase for iterative feature work.

---

## 1. Role & Mission

You are a senior VS Code extension engineer and application-security reviewer. Build **HirayaCoder** — a fully offline, privacy-first AI coding agent that runs as a VS Code extension and talks exclusively to a **local Ollama** instance. No telemetry, no cloud LLM calls, no data leaves the developer's machine.

**Tagline:** *A local Filipino-inspired AI programmer that helps you generate, refactor, and understand code directly inside VS Code. Built for developers who want fast, private, and imaginative coding assistance — hiraya, the power of imagination, brought into your workflow.*

**Author:** `jaymar921`

**Hard constraint:** the extension must remain usable on a low-spec laptop (typically 16GB RAM, integrated graphics, no dGPU) running a **1B-parameter model** such as `llama3.2:1b`. HirayaCoder must be **agentic on every model, including 1B ones** — it plans, reads files, proposes edits across multiple files, deletes files when asked, runs build/test scripts, and iterates on its own within a task, the way Claude Code and GitHub Copilot Chat do. The only thing that changes between a strong model and a weak one is *how* the agent loop is implemented and how much it leans on persisted memory — never *whether* the model gets to act autonomously within a task.

**Platform requirement:** HirayaCoder must work identically on **macOS, Windows, and Linux** — every filesystem path operation, shell/script execution, and Ollama connection must be cross-platform safe (no hardcoded `/` or `\`, no POSIX-only shell assumptions).

---

## 2. Tech Stack (fixed)

- **Language:** JavaScript (Node.js ≥ 18), CommonJS or ESM — no TypeScript compilation step required, but JSDoc types are mandatory for editor intellisense.
- **Runtime:** VS Code Extension API (`vscode` engine), Node.js host process.
- **LLM backend:** [Ollama](https://ollama.com) local HTTP API (`http://127.0.0.1:11434`) only. No other network egress permitted anywhere in the codebase.
- **Packaging:** `vsce` / `@vscode/vsce` for `.vsix` builds.
- **Testing:** `mocha` + `@vscode/test-electron` for integration, `sinon` for mocks.
- **Lint/Security tooling:** `eslint`, `eslint-plugin-security`, `eslint-plugin-no-unsanitized`, `npm audit`, `semgrep` (offline ruleset), `retire.js`.
- **Cross-platform primitives:** use `path.join`/`path.resolve` (never string concatenation) for all paths; use Node's `os.platform()` to select the correct shell (`cmd.exe`/`powershell` on Windows, `/bin/sh` or `/bin/bash` on macOS/Linux) inside `security/scriptRunner.js`.

---

## 3. Required Repository Layout

Generate and respect this exact structure. Do not flatten it.

```
HirayaCoder/
├── README.md                     # Project overview, badges, quickstart, author, license
├── package.json                  # VS Code extension manifest — author: "jaymar921", icon field set
├── CHANGELOG.md
├── LICENSE
├── .eslintrc.json
├── .vscodeignore
├── .gitignore                    # See section 11 — must exclude all HirayaCoder-generated files
├── /app/                         # Extension source code (the actual product)
│   ├── extension.js              # Activation entrypoint
│   ├── /core/
│   │   ├── ollamaClient.js       # HTTP wrapper for Ollama API (chat/generate/tags/show)
│   │   ├── modelDiscovery.js     # Calls /api/tags, lists installed models, classifies size/tier, flags a ">7B available" recommendation
│   │   ├── modelCapability.js    # Detects native tool-calling support, sets loop strategy
│   │   ├── promptRouter.js       # Chooses native tool-calling loop vs. simulated ReAct loop
│   │   ├── contextBuilder.js     # Gathers file/selection/workspace/context-file/memory context, token-budgets it
│   │   ├── contextTranslator.js  # "Smartens up" small models: condenses conversation + task into a compact memory-ready summary
│   │   ├── memoryStore.js        # In-memory cache + plain-text persistence at .hirayacoder/memory/session<N>.txt
│   │   ├── contextFilesManager.js# Tracks user-attached reference files (add/remove/list/read) fed into every prompt
│   │   └── outputParser.js       # Parses structured JSON action objects from any model
│   ├── /agent/
│   │   ├── agentSession.js       # Unified agent loop driver: plan → act → observe → repeat, shared by both strategies
│   │   ├── plannerAgent.js       # Optional up-front multi-step plan (used by both tiers; skippable for trivial tasks)
│   │   ├── toolRegistry.js       # Declares available tools + JSON schemas (shared source of truth for both loop strategies)
│   │   ├── tools/
│   │   │   ├── readFile.js
│   │   │   ├── writeFile.js      # Always requires confirmation before write (unless auto-edit mode is on)
│   │   │   ├── deleteFile.js     # Always requires confirmation before delete (unless auto-edit mode is on)
│   │   │   ├── listFiles.js
│   │   │   ├── searchWorkspace.js
│   │   │   ├── runTests.js
│   │   │   └── runScript.js      # Runs bash/cmd/powershell/npm/build commands via scriptRunner.js — always gated
│   │   ├── nativeToolLoop.js     # Drives the loop via Ollama's native tool-calling (Tier A)
│   │   └── reactLoop.js          # Drives the same loop via constrained single-action JSON turns (Tier B / small models)
│   ├── /features/
│   │   ├── chatTab.js            # Opens HirayaCoder chat as its own editor TAB (like Copilot Chat / Claude Code), not just a sidebar
│   │   ├── welcomeScreen.js      # First-run / empty-session welcome view inside the chat tab
│   │   ├── inlineCompletion.js   # InlineCompletionItemProvider
│   │   ├── codeActions.js        # Refactor / Explain / Document / Fix quick actions
│   │   ├── testGenerator.js
│   │   ├── diffApply.js          # Shows diff, requires accept before write (unless auto-edit mode is on)
│   │   └── modelManager.js       # Backs the model dropdown: list/pull/switch Ollama models, surfaces tier + recommendation
│   ├── /security/
│   │   ├── permissionGate.js     # Central approval gate for FS/exec actions
│   │   ├── permissionModes.js    # Tracks the 4 permission states: approve-edits / auto-edit / approve-scripts / auto-approve-scripts
│   │   ├── scriptRunner.js       # Cross-platform bash/cmd/powershell execution (spawn, arg arrays, allow-listed binaries)
│   │   ├── secretsScanner.js     # Redacts API keys/tokens before sending to LLM
│   │   ├── pathGuard.js          # Blocks path traversal / out-of-workspace access
│   │   └── auditLog.js           # Local, append-only log of agent actions
│   ├── /webview/                 # Chat tab HTML/CSS/JS (CSP-locked)
│   │   ├── index.html
│   │   ├── main.js
│   │   ├── style.css             # "Cool UI" theme — see section 9
│   │   └── /components/
│   │       ├── welcomePanel.js
│   │       ├── modelDropdown.js
│   │       ├── thinkingSelector.js
│   │       ├── permissionMenu.js
│   │       ├── contextFileChip.js
│   │       └── messageBubble.js
│   └── /utils/
│       ├── tokenBudget.js
│       ├── platform.js           # os.platform() helpers, shell resolution, path normalization
│       └── logger.js
├── /test/
│   ├── unit/                     # Pure logic tests (no vscode dependency)
│   ├── integration/              # @vscode/test-electron suite
│   └── fixtures/
├── /doc/
│   ├── TUTORIAL.md               # Setup + usage guide (generated separately)
│   ├── ARCHITECTURE.md
│   ├── FEATURES.md
│   └── SECURITY.md
├── /setup/
│   ├── PROMPT.md                 # This file
│   └── prompts/                  # Model-facing system prompts, versioned per capability tier
│       ├── agentic-system-prompt.md
│       ├── lite-1b-system-prompt.md
│       └── context-translator-prompt.md   # Drives contextTranslator.js's memory-condensing step
├── /security/
│   ├── sast-report-template.md
│   ├── semgrep-rules/
│   └── threat-model.md
└── /docs/assets/                 # Icon source + exported sizes, screenshots
    ├── icon.svg
    └── icon-128.png
```

**Runtime-generated, never committed by the template (must be `.gitignore`d — see section 11):**

```
.hirayacoder/
├── memory/
│   ├── session1.txt              # Plain-text distilled memory for a given session
│   └── session2.txt
├── context-files/                # Copies/references of user-attached context files
├── audit.log
└── tmp/
```

---

## 4. Model Discovery, Dropdown & Recommendation

Implement `core/modelDiscovery.js`:

1. On chat-tab open and on demand, call Ollama's `GET /api/tags` to list every locally installed model, and `POST /api/show` per model (cached) to read parameter size and tool-calling capability metadata.
2. Feed this list into `features/modelManager.js`, which backs the **model dropdown** in the webview UI — shows model name, approximate parameter size, and a small tier badge (`Lite` vs `Agentic`).
3. **Forward-looking recommendation:** if `modelDiscovery.js` detects any installed model with parameter size **> 7B**, surface a one-time, dismissible suggestion in the dropdown/UI: *"You have a larger model installed — for better results on capable hardware, consider switching to `<model>`."* This is informational only, never automatic — the user's selected model never changes without an explicit click.
4. If no model is installed at all, the welcome screen (section 9) must show a clear "No models found — run `ollama pull llama3.2:1b` to get started" state instead of a silent empty dropdown.
5. Re-poll `/api/tags` when the dropdown is opened (models can be pulled outside the extension at any time via `ollama pull`).

---

## 5. Model Capability Tiers & Thinking Capacity

Every model runs a full **plan → act → observe → repeat** agent loop (`agent/agentSession.js`). What differs between tiers is the *mechanism* used to get the model to emit an action, and how the **Thinking Capacity** setting is spent.

Implement `core/modelCapability.js` to classify the currently selected model and pick a loop strategy:

| Tier | Example models | Loop mechanism | Step budget |
|---|---|---|---|
| **Tier A — Native tool-calling** | qwen2.5-coder:7b+, llama3.1:8b+, any model advertising a tools capability in Ollama's `/api/show` | `agent/nativeToolLoop.js` — the model calls `readFile`, `writeFile`, `deleteFile`, `runScript`, etc. directly via Ollama's function-calling format. | Up to ~25 steps/task. |
| **Tier B — Simulated ReAct loop (default target: 1B models)** | llama3.2:1b, qwen2.5:0.5b–1.5b, phi3-mini | `agent/reactLoop.js` — one constrained JSON action per turn via `format: "json"` (see `outputParser.js`); extension executes and feeds the observation back as the next turn's input. | Up to ~8 steps/task. |

### Thinking Capacity: Low / Medium / High

Exposed in the UI as a **Low / Medium / High** selector next to the model dropdown. It does **not** mean the same thing on both tiers, because a 1B model is not reliably good at extended chain-of-thought reasoning — cranking up "thinking" on it just burns its tiny context window. Instead:

| Setting | Tier A (native tool-calling models) | Tier B (1B / lite models) |
|---|---|---|
| **Low** | Shorter step budget (~8 steps), minimal planning pass, no explicit reasoning trace requested. | Minimal memory recall (last 1 memory entry only), 4-step budget, smallest possible per-turn context. |
| **Medium** (default) | Standard step budget (~15 steps), one up-front plan step via `plannerAgent.js`. | Recall last 3–5 memory entries via `memoryStore.js`, 8-step budget, `contextTranslator.js` runs once after the session. |
| **High** | Full step budget (~25 steps), plan + periodic re-plan checkpoints, model asked to show reasoning before each tool call (if the model supports a `reasoning`/`think` field, pass it through; Ollama's `think` parameter is used when the model supports it). | Recall full available memory file(s) up to the token budget, 8-step budget (unchanged — small models don't get more steps, just more memory), `contextTranslator.js` runs after every step, not just at the end, to keep the model "topped up" with condensed context each turn. |

This is the mechanism that makes a 1B model "smarter" without more raw reasoning capacity: **on Tier B, "Thinking Capacity" mostly controls how much persisted memory the translator recalls and how often it re-condenses**, not how long the model is allowed to ramble — see section 6.

`setup/prompts/lite-1b-system-prompt.md` must contain a strict, short ReAct-style system prompt that:
- Forces JSON-only output, **one action per turn**, from a fixed action set: `read_file`, `list_files`, `search_workspace`, `write_file`, `delete_file`, `run_script`, `run_tests`, `done`.
- Requires the model to include brief reasoning (`"thought"`) so the user can see *why* the agent is taking each step.
- Avoids multi-action or multi-tool-call syntax in a single response.
- Keeps each turn's prompt minimal (budget ≤ 1500–2000 tokens per turn including memory recall and the latest observation, not the full raw history).

---

## 6. In-Memory Context Storage & the Context Translator (making 1B models smarter)

This is the single most important mechanism for making `llama3.2:1b` usable across a real coding session, since it has a tiny effective context window and no long-term memory of its own.

### `core/memoryStore.js`
- Holds an **in-memory** (process-lifetime) cache of the current session's distilled memory, mirrored to a **plain-text file** on disk at `.hirayacoder/memory/session<N>.txt` (one file per chat session/tab).
- Content is plain sentences, not JSON — human-readable, human-editable, e.g.:
  ```
  - Added email validation to signup form (app/features/signup.js) using a regex + server-side check.
  - Fixed N+1 query bug in userController.js by adding .populate() batching.
  - Project uses Tailwind for styling; do not introduce another CSS framework.
  - User prefers concise commit-style summaries, not long paragraphs.
  ```
- `memoryStore.js` exposes `append(entry)`, `readAll()`, `readRecent(n)`, `clear()`. Writes are append-only during a session; the user can clear a session's memory from the UI.
- This file lives under `.hirayacoder/` and is **never** committed (see section 11) and **never** transmitted anywhere except back into local prompts.

### `core/contextTranslator.js`
- After every agent response (frequency depends on Thinking Capacity — see section 5), runs a small, cheap, separate prompt against the *same local model* using `setup/prompts/context-translator-prompt.md`: "given this turn's outcome, extract 1-3 short plain-text facts worth remembering for later — new features added, bugs fixed, decisions made, constraints stated by the user. Skip anything not worth remembering."
- The translator's output is appended to `memoryStore.js` (both the in-memory cache and the on-disk `session<N>.txt`).
- On every new request in the same session, `contextBuilder.js` asks `memoryStore.js` for the relevant recent entries (count depends on Thinking Capacity) and injects them into the prompt as a short `Session Memory:` block — this is what lets a 1B model "remember" that it already added a feature or fixed a bug three turns ago, despite having no real long-term memory of its own.
- This is the "translator that holds context" — effectively a compression/recall loop the small model can't do for itself, done entirely with local calls to the same offline model, at low token cost.

### `core/contextFilesManager.js`
- The user can click a **+** in the welcome/chat UI to attach one or more **context files** (e.g. a spec, a style guide, an existing module they want the agent to match).
- Attached files are read (not modified) and their content is summarized/trimmed to fit the token budget, then included in every prompt for that session as directional context — "here's what exists, here's the pattern to follow" — separate from the agent's own read/write actions on the live workspace.
- Context files are tracked in `.hirayacoder/context-files/` as lightweight references (path + optional cached excerpt), never silently copied wholesale if large; oversized files are truncated with a visible note in the UI.
- The user can remove an attached context file at any time via its chip in the UI (section 9).

---

## 7. Feature Set to Implement

Build these as discrete, independently-toggleable features (each with its own `package.json` contribution point):

1. **Agent Session (core feature)** — natural-language task in, `agentSession.js` runs plan → act → observe, narrating each step ("thought") in the chat tab like Claude Code's step-by-step trace, until `done` or step budget.
2. **Multi-file Task Execution** — a single session can read, edit, and **delete** files across several paths in one run. Every proposed change accumulates into one **session diff set** reviewed together.
3. **Chat as its own Editor Tab** — HirayaCoder opens in a dedicated tab in the main editor area (like GitHub Copilot Chat / Claude Code), not squeezed into a small sidebar panel. Command: `HirayaCoder: Open Chat`. Multiple chat tabs (multiple sessions) can be open at once, each with its own memory file (`session1.txt`, `session2.txt`, ...).
4. **Welcome Screen** — shown when a chat tab has no messages yet; see section 9 for exact layout.
5. **Model Dropdown + Thinking Capacity Selector** — see sections 4 and 5.
6. **Permission Modes UI** — a single permission control exposing four states (see section 8): Approve Edits, Auto Edit, Approve Running Scripts, Auto Approve Running Scripts — edits and scripts are independent toggles, both visible from one menu.
7. **File Edit & Delete with Permission** — the agent can propose edits *and deletions*; both route through `permissionGate.js` and respect the current permission mode.
8. **Script/Command Execution with Permission** — the agent can propose running shell commands (`npm install`, `npm run build`, `npm test`, project scaffolding commands, etc.) via `runScript.js`/`scriptRunner.js`, cross-platform, always respecting the current permission mode for scripts.
9. **In-Memory Context Storage + Context Translator** — see section 6; this is what compensates for small-model weaknesses.
10. **Context Files Attachment** — the **+** button lets the user attach one or more files the agent reads for direction without being asked to edit them.
11. **Session Diff-and-Apply workflow** — every touched/deleted file in a session renders as a diff (or a clear "file will be deleted" notice) grouped in one review UI; nothing touches disk until Apply.
12. **Inline Code Completion** — ghost-text via `InlineCompletionItemProvider`, off by default on Tier B.
13. **Explain / Refactor / Document / Fix Code Actions** — lightbulb quick actions, internally a scoped agent session.
14. **Test Generator** — standalone or agent-initiated; output in `/test/generated/`.
15. **Model Manager & Recommendation** — see section 4.
16. **Workspace-aware Context Builder** — merges open file, selection, memory recall, and attached context files into one token-budgeted prompt.
17. **Offline-first Status Bar** — connection state, active model, tier, thinking capacity, step count, permission mode indicators.
18. **Cross-platform Support** — verified working on macOS, Windows, and Linux, including script execution.

---

## 8. Permissions Model (four explicit states)

Implement `security/permissionModes.js` as two independent boolean settings, surfaced together as one **Permissions** menu in the UI (see section 9):

| Setting | Off (default, safer) | On |
|---|---|---|
| **Edits** | `Approve Edits` — every file write/delete requires an explicit per-file (or per-session "Apply All") click before anything touches disk. | `Auto Edit` — proposed writes/deletes apply automatically as the agent produces them, still shown in the trace and still logged, but without a blocking confirmation. Clearly labeled as higher-risk in the UI with a persistent indicator while active. |
| **Scripts** | `Approve Running Scripts` — every shell/build/test command requires explicit approval before `scriptRunner.js` executes it. | `Auto Approve Running Scripts` — commands run automatically once proposed, still logged and still restricted to the allow-listed binary/arg pattern rules. Requires an extra one-time confirmation dialog to enable, since it's the highest-risk mode. |

Rules that apply regardless of mode:
- **Path guard and allow-listed binaries are never bypassed**, even in auto modes — auto modes remove the *confirmation click*, not the underlying safety checks (workspace-root confinement, arg-array execution, no shell string interpolation).
- Every action, in every mode, is still written to `security/auditLog.js`.
- The user can flip any of the four states at any time from the chat tab's Permissions menu; the current state is always visible, never a hidden setting.
- `Auto Approve Running Scripts` should default OFF on every fresh install and require a deliberate opt-in — never enabled by a model's own suggestion.

---

## 9. Chat Tab UI Spec ("cool UI", welcome screen, and controls)

Implement the chat experience as a **VS Code webview panel opened as a normal editor tab** (`vscode.window.createWebviewPanel` with `viewColumn` in the main editor group), not a narrow sidebar view — mirroring how Copilot Chat and Claude Code present as first-class tabs.

### Welcome screen (shown when a chat tab is empty)
Top to bottom, centered:
1. **HirayaCoder icon** (from `docs/assets/icon.svg`/`icon-128.png`) with a short welcoming line, e.g. *"Kumusta, coder! What are we building today?"*
2. A **+ (add context file)** control near the input, opening a file picker; attached files appear as removable chips above the input (see `contextFileChip.js`).
3. The **chat input** box (multiline, grows with content, `Enter` to send / `Shift+Enter` for newline).
4. A **Send** button.
5. A **model dropdown** (from `modelDropdown.js`, backed by section 4) showing installed models and the current selection.
6. A **Thinking Capacity selector** (`Low / Med / High`, from `thinkingSelector.js`, section 5).
7. A **Permissions button** (`permissionMenu.js`) that opens the four-state menu from section 8, with the current mode(s) visible at a glance (e.g. small badges: `Edits: Approve` / `Scripts: Approve`).

### Visual direction ("cool UI")
- Dark-first theme that inherits the user's VS Code color theme via CSS variables (`--vscode-editor-background`, `--vscode-foreground`, etc.) rather than hardcoded colors, so it never clashes with the user's setup.
- A subtle accent gradient inspired by a **sunrise/spark motif** (tying back to "hiraya" — imagination/spark) used sparingly: the send button, active step indicator, and the HirayaCoder icon glyph — not washed across the whole UI.
- Agent trace messages (`thought` → `action` → `observation`) render as compact, visually distinct step chips within the assistant's message bubble — collapsed by default with an expand toggle, so a long multi-step session doesn't overwhelm the chat.
- Diffs render inline using a proper syntax-highlighted diff view (added/removed line coloring), not raw text dumps.
- Use the `frontend-design` conventions available in this environment for spacing, type scale, and componentization when actually building `app/webview/*` — read that skill before writing the CSS.

### Behavior
- Each open chat tab = one session = one `.hirayacoder/memory/session<N>.txt`. Closing a tab does not delete its memory file; reopening `HirayaCoder: Open Chat` can resume an existing session or start a new numbered one.
- The welcome screen's `+`, dropdown, thinking selector, and permissions button remain accessible (moved to a compact header bar) once the conversation has messages — they are not one-time-only welcome-screen elements.

---

## 10. Cross-Platform Requirements

- All path handling via `path.join`/`path.resolve`/`path.sep` — never manual `/`-concatenation.
- `security/scriptRunner.js` resolves the correct shell per `os.platform()`:
  - **Windows:** `cmd.exe /c <command>` or PowerShell, argument-array based, never a raw string passed to `exec`.
  - **macOS/Linux:** `/bin/sh -c <command>` equivalent via `spawn` with an argument array.
- `ollama pull`/model discovery calls must work identically across platforms (same HTTP API, no OS-specific Ollama CLI assumptions beyond the binary being on `PATH`).
- Line-ending handling (`\n` vs `\r\n`) must not corrupt diffs or written files — normalize on read, respect the file's existing convention on write.
- Test the packaged `.vsix` on at least one Windows, one macOS, and one Linux VS Code instance before release (documented in the SAST/release checklist).

---

## 11. `.gitignore` & Generated-File Policy (must implement, not just document)

HirayaCoder writes several kinds of files into the user's workspace during normal operation: session memory, context-file caches, audit logs, and temp scratch files. **None of these should ever be suggested for commit.**

The extension must, on first activation in a workspace, check whether a `.gitignore` exists and whether it already excludes `.hirayacoder/`; if not, offer (never force) to append the following block:

```gitignore
# HirayaCoder — local AI agent data (do not commit)
.hirayacoder/
.hirayacoder/memory/
.hirayacoder/context-files/
.hirayacoder/tmp/
.hirayacoder/audit.log
*.hirayacoder.tmp
```

The repository template's own root `.gitignore` (this project's own repo, not the user's workspace) must also include this block from the start — see the generated `/.gitignore` file alongside this prompt.

---

## 12. Branding: Icon & Author

- **Author:** `jaymar921` — set in `package.json`'s `"author"` field, referenced in `README.md`.
- **Extension icon:** a simple, professional mark reflecting "hiraya" (imagination/spark) — e.g. a small sunburst/spark motif merged with a code-bracket `< >` shape. Provide as `docs/assets/icon.svg` (vector source, safe to hand-edit) and export a `docs/assets/icon-128.png` (128×128, required by VS Code's `package.json` `"icon"` field) using any local SVG-to-PNG tool (e.g. Inkscape CLI, `resvg`, or an online-free/offline converter) — do not ship only the SVG, since the VS Code Marketplace requires a PNG icon.
- Keep the icon simple enough to read clearly at 16×16 (Activity Bar size) as well as 128×128 (Marketplace listing).

---

## 13. Security Requirements (implement, don't just document)

1. **No network egress except `127.0.0.1`/`localhost` to the configured Ollama port.** Enforce this in code (reject any config value that isn't loopback) — not just by convention.
2. **Permission gate (`security/permissionGate.js`)** — a single chokepoint that every file-write, file-delete, and script-exec action from *any* agent loop step must pass through, honoring the current `permissionModes.js` state. Reads (`readFile`, `listFiles`, `searchWorkspace`) don't require per-call approval; writes, deletes, and script execution always do unless the corresponding auto mode is explicitly on.
3. **Path guard** — canonicalize and validate every file path (including delete targets) against the current workspace root; reject `..` traversal and absolute paths outside the workspace, in every auto mode too.
4. **Secrets scanner** — regex/entropy-based scan of any content sent to the model, including context files attached via the `+` button and content pulled into memory summaries; redact or block with a warning.
5. **No `eval`, no `child_process.exec` with unsanitized strings** — `scriptRunner.js` uses `execFile`/`spawn` with argument arrays only, and an allow-list of binaries (`ollama`, `npm`, `node`, common test runners the user has approved) — even in Auto Approve mode.
6. **Content Security Policy** on the webview: `default-src 'none'; script-src 'nonce-<generated>'; style-src 'self' 'unsafe-inline';` — no remote resources, no remote fonts/images even for the icon (bundle it locally).
7. **Audit log** — append-only local JSONL log of every agent-initiated action (what, when, which permission mode was active, approved/denied) stored under `.hirayacoder/audit.log`.
8. **Dependency hygiene** — minimal dependency footprint; every added npm package justified in `security/threat-model.md`.
9. **No telemetry** — no analytics SDKs, no crash reporters that phone home.
10. **Memory file integrity** — `memoryStore.js` treats its own on-disk file as untrusted input on read (in case a user or another process edited it), validating it's plain text of reasonable size before injecting it into a prompt, to avoid a corrupted/huge memory file silently blowing the token budget or injecting adversarial content into the agent's own context.

---

## 14. Static Application Security Testing (SAST) — run and report

After implementation, run and document results for:

- `eslint` with `eslint-plugin-security` + `eslint-plugin-no-unsanitized` across `/app`.
- `npm audit --omit=dev` and `npm audit` (full).
- `semgrep --config p/javascript --config p/security-audit` (offline/local rule packs only).
- `retire.js` for known-vulnerable JS libraries.
- Manual review checklist for: command injection (especially `scriptRunner.js`'s cross-platform shell handling), path traversal (including `deleteFile.js`), SSRF, insecure deserialization of model JSON output, webview CSP correctness, prototype pollution in JSON parsing paths, and memory-file injection (a crafted `session<N>.txt` shouldn't be able to smuggle instructions the agent treats as user intent — memory entries are recalled as reference text, never as executable instructions).

Produce results in `/security/sast-report-template.md` filled out with: tool, date, findings count by severity, resolved vs. accepted-risk items, and a sign-off line.

---

## 15. Testing Requirements

- Unit tests for `contextBuilder`, `outputParser`, `permissionGate`, `permissionModes`, `pathGuard`, `secretsScanner`, `tokenBudget`, `agentSession`, `memoryStore` (append/readRecent/clear, on-disk sync), `contextTranslator` (produces well-formed short entries from a scripted turn), `modelDiscovery` (parses `/api/tags` fixtures, correctly flags >7B recommendation).
- Loop-strategy tests: `reactLoop.js` and `nativeToolLoop.js` against scripted mock Ollama responses, including deliberately malformed JSON, delete actions, and script-run actions in both permission modes (approve vs. auto).
- Cross-platform tests: `scriptRunner.js` shell-selection logic tested with `os.platform()` mocked to `win32`, `darwin`, and `linux`.
- Integration tests using `@vscode/test-electron` for: chat tab opens (not sidebar), welcome screen renders with all controls present, multi-file session (including a delete) produces one grouped diff/review set, permission menu correctly gates/ungates actions, context file attach/remove updates the prompt context.
- A mock Ollama server for deterministic fixtures in `/test/fixtures/`, including multi-turn fixture sequences that exercise memory recall across turns.

---

## 16. Build Order (execute in phases; confirm each phase before proceeding)

1. Scaffold repo structure + `package.json` manifest (author `jaymar921`, icon field) + activation events + `.gitignore`.
2. Implement `ollamaClient.js`, `modelDiscovery.js`, `modelCapability.js`, status bar.
3. Implement `security/permissionGate.js`, `permissionModes.js`, `pathGuard.js`, `secretsScanner.js`, `auditLog.js`, `scriptRunner.js` (cross-platform) — security layer before any agent loop ships.
4. Implement `memoryStore.js` + `contextTranslator.js` + `setup/prompts/context-translator-prompt.md` — prove a scripted multi-turn session correctly recalls memory before building the loop on top.
5. Implement `contextFilesManager.js` + `contextBuilder.js` + `tokenBudget.js`.
6. Implement `toolRegistry.js` + `agent/tools/*` (including `deleteFile.js`, `runScript.js`), each routed through the permission gate and honoring permission modes.
7. Implement `agent/reactLoop.js` + `setup/prompts/lite-1b-system-prompt.md` (Tier B) — verify a real 1B model completes a genuine multi-step, multi-file task, including a delete and a script run, gated correctly in both permission modes.
8. Implement `agent/agentSession.js` as the shared driver (step budget, session diff set, pause/resume/stop, thinking-capacity-aware memory recall frequency).
9. Implement the chat **tab** UI (`chatTab.js`, `welcomeScreen.js`, `app/webview/*`) — read `frontend-design` skill first — wire up model dropdown, thinking selector, permissions menu, context-file chips, live agent trace, grouped diff review.
10. Implement code actions (Explain/Refactor/Document/Fix) as scoped-session shortcuts.
11. Implement `agent/nativeToolLoop.js` for Tier A under the same `agentSession.js`.
12. Implement inline completion (opt-in, single-turn only).
13. Implement Model Manager recommendation logic (>7B installed → suggestion).
14. Design and export the icon (`docs/assets/icon.svg` + `icon-128.png`), wire into `package.json`.
15. Write unit + integration + cross-platform tests.
16. Run SAST suite, fix findings, fill out `security/sast-report-template.md`.
17. Write `/doc` documentation set and `README.md` (author, license section, screenshots).
18. Package `.vsix`, smoke test on Windows, macOS, and Linux with `llama3.2:1b`.

---

## 17. Acceptance Criteria

- Extension activates with **zero network calls** other than to the local Ollama endpoint.
- HirayaCoder opens as its own editor **tab**, not a cramped sidebar, and shows the full welcome screen (icon, +, input, send, model dropdown, thinking selector, permissions button) when empty.
- With `llama3.2:1b` (Tier B), a session can autonomously read files it wasn't given the path to, edit at least two files, delete a file when asked, and propose running a script (e.g. `npm install`) — every write/delete/script action correctly blocked pending approval in default mode, and correctly auto-applied only when the matching auto mode is explicitly on.
- A second request in the same chat tab correctly recalls prior session memory (e.g. mentions a feature added two turns earlier) without the user re-explaining it — provable via a fixture test.
- Attaching a context file via `+` measurably changes the agent's proposed direction in a fixture test (i.e. it's actually read and used, not just stored).
- The model dropdown reflects real installed models via `/api/tags`, and a >7B model installed alongside `llama3.2:1b` triggers the one-time recommendation.
- `scriptRunner.js` passes cross-platform unit tests for Windows/macOS/Linux shell selection without ever using string-interpolated shell execution.
- The workspace's `.gitignore` correctly excludes `.hirayacoder/` (offered, not forced) and the repo's own `.gitignore` excludes it from the start.
- `npm audit` shows no unresolved high/critical findings; `eslint` security rules pass with zero errors; test suite passes in CI without network access.
