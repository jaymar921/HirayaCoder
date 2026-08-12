# HirayaCoder

<p align="center">
  <img src="https://raw.githubusercontent.com/jaymar921/HirayaCoder/main/docs/assets/icon-128.png" width="96" height="96" alt="HirayaCoder icon" />
</p>

*A local Filipino-inspired AI coder that brings imagination and speed to your VS Code workflow.*

HirayaCoder is a **fully offline** VS Code extension that pairs your editor with a **local Ollama** LLM. It's built to run on modest laptop hardware — down to a 1B-parameter model — while still scaling up to full native tool-calling workflows on stronger machines. No cloud calls, no telemetry, no data leaving your machine.

> **Hiraya** (Filipino) — imagination, aspiration, the spark of an idea before it becomes real.

---

## Why HirayaCoder

- 🤖 **Agentic on every model** — plans, reads files, edits, deletes, and runs scripts across multiple files within a task on its own, the way Claude Code and Copilot Chat do — even on a 1B model.
- 🎚️ **Agent / Plan / Ask modes** — ask a quick question without triggering the agent loop, preview a read-only plan before anything changes, or let it run the full task end to end.
- 🧠 **Smarter small models via memory** — a local, plain-text memory store (`.hirayacoder/memory/`) and a context translator keep a 1B model "aware" of what it already did earlier in the session, compensating for its tiny context window.
- 📈 **It learns from what actually happened** — outcomes are recorded locally (`.hirayacoder/outcomes.jsonl`: counts and guard codes, never your code), and a model that trips the same guard three times gets the matching correction added to its prompt from then on. It adapts what the model is *told*, never what it is *allowed to do* — permissions and guards take no input from it. Inspect it with **Show Learned Adaptation**, throw it away with **Reset Learned Adaptation**.
- 📎 **Context files** — attach reference files with the `+` button. They're scanned for secrets and redacted at ingestion, before truncation.
- 🗂️ **Chat lives in its own tab** — a full editor tab, not squeezed into a sidebar. Sessions persist: close a tab, reopen it later, and the conversation is still there.
- 🔒 **Private by construction** — only ever talks to `127.0.0.1`. A non-loopback endpoint is rejected in code, before any socket opens.
- 🛡️ **Explicit permissions** — edits, deletes, and shell commands never run without the control you choose. Deletes confirm even in Auto Edit. See [SECURITY.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/SECURITY.md).
- 💻 **Low-spec friendly** — designed and tested against `llama3.2:1b` for machines without a GPU.
- 🌐 **Cross-platform** — CI runs the full suite on Windows, macOS, and Linux.
- 🇵🇭 **Made with a Filipino developer's sensibility** — practical, resourceful, built for real hardware, not just top-spec dev machines.

---

## Constraints — read this before choosing a model

HirayaCoder is shaped by what a small local model actually does, not by what it should
do. These are the limits worth knowing up front.

**A local model is the ceiling, not the extension.** On the benchmark suite, a capable
model completes a three-part task on either loop; a 1B model does not. The agent loop is
not what limits it. Below roughly 1B the failure mode changes kind — the output stops
being obviously broken and becomes *plausible and wrong*, which costs more time than it
saves.

**Models damage files, and the guards are why that's survivable.** Across one
seventeen-run sweep, four different models produced six damaged files: deleted exports,
a CommonJS module silently rewritten as ESM, an export left pointing at a renamed
function, an implementation replaced by `module.exports = { name: '' }`. Every one
parsed cleanly. Each is now refused with an explanation the model can act on — so
**a refusal in your chat is the system working**, not a bug.

**Speed is hardware, correctness is the model.** A GPU makes a task finish in seconds
instead of minutes. It does not make a 2B model reason better: in testing, the same
model that passed on a slow laptop produced plausible-but-wrong logic twice on a fast
desktop.

**It needs a trusted workspace folder.** Without a workspace root there's nothing to
confine the agent to, so every tool refuses.

**VRAM is usually the real limit, not RAM.** Resident size exceeds on-disk size because
of the KV cache, so a 2.7 GB model needs ~3.0 GB and overflows a 4 GB card.

---

## Benchmarks — measured, on named hardware

