# HirayaCoder — Machine C Handoff: the step-sessions benchmark (v0.5.0)

> Feed this to a coding AI on the Mac, alongside `doc/MODELS.md` (the measurements so
> far) and the `## [Unreleased] — 0.5.0` section of `CHANGELOG.md` (what changed and why).
> `setup/FOLLOWUP-PROMPT-MACOS.md` is the earlier macOS handoff and still describes the
> machine correctly; this one replaces its *task*, not its setup advice.
>
> **This handoff has one job**, and it is different from Machine B's. B is running the
> paired control right now. C is here because it is the only machine fast enough to
> measure **variance** — and variance is the thing this task most obviously has and the
> project has never quantified.

**Handoff date:** 2026-08-13
**Branch:** `feat/step-sessions-enhanced-memory`
**Version:** 0.5.0 (unreleased)
**Already running elsewhere:** Machine A (done, 4 runs), Machine B (in progress)

---

## 0. Read this first

1. **The mocked suite passes clean while a real model produces a broken app.** 928 unit
   tests were green through every failure in this investigation.
2. **Judge a run by the file the model produced**, never by whether the session said
   "done". Every failure here was a run reporting success.
3. **A guard firing and the step failing is the system working.** A step marked `failed`
   with a stated reason beats one marked `done` that wrote nothing.

---

## 1. Setup

```bash
git fetch origin
git checkout feat/step-sessions-enhanced-memory
npm install
npm run test:unit
```

**Expect 928 passing.** On Machine A up to 4 fail — `transcriptStore` and `scriptRunner`
timing out — and they fail identically on a clean tree there, which points at its
OneDrive-synced working directory rather than at the code. **If they pass here, say so.**
Two machines agreeing that they pass turns a suspicion into a diagnosis.

Models — the four in the matrix that can hold a TODO list. Step sessions need the
`thinking` capability *and* ≥ 2B parameters, so `llama3.2:1b` and `gemma4:e2b` cannot use
them at all; that is expected and not worth a row.

```bash
ollama pull qwen3.5:2b     # 2.3B, Tier B — the only Tier B model that qualifies
ollama pull qwen3.5:4b     # 4.7B, Tier A — every Machine A datapoint is this model
ollama pull gemma4:e4b     # 8.0B, Tier A — 9.6 GB, fully GPU-resident only here
ollama pull ornith:9b      # 9.0B, Tier A
```

---

## 2. A macOS correctness check that is already fixed — confirm it holds here

Recorded because it was nearly *your* job, and because the fix is unverified on macOS.

`app/core/importGraph.js` decides whether a written import resolves. It originally used
`fs.stat`, which on Windows and macOS resolves `./hooks/usetodos.js` to `useTodos.js` and
reports success — so a case-wrong import would build locally and fail on Linux CI, and
the guard would be quietly wrong in the one direction that ships a broken build.

That was confirmed on Machine A and fixed: `existsExactly` reads the parent directory and
compares every path segment byte-for-byte, because `readdir` returns the real spelling
however the lookup was cased. **The fix has only ever run on Windows.** APFS is
case-insensitive by default but not identically so, so please confirm it holds:

```bash
npx mocha test/unit/brokenImports.test.js
```

The four cases under *"case, which is the failure that only appears on someone else's
machine"* must pass. If any fails on macOS, that is a real finding — report it with the
output and do not patch it inside a benchmark run.

While you are here, the macOS paths that no human has exercised much:

- **`npm test` through the agent** — macOS takes the `/bin/sh -c` branch in
  `security/scriptRunner.js`. This has broken on Windows before.
- **A workspace path containing a space** — `~/My Projects/thing`.
- **Reaching outside the workspace with differently-cased path components** — it must
  still be refused.

---

## 3. The job — variance, which only this machine can afford

Machine A ran `qwen3.5:4b` four times, on the same fixture, and got: a working app, an app
whose imports all pointed at nothing, and two more working apps. **One run tells you
almost nothing about this task**, and Machine A at 13–24 minutes a run could not say more.
One run in four produced a broken app — a rate estimated from four samples, which is to
say barely estimated at all.

If a run here takes two or three minutes, then ten runs is under an hour, and this
machine can produce the first honest success *rate* the project has for the wiring task.

```bash
node tools/bench-steps.js qwen3.5:4b steps   --machine C
node tools/bench-steps.js qwen3.5:4b nosteps --machine C
```

`--machine` is required. Time one pair first, then decide the repeat count from what it
actually costs — **five pairs is a good result and ten is a better one**; do not commit to
a number before you know the price.

The harness grades itself and prints the `App.jsx` import lines verbatim:

