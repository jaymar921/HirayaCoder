# HirayaCoder — Machine B Handoff: the step-sessions benchmark (v0.5.0)

> Feed this to a coding AI on the desktop, alongside `doc/MODELS.md` (the measurements so
> far) and the `## [Unreleased] — 0.5.0` section of `CHANGELOG.md` (what changed and why).
>
> **This handoff has one job**: run the paired `bench-steps` benchmark on Machine B and
> record the result. It is a measurement task, not a feature task. If you find a bug,
> write it down and open an issue or a separate PR — do not fix it between two halves of
> a paired run, or the two halves stop describing one code state.

**Handoff date:** 2026-08-13
**Branch:** `feat/step-sessions-enhanced-memory`
**Version:** 0.5.0 (unreleased)
**Produced on:** Machine A (CPU-only laptop), which is why this is worth repeating here.

---

## 0. Read this first

1. **The mocked suite passes clean while a real model produces a broken app.** 928 unit
   tests were green through every failure below. The suite is not the evidence; the run
   is.
2. **Judge a run by the file the model produced**, not by whether the session said
   "done". Every failure in this whole investigation was a run reporting success.
3. **A guard firing and the step failing is the system working.** A step marked `failed`
   with a stated reason is a better outcome than one marked `done` that wrote nothing.

---

## 1. Why Machine B specifically

Machine A produced everything so far, and it has one weakness as a measurement platform:
**it is too slow to run the control.**

The step-sessions comparison on Machine A is `v0.4.0 code, five models` against `v0.5.0
code, one model`. Those differ by more than the feature — they differ by three bug fixes
that landed in the same release. So the honest statement of what Machine A showed is
"0.5.0 wires the app where 0.4.0 never did", and *not* "step sessions are what did it".

At 20–25 minutes per run on Machine A, the paired control was unaffordable. On Machine B
it should be a few minutes. **The paired run is the whole point of this handoff**: same
commit, same model, same fixture, `steps` on and off.

Machine B is also the only machine that can say whether any of this depends on partial
GPU offload.

| | |
|---|---|
| CPU | AMD Ryzen 5 3600X (6 cores / 12 threads) |
| RAM | 32 GB DDR4-3200 |
| GPU | NVIDIA GTX 1650 Super, **4 GB VRAM** |
| OS | Windows 11 |
| Ollama | partial GPU offload — models split between the card and system RAM |

---

## 2. Setup

```bash
git clone https://github.com/jaymar921/HirayaCoder.git    # or pull, if you have it
cd HirayaCoder
git fetch origin
git checkout feat/step-sessions-enhanced-memory
npm install
npm run test:unit
```

> If `git checkout` cannot find the branch, it had not been pushed when you read this —
> ask before working around it.

**Expect 928 passing and up to 4 failing.** The failures are `transcriptStore` and
`scriptRunner` timing out, and on Machine A they fail identically on a clean tree — an
artefact of a OneDrive-synced working directory. If they pass on Machine B, that confirms
the diagnosis; **say so, because it is useful.** If anything *else* fails, stop and report
it before benchmarking — the numbers would describe a broken tree.

Models. The four in the matrix that can hold a TODO list at all:

```bash
ollama pull qwen3.5:2b     # 2.3B, Tier B — the only Tier B model that can, worth having
ollama pull qwen3.5:4b     # 4.7B, Tier A — Machine A's whole dataset is this model
ollama pull gemma4:e4b     # 8.0B, Tier A — 9.6 GB; Machine A could barely hold it
ollama pull ornith:9b      # 9.0B, Tier A
```

Step sessions require the `thinking` capability **and** ≥ 2B parameters. `llama3.2:1b`
and `gemma4:e2b` cannot use them at all — the run falls back to a single pass. That is
not a bug and is not worth a row.

Optional, only if you want to reproduce the original five-model evaluation:
`gemma2:latest` and `lfm2:latest`. `lfm2:latest` produced zero steps and errored out on
Machine A; if it does the same here, that is a confirmation, not a new finding.

---

## 3. The benchmark

```bash
node tools/bench-steps.js <model> steps   --machine B
node tools/bench-steps.js <model> nosteps --machine B
```

`--machine` is required. A timing without its machine cannot be compared with anything.

The fixture is the Vite React scaffold — `App.jsx` holding the counter demo — and the
task asks for a `useTodos` hook, two components, and `App.jsx` rewritten to use them.
**The last item is the one that matters**: it can only be done by importing what the
earlier items wrote.

The harness grades it itself and prints the `App.jsx` import lines verbatim:

```
App.jsx changed YES
App.jsx names   useTodos, TodoInput, TodoList
  of those, resolving to a real file: useTodos, TodoInput, TodoList
still counter   no
```

`names` versus `resolving` is the distinction that matters, and it is not pedantry — it
is the difference between the two Machine A runs. A model can name all three imports and
have every path point at nothing, which is a broken app that every other signal reports
as success:

