# HirayaCoder

<p align="center">
  <img src="docs/assets/icon-128.png" width="96" height="96" alt="HirayaCoder icon" />
</p>

*A local Filipino-inspired AI coder that brings imagination and speed to your VS Code workflow.*

HirayaCoder is a **fully offline** VS Code extension that pairs your editor with a **local Ollama** LLM. It's built to run on modest laptop hardware — down to a 1B-parameter model — while still scaling up to full native tool-calling workflows on stronger machines. No cloud calls, no telemetry, no data leaving your machine.

> **Hiraya** (Filipino) — imagination, aspiration, the spark of an idea before it becomes real.

---

## Why HirayaCoder

- 🤖 **Agentic on every model** — plans, reads files, edits, deletes, and runs scripts across multiple files within a task on its own, the way Claude Code and Copilot Chat do — even on a 1B model.
- 🎚️ **Agent / Plan / Ask modes** — ask a quick question without triggering the agent loop, preview a read-only plan before anything changes, or let it run the full task end to end.
- 🧠 **Smarter small models via memory** — a local, plain-text, in-memory + on-disk memory store (`.hirayacoder/memory/`) and a context translator keep a 1B model "aware" of what it already did earlier in the session, compensating for its tiny context window.
- 📎 **Context files** — attach one or more reference files with the `+` button so the agent has clear direction before it starts.
- 🗂️ **Chat lives in its own tab** — opens as a full editor tab, just like GitHub Copilot Chat and Claude Code, not squeezed into a small sidebar.
- 🔒 **Private by construction** — only ever talks to `127.0.0.1` (your local Ollama instance).
- 🛡️ **Explicit permissions** — four clear modes (Approve Edits / Auto Edit / Approve Running Scripts / Auto Approve Running Scripts) so file edits, deletes, and shell commands never run without the control you choose. See [`/doc/SECURITY.md`](doc/SECURITY.md).
- 💻 **Low-spec friendly** — designed and tested against `llama3.2:1b` for machines without a GPU.
- 🌐 **Cross-platform** — works the same on macOS, Windows, and Linux.
- 🇵🇭 **Made with a Filipino developer's sensibility** — practical, resourceful, built for real hardware, not just top-spec dev machines.

---

## Repository Layout

```
HirayaCoder/
├── app/        # Extension source code
├── test/       # Unit + integration tests
├── doc/        # Tutorial, architecture, feature docs, security model, publishing guide
├── setup/      # AI build prompt + versioned model/translator system prompts
├── security/   # Threat model, SAST report template, rules
├── builds/     # Packaged .vsix output, organized by version (gitignored — see doc/PUBLISHING.md)
└── docs/       # Icon, screenshots, marketing assets
```

## Quick Start

1. Install [Ollama](https://ollama.com) and run `ollama pull llama3.2:1b`.
2. `npm install` in this repo, then press `F5` in VS Code to launch the dev host.
3. Run `HirayaCoder: Open Chat` — it opens in its own tab with a welcome screen: model dropdown, thinking capacity, permissions menu, and a `+` to attach context files.

Full walkthrough: [`/doc/TUTORIAL.md`](doc/TUTORIAL.md)

## Building From the AI Prompt

This project was scaffolded from a single structured prompt designed for AI coding agents (Claude Code, etc.). See [`/setup/PROMPT.md`](setup/PROMPT.md) for the full specification, feature list, security requirements, and build order — re-runnable per phase for iterative feature work.

## Security

See [`/doc/SECURITY.md`](doc/SECURITY.md) for the security model and [`/security/threat-model.md`](security/threat-model.md) for the full threat matrix. SAST results are tracked per release in [`/security/sast-report-template.md`](security/sast-report-template.md).

## Publishing

Once a version is fully built, tested, and SAST-clean, follow [`/doc/PUBLISHING.md`](doc/PUBLISHING.md) for the complete, step-by-step path to shipping it on the VS Code Marketplace — publisher setup, packaging into [`/builds/`](builds/), and the actual `vsce publish` flow.

## Author

Built by [**jaymar921**](https://github.com/jaymar921).

## License

This project is licensed under the terms in [LICENSE](LICENSE).