```
App.jsx changed YES
App.jsx names   useTodos, TodoInput, TodoList
  of those, resolving to a real file: useTodos, TodoInput, TodoList
still counter   no
```

`names` versus `resolving` is the whole point, and it is the difference between two
Machine A runs. A model can name all three and have every path point one level too high:

```
  BROKEN import path(s): useTodos, TodoInput
import { useTodos } from '../hooks/useTodos.js';   ← from src/App.jsx
```

The model's own summary prints at the end and **counts for nothing**. It is there so you
can see how confidently a failed run describes itself.

### Rules that make the numbers mean anything

- **Nothing else running.** On Machine A a concurrent test suite pushed a turn past its
  timeout and produced a "failure" that was pure measurement artefact. It has happened
  once; do not let it happen twice.
- **One run at a time.** Two models at once measures contention.
- **`ollama ps` after each run.** The prediction for this machine is 100% GPU on every
  model including `gemma4:e4b` at 9.6 GB, which held for the earlier benchmark. Confirm
  it still does under this workload — a long single generation is a different memory
  profile from a short one.
- **Let it cool between long runs.** A familiar model suddenly much slower is thermal,
  not a regression.
- Report time as **seconds and minutes** — `142s (2.4 min)`.

### The timeout

Machine A needed 900000ms and the harness now sets that itself. The *shipped setting*,
`hirayacoder.ollama.requestTimeoutMs`, still defaults to 300000, and on Machine A that was
not enough to generate one `App.jsx`. Machine B is testing whether that is only a laptop
problem; **your data point makes it three machines.** If nothing here comes near 300s,
say so plainly.

---

## 4. What to write down

Add a **Machine C** subsection under the `bench-steps` results in `doc/MODELS.md`,
alongside A and B. **Do not overwrite either.** Losing a baseline loses the ability to say
whether anything helped the machine that needed it.

| Model | Steps | Runs | `App.jsx` wired | Imports resolving | Median | CPU/GPU |
|---|---|---|---|---|---|---|

Then answer these, in the doc, with what actually happened:

1. **What is the success rate?** Out of N runs, how many produced an `App.jsx` whose
   imports all resolve? This is the number the project does not have and cannot get
   anywhere else.
2. **Does `nosteps` differ from `steps` across repeats?** Machine B is answering this once;
   you can answer it with a distribution. If the two are indistinguishable over ten runs,
   **that is the finding** — it would mean the three bug fixes in 0.5.0 did the work and
   step sessions are optional. Report that as readily as a confirmation; it is more
   useful.
3. **Does the broken-import guard ever fire?** Sixteen unit tests cover it, built from
   Machine A's verbatim output, but **no live run has produced a bad path since it was
   added** — Machine A saw one broken run before the guard existed and three clean ones
   after, which is not enough to say the guard caused the difference. Across ten runs the
   odds are good. If you see `WARNING: … imports N file(s) that are not there` followed by
   a corrected rewrite, paste the whole sequence — that closes a gap neither A nor B
   could.
4. **Does the retry earn its place at speed?** Machine A's run 3 only succeeded because a
   *timeout* produced an empty step that the retry rescued. That will not happen here. So
   does the retry still fire for real reasons, or is it a slow-machine feature?
5. **Is `gemma4:e4b` more reliable than `qwen3.5:4b`?** It is fully GPU-resident only on
   this machine. If the wiring step is reliable on it and flaky on `qwen3.5:4b`, that is a
   recommendation rather than a curiosity.

---

## 5. What not to do

- **Do not push to `main`.** Pull requests only; CI's three-platform matrix on the PR is
  the project's only evidence about macOS and Linux.
- **Do not fix bugs mid-benchmark.** Benchmark changes and code changes never share a
  commit, and a paired run must describe one code state on both sides. The case-sensitivity
  finding in §2 is a write-up, not a patch on this branch.
- **Do not tune the prompt or the fixture to make a run pass.** A benchmark you can adjust
  until it succeeds measures nothing.
- **Do not delete a failed run's output.** The two most valuable artefacts in this whole
  investigation were a failing transcript and a wrong import path.
- **Do not average away a bimodal result.** If seven runs work and three produce broken
  imports, that is not "70%-ish quality", it is two distinct outcomes and the interesting
  question is what separates them. Report both modes.

---

## 6. If you only have time for one thing

```bash
npx mocha test/unit/brokenImports.test.js          # seconds, no model — confirms the macOS half
for i in 1 2 3 4 5; do
  node tools/bench-steps.js qwen3.5:4b steps --machine C
done
```

Five runs of one model and the five grade blocks pasted verbatim into `doc/MODELS.md`.
A success *rate* from one machine is worth more to this project right now than a single
run from three, because the one thing every machine agrees on is that this task does not
give the same answer twice.
