# HirayaCoder — Master Build Prompt

> Store this file at `/setup/PROMPT.md`. Feed it to a coding AI (Claude Code, Cursor, Copilot Workspace, etc.) as the top-level system/task prompt to scaffold and implement the extension end-to-end. It is written to be run once for the initial build and re-run per phase for iterative feature work.

---

## 1. Role & Mission

You are a senior VS Code extension engineer and application-security reviewer. Build **HirayaCoder** — a fully offline, privacy-first AI coding agent that runs as a VS Code extension and talks exclusively to a **local Ollama** instance. No telemetry, no cloud LLM calls, no data leaves the developer's machine.

**Tagline:** *A local Filipino-inspired AI programmer that helps you generate, refactor, and understand code directly inside VS Code. Built for developers who want fast, private, and imaginative coding assistance — hiraya, the power of imagination, brought into your workflow.*

**Hard constraint:** the extension must remain usable on a low-spec laptop (4–8GB RAM, no dGPU) running a **1B-parameter model** such as `llama3.2:1b`. HirayaCoder must be **agentic on every model, including 1B ones** — it plans, reads files, proposes edits across multiple files, and iterates on its own within a task, the way Claude Code does. The only thing that changes between a strong model and a weak one is *how* the agent loop is implemented (native tool-calling vs. a simulated ReAct loop over constrained JSON) — never *whether* the model gets to act autonomously within a task.

---

## 2. Tech Stack (fixed)

