# HirayaCoder

By: [Jayharron Abejar](https://jayharronabejar.vercel.app)

*A local Filipino-inspired AI coder that brings imagination and speed to your VS Code workflow.*

HirayaCoder is a **fully offline** VS Code extension that pairs your editor with a **local Ollama** LLM. It's built to run on modest laptop hardware — down to a 1B-parameter, non-agentic model — while still scaling up to full agentic, tool-calling workflows on stronger machines. No cloud calls, no telemetry, no data leaving your machine.

> **Hiraya** (Filipino) — imagination, aspiration, the spark of an idea before it becomes real.

---

## Why HirayaCoder

- 🔒 **Private by construction** — only ever talks to `127.0.0.1` (your local Ollama instance).
- 💻 **Low-spec friendly** — designed and tested against `llama3.2:1b` for machines without a GPU.
- 🧠 **Tiered intelligence** — automatically detects whether your model supports agentic tool-calling (Tier A) or needs a constrained single-shot JSON workflow (Tier B), and adapts.
- 🛡️ **Security-first** — every file write and terminal command requires explicit approval; see [`/doc/SECURITY.md`](doc/SECURITY.md).
- 🇵🇭 **Made with a Filipino developer's sensibility** — practical, resourceful, built for real hardware, not just top-spec dev machines.

---

## Repository Layout

```
HirayaCoder/
├── app/        # Extension source code
├── test/       # Unit + integration tests
├── doc/        # Tutorial, architecture, feature docs, security model
├── setup/      # AI build prompt + versioned model system prompts
├── security/   # Threat model, SAST report template, rules
└── docs/       # Icons, screenshots, marketing assets
```

## Quick Start

1. Install [Ollama](https://ollama.com) and run `ollama pull llama3.2:1b`.
2. `npm install` in this repo, then press `F5` in VS Code to launch the dev host.
3. Open the HirayaCoder chat panel and start coding.

Full walkthrough: [`/doc/TUTORIAL.md`](doc/TUTORIAL.md)

## Building From the AI Prompt

This project was scaffolded from a single structured prompt designed for AI coding agents (Claude Code, etc.). See [`/setup/PROMPT.md`](setup/PROMPT.md) for the full specification, feature list, security requirements, and build order — re-runnable per phase for iterative feature work.

## Security

See [`/doc/SECURITY.md`](doc/SECURITY.md) for the security model and [`/security/threat-model.md`](security/threat-model.md) for the full threat matrix. SAST results are tracked per release in [`/security/sast-report-template.md`](security/sast-report-template.md).

## License

Choose and add a license (MIT recommended for a dev-tool extension) — see `LICENSE`.