```
  BROKEN import path(s): useTodos, TodoInput
import { useTodos } from '../hooks/useTodos.js';   ← from src/App.jsx, one level too high
```

The model's own summary is printed at the end and **counts for nothing**. It is there so
you can see how confidently a failed run describes itself.

### Rules that make the numbers mean anything

- **Nothing else running.** On Machine A a concurrent test suite pushed a turn past its
  timeout and produced a "failure" that was pure measurement artefact. This has already
  happened once in this project; do not let it happen twice.
- **One run at a time.** Two models at once measures contention.
- **Run `ollama ps` immediately after each run** and record the CPU/GPU split and
  resident size. On this machine that split explains a timing better than any other
  number.
- **Run each pair back to back**, same model, `steps` then `nosteps`, before moving to
  the next model. Interleaving invites a thermal or cache difference to be read as a
  feature difference.
- **Expect run-to-run variance and do not explain it away.** Machine A's three runs of
  the same model and same code produced a working app, a broken-import app, and a working
  app. If you have time for a second pair on `qwen3.5:4b`, it is worth more than a fourth
  model.
- Report time as **seconds and minutes** — `299s (5.0 min)` — as `doc/MODELS.md` does.

### The timeout

Machine A needed `timeoutMs: 900000`; the harness now sets that itself. The *shipped
setting* — `hirayacoder.ollama.requestTimeoutMs` — still defaults to 300000, and on
Machine A that was not enough to generate one `App.jsx`. **Machine B is the test of
whether that default is only a laptop problem.** If nothing here approaches 300s, say so
plainly: it settles whether the default should change.

---

## 4. What to write down

**Machine C is benchmarking at the same time you are, on the same branch.** Every run now
writes its own JSON file to `benchmarks/results/<machine>/`, one file per run, never
appended — so the two of you cannot conflict as long as you let the harness do the
writing. Commit those files as they are. (If you started before this landed, `git pull`;
runs already finished are still in your terminal and can be pasted.)

Then collate:

```bash
node tools/bench-steps-summary.js --machine B
```

It prints a markdown table and lists each run that did not produce a working app, with its
reason. Paste both into `doc/MODELS.md` under a **Machine B** subsection alongside Machine
A. **Do not overwrite Machine A**, and do not hand-edit Machine C's rows — losing a
baseline loses the ability to say whether anything helped the machine that needed it.

If you pull and find Machine C has already added its section, rebase rather than resolving
by hand; the JSON files are the source of truth and the table is regenerable.

Then answer these in the doc, with what actually happened:

1. **Does `nosteps` fail where `steps` succeeds, on the same commit?** This is the
   question. If both succeed, say so — it would mean the three bug fixes did the work and
   step sessions are optional polish, which is a *more useful* result than a confirmation
   and should be reported with the same enthusiasm.
2. **Does the broken-import guard ever fire?** It is covered by twelve unit tests built
   from Machine A's verbatim output, but **no live run has yet produced a bad path since
   the guard was added**. If you see `WARNING: … imports N file(s) that are not there`
   followed by a corrected rewrite, that closes a gap I could not close. Paste the whole
   sequence.
3. **Does the retry fire, and does it help?** Machine A's run 3 succeeded only because a
   timed-out step wrote nothing, the guard failed it, and the retry ran it again. On a
   faster machine that timeout will not happen — so does the retry still earn its place,
   or is it a slow-machine feature?
4. **How much faster than Machine A?** Machine A: 12–24 minutes per run on `qwen3.5:4b`.
5. **Does `gemma4:e4b` change the answer?** It is the largest model that runs here and
   Machine A could barely hold it. If the wiring step is reliable on it and unreliable on
   `qwen3.5:4b`, that is a recommendation, not a curiosity.

---

## 5. What not to do

- **Do not push to `main`.** Pull requests only; CI's three-platform matrix on the PR is
  the project's only evidence about macOS and Linux.
- **Do not fix bugs mid-benchmark.** Benchmark changes and code changes never share a
  commit, and a paired run must describe one code state on both sides.
- **Do not tune the prompt to make a run pass.** The fixture and task are fixed on
  purpose; a benchmark you can adjust until it succeeds measures nothing.
- **Do not delete a failed run's output.** The two most valuable artefacts in this whole
  investigation were a failing transcript and a wrong import path.
- **Do not start feature work on this branch.** It is open on Machine A.

---

## 6. If you only have time for one thing

```bash
node tools/bench-steps.js qwen3.5:4b nosteps --machine B
node tools/bench-steps.js qwen3.5:4b steps   --machine B
```

That pair, in that order, and the two grade blocks pasted verbatim into `doc/MODELS.md`.
It is the control Machine A could not afford, and it is the only thing that separates
"0.5.0 fixed it" from "step sessions fixed it".
