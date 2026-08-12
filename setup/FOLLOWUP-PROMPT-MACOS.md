# HirayaCoder — macOS Handoff (Machine C)

> Feed this to a coding AI on the Mac, alongside `setup/PROMPT.md` (the original
> specification) and `doc/MODELS.md` (the measurements so far).
>
> **This handoff has one job**: measure every model on Apple Silicon, and be the first
> human to use the packaged extension on macOS. Development of v0.2.0 continues on the
> Windows desktop in parallel — **do not start feature work here.** If you find a bug,
> record it and open an issue or a small PR; don't fix it alongside a benchmark run, or
> the numbers stop describing one code state.

**Handoff date:** 2026-08-12
**Shipped:** v0.1.0 (pre-release, GitHub Releases)
**Reason:** macOS has never been used by a human. CI runs the suites there, which is not
the same thing.

---

## 0. Read this first

Three things are load-bearing and easy to undo by accident.

1. **The mocked suite passes clean while a real model destroys a file.** Almost every
   serious bug in this project was found by running a live model. 598 unit tests were
   green through all six file-destroying failures in `doc/MODELS.md`.
2. **Judge a run by whether the workspace ended up worse**, not by whether the model
   finished. A guard firing and the session stopping is the system working.
3. **`think: false` is mandatory on every structured-output call.** Hybrid reasoning
   models otherwise return empty `content` with the whole budget spent in
   `message.thinking`. This has broken the project twice.

---

## 1. What this machine is

| | |
|---|---|
| Model | MacBook Pro 16-inch, M4 Pro, 2024 |
| CPU | Apple M4 Pro, 14-core (10 performance + 4 efficiency) |
| GPU | 20-core, hardware-accelerated ray tracing |
| Memory | **24 GB unified** |
| OS | macOS |

**Unified memory is the thing that makes this machine different**, and it is the whole
reason for the exercise. The other two machines both have a hard split:

- **Machine A (laptop, 16 GB, no dGPU)** — CPU-only. Every model runs on the CPU.
- **Machine B (desktop, 32 GB, GTX 1650 Super, 4 GB VRAM)** — models are *split*. Only
  the two smallest were fully GPU-resident; `gemma4:e4b` managed 15% GPU.

Here, the GPU addresses the same 24 GB the CPU does. Metal is typically allowed about
75% of it (~18 GB), which is more than every model in the matrix needs. So the
prediction is that **every model runs at or near 100% GPU** — a configuration neither
other machine could produce.

---

## 2. Install

```bash
# Ollama for macOS: https://ollama.com/download
ollama --version

# The nine models already measured elsewhere. Pull all of them; the point is a
# like-for-like comparison, including the ones that fail.
ollama pull qwen3.5:0.8b        # 1.0 GB   873M   below the usable floor — keep it, it is the floor test
ollama pull llama3.2:1b         # 1.3 GB   1.2B   the project's low-spec design target
ollama pull qwen3.5:2b          # 2.7 GB   2.3B
ollama pull qwen3.5:4b          # 3.4 GB   4.7B
ollama pull stable-code:latest  # 1.6 GB   3B     no tool support — exercises the Tier B fallback
ollama pull llama3.2:latest     # 2.0 GB   3.2B
ollama pull gemma4:e2b          # 7.2 GB   5.1B   fastest to a correct result on Machine B
ollama pull ornith:9b           # 5.6 GB   9.0B
ollama pull gemma4:e4b          # 9.6 GB   8.0B   could not run at all on Machine A
```

```bash
git clone https://github.com/jaymar921/HirayaCoder.git
cd HirayaCoder
npm install
npm run test:all     # lint + 598 unit + 15 integration, against a real VS Code
```

`test:all` downloads VS Code (~330 MB) the first time. If the integration suite fails to
launch, read `test/integration/runTests.js` — the macOS binary path inside
`Visual Studio Code.app/Contents/MacOS/` is *predicted* by the downloader rather than
checked, and there is a resolver there that reports the directory's real contents when
the prediction is wrong. Paste that error verbatim if it fires.

---

## 3. The benchmark

```bash
node tools/bench-agent.js <model> [mode] [approve|auto] [simple|full] [A|B]
```

Nineteen runs: nine models × two tasks, plus `gemma4:e2b` forced to Tier B.

```bash
node tools/bench-agent.js qwen3.5:2b agent auto simple
node tools/bench-agent.js qwen3.5:2b agent auto full
node tools/bench-agent.js gemma4:e2b agent auto full B    # force the ReAct loop
```

**Rules that make the numbers mean anything:**

- **Nothing else running.** On Machine A a concurrent test suite pushed one turn past a
  300s timeout and produced a "failure" that was pure measurement artefact.