- **Language:** JavaScript (Node.js ≥ 18), CommonJS or ESM — no TypeScript compilation step required, but JSDoc types are mandatory for editor intellisense.
- **Runtime:** VS Code Extension API (`vscode` engine), Node.js host process.
- **LLM backend:** [Ollama](https://ollama.com) local HTTP API (`http://127.0.0.1:11434`) only. No other network egress permitted anywhere in the codebase.
- **Packaging:** `vsce` / `@vscode/vsce` for `.vsix` builds.
- **Testing:** `mocha` + `@vscode/test-electron` for integration, `sinon` for mocks.
- **Lint/Security tooling:** `eslint`, `eslint-plugin-security`, `eslint-plugin-no-unsanitized`, `npm audit`, `semgrep` (offline ruleset), `retire.js`.

---

## 3. Required Repository Layout

Generate and respect this exact structure. Do not flatten it.

```
HirayaCoder/
├── README.md                     # Project overview, badges, quickstart
├── package.json                  # VS Code extension manifest
├── CHANGELOG.md
├── LICENSE
├── .eslintrc.json
├── .vscodeignore
├── /app/                         # Extension source code (the actual product)
│   ├── extension.js              # Activation entrypoint
│   ├── /core/
│   │   ├── ollamaClient.js       # HTTP wrapper for Ollama API (chat/generate/embeddings)
│   │   ├── modelCapability.js    # Detects native tool-calling support, sets loop strategy
│   │   ├── promptRouter.js       # Chooses native tool-calling loop vs. simulated ReAct loop
│   │   ├── contextBuilder.js     # Gathers file/selection/workspace context, token-budgets it
│   │   └── outputParser.js       # Parses structured JSON action objects from any model
│   ├── /agent/
│   │   ├── agentSession.js       # Unified agent loop driver: plan → act → observe → repeat, shared by both strategies
│   │   ├── plannerAgent.js       # Optional up-front multi-step plan (used by both tiers; skippable for trivial tasks)
│   │   ├── toolRegistry.js       # Declares available tools + JSON schemas (shared source of truth for both loop strategies)
│   │   ├── tools/
│   │   │   ├── readFile.js
│   │   │   ├── writeFile.js      # Always requires confirmation before write
│   │   │   ├── listFiles.js
│   │   │   ├── searchWorkspace.js
│   │   │   ├── runTests.js
│   │   │   └── runTerminalCommand.js  # Always requires explicit user approval
│   │   ├── nativeToolLoop.js     # Drives the loop via Ollama's native tool-calling (Tier A)
│   │   └── reactLoop.js          # Drives the same loop via constrained single-action JSON turns (Tier B / small models)
│   ├── /features/
│   │   ├── chatPanel.js          # Webview chat UI controller
│   │   ├── inlineCompletion.js   # InlineCompletionItemProvider
│   │   ├── codeActions.js        # Refactor / Explain / Document / Fix quick actions
│   │   ├── testGenerator.js
│   │   ├── diffApply.js          # Shows diff, requires accept before write
│   │   └── modelManager.js       # UI to pick/pull/switch Ollama models
│   ├── /security/
│   │   ├── permissionGate.js     # Central approval gate for FS/exec actions
│   │   ├── secretsScanner.js     # Redacts API keys/tokens before sending to LLM
│   │   ├── pathGuard.js          # Blocks path traversal / out-of-workspace access
│   │   └── auditLog.js           # Local, append-only log of agent actions
│   ├── /webview/                 # Chat panel HTML/CSS/JS (CSP-locked)
│   │   ├── index.html
│   │   ├── main.js
│   │   └── style.css
│   └── /utils/
│       ├── tokenBudget.js
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
│       └── lite-1b-system-prompt.md
├── /security/
│   ├── sast-report-template.md
│   ├── semgrep-rules/
│   └── threat-model.md
└── /docs/assets/                 # Icons, screenshots, logo
```

---

## 4. Model Capability Tiers — both tiers are agentic

Every model runs a full **plan → act → observe → repeat** agent loop (`agent/agentSession.js`). It can read multiple files, propose edits across several of them, run tests, check the result, and correct itself within one task — the same shape of behavior as Claude Code. What differs between tiers is purely the *mechanism* the loop uses to get the model to emit an action, never whether the model is allowed to act autonomously.

Implement `core/modelCapability.js` to classify the currently selected Ollama model and pick a loop strategy:

| Tier | Example models | Loop mechanism | Agentic capability |
|---|---|---|---|
| **Tier A — Native tool-calling** | qwen2.5-coder:7b+, llama3.1:8b+, any model advertising a tools capability in Ollama's `/api/show` | `agent/nativeToolLoop.js` drives the loop using Ollama's real function-calling format — the model calls `readFile`, `writeFile`, `searchWorkspace`, etc. directly, extension executes and returns results as tool messages. | Full multi-step autonomy, longer plans, larger step budget (e.g. up to 25 steps/task). |
| **Tier B — Simulated ReAct loop (default target: 1B models)** | llama3.2:1b, qwen2.5:0.5b–1.5b, phi3-mini | `agent/reactLoop.js` drives the *same* loop shape, but since the model can't natively call tools, each turn forces a single constrained JSON action via Ollama's `format: "json"` option (see `outputParser.js`). The extension executes that one action, feeds the observation back as the next turn's context, and asks the model for the next action — repeating until it emits `"action": "done"` or a step budget is hit. | Full multi-step, multi-file autonomy too — just driven by the extension re-prompting after every step instead of native tool messages, and with a tighter step budget (e.g. up to 8 steps/task) and aggressively trimmed context per turn to fit small context windows. |

Detection: call `/api/show` for the active model, check for a tools/function-calling capability flag; if absent, or if the model's parameter count (from model metadata/tag) is ≤ ~2B, default to Tier B's ReAct loop. Always let the user override the tier manually in settings. In both tiers `agentSession.js` is the single place that owns: step counter, step budget, cumulative diff tracking across files touched this task, and the stop condition — `nativeToolLoop.js` and `reactLoop.js` are just two interchangeable "drivers" underneath it.

`setup/prompts/lite-1b-system-prompt.md` must contain a strict, short ReAct-style system prompt that:
- Forces JSON-only output, **one action per turn**, from a fixed action set: `read_file`, `list_files`, `search_workspace`, `write_file`, `run_tests`, `done`.
- Requires the model to include brief reasoning (`"thought"`) so the user can see *why* the agent is taking each step, mirroring how Claude Code narrates its actions.
- Avoids multi-action or multi-tool-call syntax in a single response — exactly one action per turn keeps small models reliable.
- Keeps each turn's prompt minimal (small models have small context windows — budget ≤ 1500–2000 tokens per turn, including the running task summary and the latest observation, not the full history verbatim).

---

## 5. Feature Set to Implement

Build these as discrete, independently-toggleable features (each with its own `package.json` contribution point):

1. **Agent Session (core feature)** — the user gives a task in natural language ("add input validation to the signup form and update its tests"); `agentSession.js` runs the plan → act → observe loop, narrating each step ("thought") in the chat panel like Claude Code's step-by-step trace, until it reaches `done` or the step budget. Works identically in shape on Tier A and Tier B — only step budget and loop mechanism differ.
2. **Multi-file Task Execution** — a single agent session can read, propose edits to, and create files across several paths in the workspace in one run, not just the currently open file. Every proposed file in the session accumulates into one **session diff set** the user reviews together.
3. **Chat Panel** — sidebar webview that doubles as the agent's live trace (thought → action → observation, per step), plus free-form Q&A. Conversation/session history stored locally in `.hirayacoder/` workspace folder (opt-in, gitignored by default).
4. **Inline Code Completion** — ghost-text suggestions via `InlineCompletionItemProvider`, debounced, cancellable, off by default on Tier B to avoid latency complaints on weak hardware. Separate from the agent loop — this is single-turn only.
5. **Explain / Refactor / Document / Fix Code Actions** — right-click / lightbulb quick actions on a selection; internally these are just a one-task-shortcut into the same agent session as feature #1.
6. **Test Generator** — can be invoked standalone or as a step the agent takes on its own within a larger task; output lands in `/test/generated/` (never overwrites existing tests without diff confirmation).
7. **Session Diff-and-Apply workflow** — every file the agent touched during a session renders as a VS Code diff, grouped in one review UI; nothing touches disk until the user reviews and clicks **Apply** (per-file or "apply all"). The agent can keep planning/reasoning about *proposed* changes before they're applied, but never writes them for real until approved.
8. **Step-level Pause/Resume/Stop controls** — the user can pause the agent mid-session, inspect what it's done so far, edit its plan, or stop it entirely; state is preserved so a paused session can resume.
9. **Model Manager** — list installed Ollama models, pull new ones (`ollama pull <model>` via child_process with strict allow-listed args), show RAM/quant info, one-click switch, and surface the detected loop strategy (native tool-calling vs. simulated ReAct) and step budget.
10. **Workspace-aware Context Builder** — token-budgeted context assembly (open file, selection, imports, relevant symbols, running task summary) so small-context 1B models still get useful signal per turn without truncation errors.
11. **Terminal Command Suggestions / Execution as a Tool** — `run_terminal_command` is an available agent action on both tiers, but every invocation — regardless of tier — pauses the session and requires explicit user approval before it runs, unless the user has opted into per-session auto-run with a visible warning banner.
12. **Offline-first Status Bar** — shows connection state to local Ollama, active model, loop strategy, current session step count, and last response latency.

---

## 6. Security Requirements (implement, don't just document)

1. **No network egress except `127.0.0.1`/`localhost` to the configured Ollama port.** Enforce this in code (reject any config value that isn't loopback) — not just by convention.
2. **Permission gate (`security/permissionGate.js`)** — a single chokepoint that every file-write, file-delete, and terminal-exec action from *any* agent loop step (both `nativeToolLoop.js` and `reactLoop.js` call through it, never around it) must pass through. Default-deny; explicit per-action or per-session-diff-set confirmation; "always allow writes for this session" is an opt-in the user grants explicitly per session and it never covers terminal-exec, which always requires its own confirmation. Reads (`readFile`, `listFiles`, `searchWorkspace`) inside the workspace root do not require per-call approval — only file-system *mutations* and shell execution do — but every action, read or write, is still recorded in the audit log.
3. **Path guard** — canonicalize and validate every file path the agent proposes against the current workspace root; reject `..` traversal and absolute paths outside the workspace.
4. **Secrets scanner** — regex/entropy-based scan of any content sent to the model (env files, `.pem`, common API key patterns); redact or block with a warning before the prompt leaves the extension host.
5. **No `eval`, no `child_process.exec` with unsanitized strings** — use `execFile`/`spawn` with argument arrays only, and an allow-list of binaries (`ollama`, package-manager test runners the user explicitly approved).
6. **Content Security Policy** on the webview: `default-src 'none'; script-src 'nonce-<generated>'; style-src 'self' 'unsafe-inline';` — no remote resources.
7. **Audit log** — append-only local JSONL log of every agent-initiated action (what, when, approved/denied) stored under `.hirayacoder/audit.log`, rotated, never transmitted anywhere.
8. **Dependency hygiene** — minimal dependency footprint; every added npm package must be justified in `security/threat-model.md`.
9. **No telemetry** — no `vscode-extension-telemetry`, no analytics SDKs, no crash reporters that phone home.

---

## 7. Static Application Security Testing (SAST) — run and report

After implementation, run and document results for:

- `eslint` with `eslint-plugin-security` + `eslint-plugin-no-unsanitized` across `/app`.
- `npm audit --omit=dev` and `npm audit` (full) — record findings and remediations.
- `semgrep --config p/javascript --config p/security-audit` (offline/local rule packs only, no cloud upload) — or document the equivalent local ruleset if Semgrep isn't available offline.
- `retire.js` for known-vulnerable JS libraries.
- Manual review checklist for: command injection, path traversal, SSRF (even though egress is loopback-only, verify no bypass), insecure deserialization of model JSON output, webview CSP correctness, prototype pollution in JSON parsing paths.

Produce results in `/security/sast-report-template.md` filled out with: tool, date, findings count by severity, resolved vs. accepted-risk items, and a sign-off line.

---

## 8. Testing Requirements

- Unit tests for `contextBuilder`, `outputParser`, `permissionGate`, `pathGuard`, `secretsScanner`, `tokenBudget`, `agentSession` (step counter, budget enforcement, stop condition) — pure functions/classes, no VS Code dependency, run under plain `mocha`.
- Loop-strategy tests: `reactLoop.js` driven against a scripted mock Ollama server that returns a sequence of valid and deliberately malformed JSON actions, asserting the loop never applies an unparseable or schema-invalid action and correctly halts at the step budget. `nativeToolLoop.js` tested similarly against mocked tool-call responses.
- Integration tests using `@vscode/test-electron` for: extension activation, chat panel opens and shows a live agent trace, a multi-file session correctly produces one grouped diff set, code action registers, diff-apply flow (mock Ollama responses — never call a real network in CI).
- A mock Ollama server (simple Express or `http` stub) for deterministic test fixtures in `/test/fixtures/`, including fixture sequences that simulate a full multi-step agent task end to end.

---

## 9. Build Order (execute in phases; confirm each phase before proceeding)

1. Scaffold repo structure + `package.json` manifest + activation events.
2. Implement `ollamaClient.js` + `modelCapability.js` + status bar (prove connectivity end-to-end first).
3. Implement `contextBuilder.js` + `tokenBudget.js`.
4. Implement `security/permissionGate.js`, `pathGuard.js`, `secretsScanner.js`, `auditLog.js` — security layer built **before** any agent loop ships, since the loop depends on it.
5. Implement `toolRegistry.js` + the `agent/tools/*` primitives (`readFile`, `writeFile`, `listFiles`, `searchWorkspace`, `runTests`, `runTerminalCommand`), each routed through the permission gate.
6. Implement `agent/reactLoop.js` + `setup/prompts/lite-1b-system-prompt.md` first (Tier B, single-action-per-turn JSON loop) — get a real 1B model completing a genuine multi-step, multi-file task end to end before building anything else on top.
7. Implement `agent/agentSession.js` as the shared driver (step budget, session diff set, pause/resume/stop) sitting above `reactLoop.js`.
8. Implement chat panel (webview + CSP) as a live view into `agentSession.js` — thought/action/observation trace per step, grouped session diff review, Apply/Discard per file or all.
9. Implement code actions (Explain/Refactor/Document/Fix) as shortcuts that start a scoped agent session.
10. Implement `agent/nativeToolLoop.js` for Tier A as an interchangeable driver under the same `agentSession.js` — verify a Tier A model can complete the same multi-file task fixture the Tier B loop was tested against.
11. Implement inline completion (opt-in, single-turn only, not part of the agent loop).
12. Implement Model Manager UI.
13. Write unit + integration tests, including scripted multi-step fixture sessions for both loop strategies.
14. Run SAST suite, fix findings, fill out `security/sast-report-template.md`.
15. Write `/doc` documentation set and `README.md`.
16. Package `.vsix`, dry-run install, smoke test a full multi-file agent task on a fresh VS Code profile with `llama3.2:1b`.

---

## 10. Acceptance Criteria

- Extension activates with **zero network calls** other than to the local Ollama endpoint (verify via a network monitor during manual test).
- With `llama3.2:1b` (Tier B), a single natural-language task can autonomously: read at least one file it wasn't told the path of (found via `search_workspace`/`list_files`), propose edits across at least two files, and stop cleanly at `done` or the step budget — without the user re-prompting at each step.
- No crashes on malformed JSON from the model at any step — the loop halts that step gracefully, shows the raw text, and never silently writes a file (parser fails closed).
- All file-mutation and terminal-exec actions are inert without explicit user approval, at every step of a session, on both loop strategies.
- The session diff set correctly groups every file the agent touched in one task for review, and per-file Discard doesn't affect other files' proposed edits.
- `npm audit` shows no unresolved high/critical findings.
- `eslint` security rules pass with zero errors.
- Test suite passes in CI without network access.
