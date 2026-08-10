# HirayaCoder — Setup & Usage Tutorial

*A local Filipino-inspired AI coder that brings imagination and speed to your VS Code workflow — fully offline, powered by Ollama.*

This guide walks through installing Ollama, pulling a low-spec-friendly model, building the extension from source, and using HirayaCoder inside VS Code.

---

## 1. Requirements

| Component | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 / macOS 12 / Ubuntu 20.04 | Latest stable |
| RAM | 4 GB free | 8 GB+ |
| CPU | Any x64/ARM64 dual-core | Quad-core |
| Node.js | 18.x | 20.x LTS |
| VS Code | 1.85+ | Latest |
| Disk | ~2 GB for a 1B model | 5 GB+ |

No GPU is required. HirayaCoder is designed to run acceptably on CPU-only laptops using a 1B-parameter model.

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
| `hirayacoder.model` | `llama3.2:1b` | Active Ollama model tag. |
| `hirayacoder.tier` | `auto` | `auto`, `agentic`, or `lite`. Auto-detects based on the model. |
| `hirayacoder.inlineCompletion` | `false` | Off by default on low-spec machines. |
| `hirayacoder.autoRunTerminalCommands` | `false` | Keep this off unless you understand the risk. |
| `hirayacoder.contextTokenBudget` | `1500` | Lower this further on very constrained machines. |

You can also open the **Model Manager** view (`HirayaCoder: Manage Models` from the Command Palette) to pull, switch, and inspect models without leaving VS Code.

---

## 6. Using HirayaCoder

### Chat Panel
- Open the HirayaCoder icon in the Activity Bar, or run `HirayaCoder: Open Chat` from the Command Palette (`Ctrl/Cmd + Shift + P`).
- Ask questions about the open file, request refactors, or paste an error and ask for a fix.

### Code Actions
- Select a block of code → click the lightbulb (💡) → choose **Explain**, **Refactor**, **Document**, or **Fix with HirayaCoder**.

### Diff & Apply
- Any proposed code change opens as a **diff view**. Nothing is written to disk until you click **Apply**. Click **Discard** to drop the suggestion entirely.

### Test Generator
- Right-click a function or select code → `HirayaCoder: Generate Tests`. Output lands in `/test/generated/` for review — it will not overwrite existing test files without a diff confirmation.

### Terminal Suggestions
- HirayaCoder may suggest a shell command; by default it only **inserts** the command into the terminal for you to review and run yourself. Auto-run is opt-in and shows a warning banner each session.

---

## 7. Choosing the Right Model for Your Hardware

| Laptop class | Suggested model | Notes |
|---|---|---|
| Low-spec (4GB RAM, no GPU) | `llama3.2:1b` or `qwen2.5:0.5b` | Tier B (lite) mode — single-shot JSON responses, no autonomous multi-step actions. |
| Mid-spec (8-16GB RAM) | `qwen2.5-coder:3b` | Usually still Tier B, better code quality. |
| Higher-spec (16GB+ RAM or GPU) | `qwen2.5-coder:7b`, `llama3.1:8b` | Tier A — agentic multi-step planning with tool calls, still 100% offline. |

Switch anytime via **Model Manager** — HirayaCoder re-detects the tier automatically.

---

## 8. Privacy & Offline Guarantee

- HirayaCoder makes **no network requests** except to your local Ollama instance on `127.0.0.1`.
- No telemetry, no analytics, no crash reporting service.
- Conversation history is stored locally under `.hirayacoder/` in your workspace (gitignored by default) — delete it anytime to clear history.
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