Two tasks against a fixture project, with deletes declined at the prompt on purpose:
**simple** (one file) and **full** (edit a function, note it in the README, delete an
obsolete file). A model that claims it deleted the declined file has failed that task
even if everything else passed.

### The machines

| | Machine A — laptop | Machine B — desktop | Machine C — MacBook Pro |
|---|---|---|---|
| CPU | Intel Core i5-12450H (4P + 4E) | AMD Ryzen 5 3600X (6C / 12T) | Apple M4 Pro, 14-core (10P + 4E) |
| RAM | 16 GB LPDDR5-4800 | 32 GB DDR4-3200 | 24 GB **unified** |
| GPU | Intel UHD — **not used** | NVIDIA GTX 1650 Super, **4 GB VRAM** | 20-core, shares the 24 GB |
| Inference | CPU-only | Partial GPU offload | **100% GPU, every model** |

**Machine A is the design constraint.** Every guard and budget in this project exists
because of something that happened there.

**Machine C settles what unified memory buys.** Because the GPU addresses the same 24 GB
the CPU does, **every model in the matrix ran fully GPU-resident** — all nineteen runs,
including `gemma4:e4b` at 9.5 GB resident, which Machine A could not load at all. No
model split, so this sweep never found the boundary. Model size stops being a constraint
on this machine.

### Results

| Model | Tier | Machine | Simple | Full | CPU/GPU | Verdict |
|---|---|---|---|---|---|---|
| `qwen3.5:0.8b` | B lite | B | 11.5s | 7.9s | 100% GPU | **fails** — below the usable floor |
| `llama3.2:1b` | B lite | B | 27.1s | 5.5s | 100% GPU | **fails** the benchmark; fine for focused single-file edits |
| `qwen3.5:2b` | B lite | B | 54.9s | 81.9s | 39% / 61% | **fails on correctness** — plausible-but-wrong logic in both runs |
| `stable-code:latest` | B lite | B | 37.1s | 36.5s | 49% / 51% | passes, after a guard refused an ESM rewrite |
| `llama3.2:latest` | A | B | 24.3s | 20.3s | 32% / 68% | **fails** — reported success having edited nothing |
| `qwen3.5:4b` | A | B | 51.4s | 68.3s | 54% / 46% | **passes both** |
| `gemma4:e2b` | A | B | 43.2s | 25.5s | 78% / 22% | **passes both** — fastest to a correct result |
| `ornith:9b` | A | B | 64.5s | 91.9s | 63% / 37% | **passes both** |
| `gemma4:e4b` | A | B | 79.0s | 63.0s | 85% / 15% | **passes both** — the strongest that runs here |

Every row above is Machine B. The same sweep on **Machine C** (M4 Pro, 24 GB unified):

| Model | Tier | Machine | Simple | Full | Resident | CPU/GPU | Verdict |
|---|---|---|---|---|---|---|---|
| `qwen3.5:0.8b` | B lite | C | 6.1s | 2.8s | 1.1 GB | 100% GPU | **fails** — below the usable floor |
| `llama3.2:1b` | B lite | C | 23.8s | 8.5s | 1.5 GB | 100% GPU | **fails** — every write refused by a guard, workspace untouched |
| `qwen3.5:2b` | B lite | C | 8.4s | 25.5s | 2.4 GB | 100% GPU | **passes both** — disagrees with Machine B; run-to-run variance, not hardware |
| `stable-code:latest` | B lite | C | 7.9s | 5.9s | 2.9 GB | 100% GPU | passes with a caveat — correct code, but the full run never noted the README |
| `llama3.2:latest` | A | C | 14.3s | 7.0s | 2.5 GB | 100% GPU | **fails** — reported success having edited nothing |
| `qwen3.5:4b` | A | C | 12.6s | 19.9s | 3.1 GB | 100% GPU | **passes both** |
| `gemma4:e2b` | A | C | 14.3s | 12.4s | 7.0 GB | 100% GPU | **passes both** — fastest to a correct result |
| `ornith:9b` | A | C | 17.8s | 29.0s | 5.9 GB | 100% GPU | **passes both** — tightest diff in the sweep |
| `gemma4:e4b` | A | C | 16.9s | 23.6s | 9.5 GB | 100% GPU | **passes both** — the correctness ceiling |

