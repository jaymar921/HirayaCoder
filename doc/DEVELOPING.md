# Developing HirayaCoder

Everything the README's beginner path leaves out: what is interesting about the design,
how it is measured, and how to build and contribute to it.

---


Everything above is the beginner's path. The rest is the engineering, and it is
documented properly elsewhere.

**Features and settings** — [FEATURES.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/FEATURES.md)
· **How it is built** — [ARCHITECTURE.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/ARCHITECTURE.md)
· **Measurements** — [MODELS.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/MODELS.md)
· **Security model** — [SECURITY.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/SECURITY.md)

## What is interesting about it technically

- **Agentic on every model, down to 1B.** It plans, reads, edits, deletes, and runs
  scripts across multiple files on its own. Two loop strategies — native tool-calling for
  capable models, a constrained one-action-per-turn JSON loop for small ones — behind one
  driver, so the mechanism changes with the model but the reach never does.
- **Three layers of local memory.** A plain-text session log, the conversation itself,
  and typed facts about the project that persist across sessions, so the second session
  does not rediscover what the first one paid for.
- **"Done" has to be true.** A run that reports success having written nothing, or having
  left `// Implement this here` inside a function it just wrote, gets sent back once with
  the specific problem named. Completion is judged from what changed on disk, never from
  what the model says about itself.
- **It learns from what actually happened.** Outcomes are recorded locally — counts and
  guard codes, never your code — and a model that trips the same guard three times gets
  the matching correction added to its prompt. It adapts what the model is *told*, never
  what it is *allowed to do*.
- **Every guard names a real failure.** The write guards exist because four different
  models produced six damaged files in one seventeen-run sweep: deleted exports, a
  CommonJS module silently rewritten as ESM, an implementation replaced by an empty
  object. Every one of them parsed cleanly.

## Benchmarks

Measured on three named machines, with the delete declined at the prompt on purpose — a
model that claims it deleted the file has failed the task whatever else it got right.
There are four harnesses: editing an existing project, building one from an empty folder,
wiring an existing project together, and — new in 0.9.0 — building a whole application
from one brief and then **driving the finished thing**, either by clicking every control
in a headless browser or by calling its service layer directly.

That last harness runs four briefs, so a model's trouble with the work can be told apart
from its trouble with the language it was asked to work in:

| Brief | Stack | Graded by |
|---|---|---|
| TODO app | React + Vite + Tailwind | 12 features, clicked in a browser |
| Contact manager | React + Vite + Vitest | 12 features, clicked in a browser |
| Point of sale | Java + Swing + Maven | 8 features, through the service layer |
| Point of sale | Python + Tkinter, stdlib only | 8 features, through the service layer |

It exists because of a result worth stating plainly: a model passed the scaffold,
structure, install and build checks, and shipped an app whose only button incremented
Vite's demo counter. Four green gates and nothing that worked. The full
tables, including what each model broke and how, are in
[MODELS.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/MODELS.md) and
[benchmarks/](https://github.com/jaymar921/HirayaCoder/blob/main/benchmarks/README.md).

The finding worth repeating here: **the mocked test suite passes clean while a real model
destroys a real file.** Nearly every serious bug in this project was found by running an
actual model, never by the unit tests.

## Building from source

Needs Node.js 18 or newer.

```bash
npm install
npm run test:all     # lint + unit + integration, against a real VS Code
npm run package      # builds builds/v<version>/hirayacoder-<version>.vsix
```

## Contributing

Contributions are welcome, with **one hard rule: pull requests only — never push
directly to `main`.** CI runs the suite on Ubuntu, macOS, and Windows, and that matrix is
the only evidence this project has that anything works on the two platforms the
maintainer does not own.

Read [CONTRIBUTING.md](https://github.com/jaymar921/HirayaCoder/blob/main/CONTRIBUTING.md)
first. The short version:

- Branch and commit as `feat/…`, `fix/…`, `docs/…`.
- `npm run test:all` must pass.
- **If you touched the agent loop, prompts, translator, or tools, run a real model**
  (`node tools/bench-agent.js gemma4:e2b agent auto full`) and put the outcome in the PR.
- Don't weaken a guard or a permission prompt to make something pass.
- Comments explain *why*, not *what*.

Security issues: please contact [jaymar921](https://github.com/jaymar921) directly rather
than opening a public issue.

## Repository layout

```
HirayaCoder/
├── app/        # Extension source — agent loops, tools, security layer, webview
├── test/       # Unit + integration tests
├── doc/        # Architecture, features, models, tutorial, security, publishing
├── setup/      # AI build prompt + versioned model/translator system prompts
├── security/   # Threat model, SAST reports
├── scripts/    # Packaging
├── tools/      # Live-model benchmark harnesses
└── builds/     # Packaged .vsix output, per version (gitignored)
```

---

---

## Next

- [How it is built](ARCHITECTURE.md)
- [Every feature and setting](FEATURES.md)
- [The security model and threat model](SECURITY.md)
- [Publishing a release](PUBLISHING.md)
