# HirayaCoder — Setup & Usage Tutorial

*A local Filipino-inspired AI coder that brings imagination and speed to your VS Code workflow — fully offline, powered by Ollama.*

This guide walks through installing Ollama, pulling a low-spec-friendly model, building the extension from source, and using HirayaCoder inside VS Code.

---

## 1. Requirements

| Component | Minimum | Recommended |
|---|---|---|
| OS | Windows 10, macOS 12, or Ubuntu 20.04 (HirayaCoder works identically on all three) | Latest stable |
| RAM | 8 GB free (16 GB total is typical for most laptops) | 16 GB+ |
| CPU | Any x64/ARM64 dual-core | Quad-core |
| Node.js | 18.x | 20.x LTS |
| VS Code | 1.85+ | Latest |
| Disk | ~2 GB for a 1B model | 5 GB+ |

No GPU is required. HirayaCoder is designed to run acceptably on a typical CPU-only laptop with ~16GB RAM using a 1B-parameter model.

---

## 2. Install Ollama

1. Download Ollama for your OS: https://ollama.com/download
2. Verify install:
   ```bash
   ollama --version
   ```
3. Start the Ollama service (it usually starts automatically as a background service; if not):
   ```bash
   ollama serve
   ```
   By default it listens on `http://127.0.0.1:11434`.

---

## 3. Pull a Model

For low-spec laptops, pull a small, non-agentic model:

```bash
ollama pull llama3.2:1b
```

Optional, if your machine can handle more and you want agentic/tool-calling behavior:

```bash
ollama pull qwen2.5-coder:7b
```

Confirm it's available:

```bash
ollama list
```

Quick sanity check:

```bash
ollama run llama3.2:1b "Say hello in one sentence."
```

---

## 4. Get HirayaCoder

### Option A — Install from `.vsix` (once packaged)

```bash
code --install-extension hirayacoder-<version>.vsix
```

Or in VS Code: `Extensions` panel → `...` menu → `Install from VSIX...`

### Option B — Run from source (development)

```bash
git clone <your-repo-url> HirayaCoder
cd HirayaCoder
npm install
```

Open the folder in VS Code, then press `F5` to launch an Extension Development Host with HirayaCoder loaded.

---

## 5. First-Run Configuration

Open VS Code Settings (`Ctrl/Cmd + ,`) and search **HirayaCoder**:

| Setting | Default | Description |
|---|---|---|
| `hirayacoder.ollamaUrl` | `http://127.0.0.1:11434` | Must remain loopback; non-local values are rejected. |
| `hirayacoder.model` | `llama3.2:1b` | Active Ollama model tag — also changeable live from the model dropdown in the chat tab. |
| `hirayacoder.tier` | `auto` | `auto`, `agentic` (Tier A), or `lite` (Tier B). Auto-detects based on the selected model. |
| `hirayacoder.thinkingCapacity` | `medium` | `low`, `medium`, or `high` — also changeable live from the chat tab. See section 6 for what this actually controls on small models. |
| `hirayacoder.editPermission` | `approve` | `approve` (Approve Edits) or `auto` (Auto Edit). |
| `hirayacoder.scriptPermission` | `approve` | `approve` (Approve Running Scripts) or `auto` (Auto Approve Running Scripts) — keep this on `approve` unless you understand the risk. |
| `hirayacoder.inlineCompletion` | `false` | Off by default on low-spec machines. |
| `hirayacoder.contextTokenBudget` | `1500` | Lower this further on very constrained machines. |

You can also open the **Model Manager** view (`HirayaCoder: Manage Models` from the Command Palette) to pull, switch, and inspect models without leaving VS Code — it lists every model `ollama list` knows about, with an approximate parameter size and a Lite/Agentic badge.

---

## 6. Using HirayaCoder

### Opening the Chat
- Run `HirayaCoder: Open Chat` from the Command Palette (`Ctrl/Cmd + Shift + P`). Like GitHub Copilot Chat and Claude Code, HirayaCoder opens as its **own editor tab**, not a cramped sidebar — you can put it side-by-side with your code.
- An empty chat tab shows the **welcome screen**:
  - The HirayaCoder icon and a short welcome line.
  - A **+** button to attach one or more **context files** (see below).
  - The chat **input box** and **Send** button.
  - The **model dropdown** — every model `ollama list` knows about.
  - The **Thinking Capacity** selector — Low / Medium / High.
  - A **mode button** — **Agent / Plan / Ask** (see below).
  - The **Permissions** button — shows and controls the four permission states (see below).
- You can open multiple chat tabs at once — each is its own session with its own memory file.

### Agent Sessions (the core workflow)
- Describe what you want in plain language — e.g. *"add email validation to the signup form and update its tests"*.
- HirayaCoder works step by step: reading files it needs, searching the workspace, proposing edits (or deletions, or a script to run) — narrating each step live in the chat (`thought` → `action` → result), the same way Claude Code shows its work.
- This works the same way on `llama3.2:1b` as on a larger model — on small models it takes one step at a time (typically up to 8 steps per task); on larger models it can plan further ahead (up to ~25 steps).
- You can **pause**, **stop**, or let it **resume** at any point.

### Mode: Agent / Plan / Ask
The mode button next to the model dropdown controls how far a message is allowed to go:
| Mode | What happens | Can it edit/delete/run scripts? |
|---|---|---|
| **Ask** | A direct, single-turn answer — no exploration, no tool use. Best for "explain this", "what's wrong with this error", quick questions. Fastest and most reliable, especially on `llama3.2:1b`. | No. |
| **Plan** | HirayaCoder explores the workspace (read-only) and comes back with a numbered, editable checklist of what it would do — no files are touched. You can edit the plan, then click **Run this plan** to hand it straight to Agent mode. | No — write/delete/run-script aren't even offered to the model in this mode. |
| **Agent** (default) | The full workflow below — reads, edits, deletes, and runs scripts as needed to complete the task, gated by your Permissions settings. | Yes, per your Permissions settings. |