- **One run at a time.** Two models at once measures contention.
- **Record `ollama ps` immediately after each run** — it reports the CPU/GPU split and
  the resident size, and that split explains a timing better than any other number.
  This is the single most important thing to capture on this machine.
- **Let it cool between long runs.** A familiar model suddenly running many times slower
  is a thermal signal, not a regression.
- Report time as **seconds and minutes** — `299s (5.0 min)` — as `doc/MODELS.md` does.

**Judge each run by reading the file the model produced**, not by whether the session
said "done". The fixture task is: make `greet("")` return `"Hello there"`, keep greeting
by name otherwise, and keep `module.exports`. A run that reports success having changed
nothing has failed. A run whose write was refused by a guard, leaving the file intact,
has *not* damaged anything — record it as a fail on the task and a pass for the guards.

The delete in the `full` task is declined at the prompt on purpose. **A model that claims
it deleted the file has failed that part**, however good the rest looked.

---

## 4. What to write down

Add a **Machine C** section to `doc/MODELS.md`. **Do not overwrite Machine A or B.**
Losing either baseline loses the ability to say whether anything improved for the
machine that needed it.

| Model | Tier | Simple | Full | Resident | CPU/GPU | Verdict |
|---|---|---|---|---|---|---|

Then answer these, in the doc, with what actually happened:

1. **Is every model 100% GPU?** Including `gemma4:e4b` at 9.6 GB. If any model is split,
   say at what size the split begins — that is the number a reader with a 16 GB or 8 GB
   Mac needs.
2. **How much faster than Machine B?** Machine B's fastest correct result was
   `gemma4:e2b` at 25.5s on the full task.
3. **Does correctness change?** It should not — same weights, same prompts. If
   `qwen3.5:2b` produces correct logic here after producing plausible-but-wrong logic
   twice on Machine B, that is run-to-run variance, not the hardware. Say so explicitly
   rather than implying the Mac made the model smarter.
4. **Does the recommendation change?** Machine A says `qwen3.5:2b`; Machine B says
   `gemma4:e2b`. Both follow from the constraint that binds — fit-and-latency on A,
   correctness on B. Say which binds here.

Update the README's results table and recommendation only **after** the numbers exist.
The README currently lists this machine as pending, deliberately.

---

## 5. The other half: be the first human to use it on macOS

This matters more than the timings. CI runs the automated suites on macOS; nobody has
installed the packaged extension and used it.

```bash
# From the GitHub release, or build it locally:
npm run package
code --install-extension builds/v0.1.0/hirayacoder-0.1.0.vsix
```

Then walk through, and record anything that looks wrong:

1. **Activation** — status bar shows a connection; the HirayaCoder icon appears in the
   activity bar and is legible in both light and dark themes. It is monochrome line art
   recoloured by the theme, so a solid block or a blank square is a bug.
2. **`Cmd+Shift+H`** opens the chat tab, and the tab carries the icon.
3. **An Agent-mode edit**, with the **Review diff** button on the confirmation. It should
   open VS Code's own diff viewer.
4. **A declined delete** — the summary must say it was not deleted. A model claiming
   success there is the specific failure `appendUnfinishedNote` exists to catch.
5. **`npm test` through the agent.** This is the one that has actually broken before, on
   Windows. macOS takes the `/bin/sh -c` path in `security/scriptRunner.js`, which no
   human has exercised.
6. **A path with a space** — `~/My Projects/thing`. Cheap, and the Windows failure was
   exactly this.
7. **Case sensitivity.** macOS is case-insensitive by default; `security/pathGuard.js`
   case-folds on `darwin` for that reason. Try to reach a file outside the workspace
   using a differently-cased path and confirm it is refused.
8. **Close a chat tab, reopen the session** from the activity bar. The conversation
   should still be there.
9. **`javac`/`java`** were added to the allow-list after a real session could write Java
   but not compile it. If a JDK is installed, ask the agent to compile and run something
   small.

---

## 6. Working agreements

- **Pull requests only. Never push to `main`.** CI runs the three-platform verify on the
  PR, and that matrix is the project's only evidence about macOS and Linux. See
  `CONTRIBUTING.md`.
- **Do not start v0.2.0 work here.** It is in progress on the Windows desktop, on the
  `self-optimization` branch. `doc/SELF-OPTIMIZATION.md` has the design if you want
  context, but two people building the same thing on two machines is how a merge
  conflict becomes a lost fix.
- **Benchmark changes and code changes never share a commit.** If you fix something,
  re-run the affected benchmarks afterwards so every row in the table describes one
  code state.
- **Comments explain why, not what.** Every guard in `app/agent/tools/writeFile.js`
  names the live failure that produced it. Match that.
- **Record what you ran it against.** A timing without its hardware is not a
  measurement, and "it worked" without a model name is not a result.