Machine C is **2.1×–6.5× faster than Machine B** on the shared rows, and **correctness
did not change**: nine of the ten rows reach the same verdict on both machines, and tier
assignment is identical on all ten. Machine A, for comparison, on the rows it measured:
`qwen3.5:2b` ~125s simple, `qwen3.5:4b` 299s full, `gemma4:e2b` 180–200s full, and
`gemma4:e4b` could not run at all on 16 GB. Full detail, including
what each model broke and how, is in
[MODELS.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/MODELS.md).

### Building from scratch, not just editing

A second benchmark starts from an **empty folder** and asks the model to build a TODO app
in Java, JavaScript, and Python — grading *add*, *read*, *run*, and *modify* separately,
and checking the result by compiling and running the program rather than by believing the
model's summary. It runs on all three machines and the results are collected in
[benchmarks/](https://github.com/jaymar921/HirayaCoder/blob/main/benchmarks/README.md).

---

## Recommendation

**On a machine like Machine B (32 GB, any dedicated GPU): use `gemma4:e2b`.** Fastest to
a correct result at 25–43s. `ornith:9b` and `gemma4:e4b` are equally correct and worth
reaching for on harder work.

**On a 16 GB laptop with no GPU: use `qwen3.5:2b`**, keep `llama3.2:1b` for quick
single-file edits, and reach for `gemma4:e2b` when a task genuinely spans several files
and you're willing to wait.

**On Apple Silicon with 24 GB unified memory: use `gemma4:e2b`** — it is both the fastest
correct result (12.4s on the full task) and correct on both tasks, so there is no
trade-off to make. Reach for `gemma4:e4b` on harder work; at 23.6s and fully
GPU-resident it is an everyday option here rather than a stretch.

The rankings differ, and the reason is worth stating: on a slow machine the choice is
governed by **what fits and how long you'll wait**, so a small model wins. When every
model answers in about a minute, the constraint becomes **which one is right**, and the
small models lose that comparison badly. On a Mac with unified memory *neither*
constraint binds — everything fits and everything is fast — so you pick on correctness
alone and the latency follows.

**Avoid below ~1B.** `qwen3.5:0.8b` stays inside the guards and still cannot finish a
single-file edit.

---

## Requirements

**Required — nothing works without these:**

| | Version | Why |
|---|---|---|
| [**Ollama**](https://ollama.com) | any current release, running on `127.0.0.1:11434` | The model. HirayaCoder never calls a cloud API, so with no Ollama there is no assistant at all. |
| **A pulled model** | ≥ 1B parameters | `ollama pull gemma4:e2b`, or `llama3.2:1b` on a low-spec machine. See [Recommendation](#recommendation). |
| **VS Code** | 1.85.0 or newer | Set by `engines.vscode`; older builds refuse to install the extension. |
| **A trusted workspace folder** | — | Every tool is confined to the workspace root. With no folder open there is nothing to confine to, so all of them refuse. |

Ollama must be reachable on **loopback**. A non-loopback endpoint is rejected in code
before any socket opens, so a remote or LAN Ollama will not work — that is deliberate,
not a gap.

**Optional — only if you want the agent to run your project's tooling.**

`run_script` can execute a command, and the program it names has to already be installed;
HirayaCoder never installs anything. Nothing here is needed to read, write, or edit files
— only to build, test, or run what the agent wrote:

| Toolchain | Programs the agent may call |
|---|---|
| Node.js | `node`, `npm`, `npx`, `yarn`, `pnpm` |
| Python | `python`, `python3`, `pip`, `pip3`, `pytest` |
| Java | `java`, `javac`, `mvn`, `gradle` |
| Go / Rust / .NET | `go`, `cargo`, `dotnet` |
| JS test & build | `jest`, `mocha`, `vitest`, `ava`, `tsc`, `eslint`, `prettier` |
| Other | `git`, `make`, `ollama` |

So if you ask for a Python script and want it *run*, Python has to be on your `PATH`; if
you ask for a Java project and want it *compiled*, you need a JDK. Without them the agent
still writes the code — it just reports that it could not run it.

Two things about that list are worth knowing before they surprise you:

- **It is an allow-list, and it is the whole list.** Anything not on it is refused,
  including `mkdir`, `ls`, `rm`, and `curl`. You can extend it in HirayaCoder settings;
  the model cannot. File and folder work goes through the tools instead, which is why
  `mkdir` is not missed: writing a file creates the folders above it.
- **No shell is involved, ever.** Commands are spawned directly, so `&&`, `|`, `>`, and
  `$(…)` are refused rather than interpreted. One command at a time.

Full detail: [SECURITY.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/SECURITY.md).

**Building from source** additionally needs **Node.js ≥ 18** — see
[below](#building-from-source). Using the packaged `.vsix` does not.

---

## Quick Start

1. Install [Ollama](https://ollama.com), then pull a model — `ollama pull gemma4:e2b`
   (or `llama3.2:1b` on a low-spec machine).
2. Install the extension from the `.vsix` on the
   [Releases page](https://github.com/jaymar921/HirayaCoder/releases):
   `code --install-extension hirayacoder-<version>.vsix`
3. Open a folder, then press `Ctrl+Shift+H` (`Cmd+Shift+H` on macOS) — or use the
   HirayaCoder icon in the activity bar.

Full walkthrough: [TUTORIAL.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/TUTORIAL.md) ·
Every feature and setting: [FEATURES.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/FEATURES.md)

### Building from source

```bash
npm install
npm run test:all     # lint + unit + integration, against a real VS Code
npm run package      # builds builds/v<version>/hirayacoder-<version>.vsix
```

---

## Contributing

Contributions are welcome, and there is **one hard rule: pull requests only — never
push directly to `main`.**

Every change reaches `main` through a pull request that CI has passed on Ubuntu, macOS,
and Windows. That matrix is the only evidence this project has that anything works on
the two platforms the maintainer doesn't own, and a direct push skips it entirely.

Read [CONTRIBUTING.md](https://github.com/jaymar921/HirayaCoder/blob/main/CONTRIBUTING.md)
before opening one, and
[ARCHITECTURE.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/ARCHITECTURE.md)
for how the pieces fit together. The short version:

- Branch as `feat/…`, `fix/…`, `docs/…`; commit messages use the same prefixes.
- `npm run test:all` must pass.
- **If you touched the agent loop, prompts, translator, or tools, run a real model**
  (`node tools/bench-agent.js gemma4:e2b agent auto full`) and put the outcome in the
  pull request. The mocked suite has passed clean while a real model destroyed a real
  file — repeatedly.
- Don't weaken a guard or a permission prompt to make something pass.
- Comments explain *why*, not *what*.

Security issues: please contact [jaymar921](https://github.com/jaymar921) directly
rather than opening a public issue.

---

## Repository Layout

```
HirayaCoder/
├── app/        # Extension source — agent loops, tools, security layer, webview
├── test/       # Unit + integration tests
├── doc/        # Architecture, features, models, tutorial, security, publishing
├── setup/      # AI build prompt + versioned model/translator system prompts
├── security/   # Threat model, SAST reports
├── scripts/    # Packaging
├── tools/      # Live-model benchmark harness
└── builds/     # Packaged .vsix output, per version (gitignored)
```

## Security

[SECURITY.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/SECURITY.md) covers
the model; [threat-model.md](https://github.com/jaymar921/HirayaCoder/blob/main/security/threat-model.md)
has the full matrix. SAST results are tracked per release in
[`/security/`](https://github.com/jaymar921/HirayaCoder/tree/main/security) — ESLint,
`npm audit`, Semgrep, and retire.js, with the manual review checklist filled in.

The shipped extension has **zero production dependencies**.

## Built from an AI prompt

This project was scaffolded from a single structured specification designed for AI
coding agents. See [PROMPT.md](https://github.com/jaymar921/HirayaCoder/blob/main/setup/PROMPT.md)
for the full build order, feature list, and security requirements.

## Author

Built by [**jaymar921**](https://github.com/jaymar921).

## License

Licensed under the terms in [LICENSE](https://github.com/jaymar921/HirayaCoder/blob/main/LICENSE).