Switch modes per message — you're not locked in for the whole chat tab, and switching doesn't lose session memory or attached context files.

### Context Files (the **+** button)
- Click **+** to attach one or more files — a spec, a style guide, an existing module you want new code to match. HirayaCoder reads them for **direction**, not to edit them.
- Attached files show as removable chips above the input; click the `×` on a chip to remove one.
- This is especially useful on `llama3.2:1b`, which otherwise has no way to "know" your project's conventions beyond what's in its immediate context.

### Session Memory (what makes a 1B model usable across a real session)
- Every time HirayaCoder finishes a step, a small local pass (the **context translator**) distills anything worth remembering — a feature added, a bug fixed, a constraint you mentioned — into a short plain-text note.
- Notes are kept in memory and mirrored to `.hirayacoder/memory/session<N>.txt` — you can open that file yourself any time to see exactly what HirayaCoder "remembers" for that session, in plain readable text.
- On your next message in the same chat tab, relevant notes are quietly included so the model doesn't lose track of earlier work. **Thinking Capacity** controls how much of this memory gets recalled per turn:
  - **Low** — just the most recent note (fastest, least context use).
  - **Medium** (default) — the last several notes.
  - **High** — as much memory as fits the token budget, refreshed after every step (slower, but the model stays most "aware").
- Clear a session's memory anytime from the chat tab's menu, or just delete the corresponding `session<N>.txt` file.

### Permissions (Edits & Scripts)
Click the **Permissions** button to see and change two independent settings:
| | Off (default) | On |
|---|---|---|
| **Edits** | *Approve Edits* — every proposed write or delete needs your click before it touches disk. | *Auto Edit* — changes apply as HirayaCoder produces them (still logged, still shown in the trace). |
| **Scripts** | *Approve Running Scripts* — every shell/build/test command needs your click before it runs. | *Auto Approve Running Scripts* — commands run automatically once proposed. Requires a one-time confirmation to turn on, since it's the highest-risk mode. |

These matter because HirayaCoder can genuinely **modify and delete files, and run real commands** — e.g. `npm install`, `npm run build`, `npm test`, project scaffolding — on your behalf, cross-platform (bash/sh on macOS/Linux, cmd/PowerShell on Windows). Leave both on *Approve* until you trust a given task.

### Session Diff & Apply
- Every file the agent touched — could be one file, could be five, plus any deletions — is grouped into a single **session diff review**. Nothing is written to disk until you review it (unless Auto Edit is on).
- Click **Apply** on individual files or **Apply All**; click **Discard** to drop any file's proposed change without affecting the others.

### Code Actions
- Select a block of code → click the lightbulb (💡) → choose **Explain**, **Refactor**, **Document**, or **Fix with HirayaCoder**. Each starts a scoped agent session for just that selection.

### Test Generator
- Invoke directly (`HirayaCoder: Generate Tests`), or let the agent decide to write tests as part of a larger task. Output lands in `/test/generated/` for review — it will not overwrite existing test files without a diff confirmation.

### `.gitignore` Handling
- On first use in a workspace, HirayaCoder checks whether your `.gitignore` already excludes `.hirayacoder/` (where memory, context-file caches, and the audit log live) and, if not, **offers** — never forces — to add the right entries so its generated files never get committed.

---

## 7. Choosing the Right Model for Your Hardware

| Laptop class | Suggested model | Notes |
|---|---|---|
| Low-spec (4GB RAM, no GPU) | `llama3.2:1b` or `qwen2.5:0.5b` | Tier B — agentic, one JSON action per turn, ~8-step budget per task, still multi-file capable. |
| Mid-spec (8-16GB RAM) | `qwen2.5-coder:3b` | Usually still Tier B, better code/edit quality per step. |
| Higher-spec (16GB+ RAM or GPU) | `qwen2.5-coder:7b`, `llama3.1:8b` | Tier A — native tool-calling, longer plans (~25-step budget), still 100% offline. |

Both tiers run the same kind of agent session — the difference is step budget and how the model expresses each action, not whether it can act autonomously.

Switch anytime via the **model dropdown** in the chat tab, or the **Model Manager**. If HirayaCoder detects you already have a model installed larger than 7B, it will show a one-time suggestion to switch for better results — it never switches automatically.

---

## 8. Privacy & Offline Guarantee

- HirayaCoder makes **no network requests** except to your local Ollama instance on `127.0.0.1`.
- No telemetry, no analytics, no crash reporting service.
- Session memory, context-file caches, and the audit log are stored locally under `.hirayacoder/` in your workspace — HirayaCoder offers to add these to your `.gitignore` on first use so nothing generated is ever committed. Delete `.hirayacoder/` anytime to clear everything.
- See `/doc/SECURITY.md` for the full security model.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Status bar shows "Ollama: disconnected" | Confirm `ollama serve` is running and the URL setting matches. |
| Responses are slow/truncated | Lower `contextTokenBudget`, switch to a smaller model, close other heavy apps. |
| Model returns malformed output on Tier B | This is expected occasionally with 1B models — HirayaCoder falls back to showing the raw text and will not auto-apply it. Retry, or switch to a slightly larger model. |
| Extension can't find Ollama binary for "pull" | Ensure `ollama` is on your system `PATH`, or pull models manually via terminal. |

---

## 10. Uninstall / Reset

```bash
code --uninstall-extension <publisher>.hirayacoder
rm -rf .hirayacoder   # from your workspace root, to clear local history/logs
```
