# Build benchmark — results

Raw output from the live-model benchmarks. `bench-build__*` and the bare
`<model>__<lang>__*` files come from `tools/bench-build.js`, the **build-a-project**
benchmark; `realworld__*` files come from `tools/bench-realworld.js`, documented further
down. Where
`bench-agent.js` asks whether a model can edit a project that already exists, this asks
whether it can build one that does not — starting from a completely empty directory.

Each run grades four things separately, in the order an agent has to get them right:

| Capability | How it is judged |
|---|---|
| **add files** | The `create` phase produces a program the harness can run |
| **run scripts** | The agent itself ran at least one command that exited 0 |
| **read files** | The agent opened a file it had written, rather than working blind |
| **modify files** | The `modify` phase adds a feature without breaking what worked |

The task is the same TODO app in **Java**, **JavaScript**, and **Python** — add, remove,
and modify items held in memory. Languages whose toolchain is missing are recorded as
`skipped`, never as a failure: Machine A having no JDK says nothing about the model.

## Nothing is graded on what the model claims

After every phase the **harness** compiles and runs the program itself and checks stdout
for a line the task asked for (`TOTAL: 2`, then `DONE: 1`). That check is `passed`. The
model's own summary is stored beside it in `claimed` and counts for nothing — a model
reporting success having written nothing is the single most common failure these runs
find, and it has to be visible rather than believed.

For the same reason the Java check compiles into its own directory rather than trusting
the agent's `build/` folder, where a stale `.class` file from an earlier phase would
otherwise pass a phase whose source never compiled.

## The app has no menu, on purpose

A TODO app normally reads commands from stdin, and benchmarking one means every run
hangs until the timeout. The task therefore asks for the same operations driven by a
fixed sequence in `main`, printing a total that can be asserted on. The interactive menu
is what a user wants; a program that terminates is what a benchmark needs.

## Running it

```bash
node tools/bench-build.js <model> --machine <A|B|C> [options]

node tools/bench-build.js gemma4:e2b --machine B                  # every installed toolchain
node tools/bench-build.js qwen3.5:4b --machine A --lang javascript
node tools/bench-build.js ornith:9b  --machine C --lang java,python --keep
```

| Flag | Meaning |
|---|---|
| `--machine <A\|B\|C>` | **Required.** Which device this is; picks the results directory |
| `--lang <list>` | `java`, `javascript`, `python`, or `all` (default) |
| `--tier <A\|B>` | Force a capability tier instead of letting discovery decide |
| `--timeout <sec>` | Per-script timeout, default 120 |
| `--notes "..."` | Free text stored in the record — put the `ollama ps` CPU/GPU split here |
| `--keep` | Leave the temp workspace on disk for inspection |
| `--out <dir>` | Results root, default `benchmarks/results` |

Requires Ollama running with the model pulled. See
[Getting started](../doc/GETTING-STARTED.md).

### Recording the CPU/GPU split

Nothing in Node can read it after the fact, so capture it **while the model is still
resident** — during or just after a run:

```bash
ollama ps
```

and pass it through, so the compiled table can report it alongside the timings:

```bash
node tools/bench-build.js gemma4:e2b --machine B --notes "63%/37% CPU/GPU, 5.9 GB resident"
```

## The real-world benchmark — `realworld__*.json`

Added in 0.9.0, and a different question from the three above. They ask whether the agent
loop works. This asks whether a **user gets a working product**.

```bash
node tools/bench-realworld.js <model> --machine <A|B|C> [options]

node tools/bench-realworld.js qwen3.5:2b  --machine B
node tools/bench-realworld.js llama3.2:1b --machine B --turns 8 --budget 40 --keep
```

| Flag | Meaning |
|---|---|
| `--machine <A\|B\|C>` | **Required.** Which device this is; picks the results directory |
| `--turns <n>` | Auto-user turns after the brief, default 10 |
| `--budget <min>` | Give up after this much wall clock, default 90 |
| `--tier <A\|B>` | Force a capability tier instead of letting discovery decide |
| `--steps` | Run with experimental step sessions on |
| `--workspace <dir>` | Work here instead of a temp directory (implies `--keep`) |
| `--notes "..."` | Free text stored in the record |

### One brief, handed over verbatim

`tools/prompts/todo-glass-app.md` is the user's message: build a React + Vite + Tailwind
TODO app, to a fixed folder structure, with add / edit / delete / toggle / clear, and a
build that has to pass. It is 98 lines and it is handed over **whole, once**.

Splitting it into steps is HirayaCoder's job. A harness that pre-split it would be
measuring a product that does not ship.

### There is an auto-user

A real session is not one message. The 0.7.0 evaluation took eleven, and every real fix
in it came from the user pasting a build error back. So after each turn the harness runs
the gates itself and writes the next message the way a user would — the actual
`npm run build` output, or the list of files still missing.

It is deliberately unhelpful about *how*. A user pastes the error; they do not name the
remedy. Anything cleverer would be the harness solving the task and then congratulating
the model for it.

### Four gates, then twelve features

The gates run from disk, in the order a build has to get them right: the project
scaffolded, the required files present, `npm install` clean, `npm run build` clean.
`dist/` is deleted before each build, so a bundle left by an earlier turn can never pass
for one that has since started failing.

Then — and this is the part that makes the benchmark worth having — the production bundle
is served from a throwaway static server, opened in a real headless Chromium over the
DevTools Protocol, and **driven**:

| Feature | What is done to it |
|---|---|
| `mounted` | did anything render at all |
| `emptyState` | is there text before any todo exists |
| `addEnter` / `addButton` | type, then Enter; type, then click the add control |
| `inputClears` | is the box empty afterwards |
| `ignoresEmpty` | submit whitespace, count unchanged |
| `liveCount` | is a remaining/completed count on screen |
| `toggleComplete` | click the checkbox, does the row change |
| `editTodo` | double-click, then every control in turn, until a field opens; save; did it persist |
| `deleteTodo` | click each control in the row until the item goes, and only that item |
| `clearCompleted` / `clearAll` | click, click again for a confirm state, then click on the empty list |

### Why it clicks blindly

Every model produces different markup, and most delete controls are a bare lucide `<svg>`
with no label. A probe that looked for a selector would be grading the model on its
accessibility attributes. So for each control it **tries the candidate buttons in turn
and keeps the one that produces the effect** — which is the user's question: is there
something here I can press to delete this item.

### The result that justifies all of it

`qwen3.5:2b` on the 0.9.0 baseline passed **every gate**: scaffold, structure, install,
build. All four green, the kind of run a CI check calls a success.

It scored **2 / 12**. `src/App.jsx` still held Vite's counter demo, and the five
components it had correctly written were imported by nothing. A build does not object to
an app that renders a counter.

### Validate the probe before trusting it

The probe was checked in both directions before any model was graded with it: **12 / 12**
against a hand-written correct app, and exactly **10 / 12** against the same app with the
delete handler and the clear-all handler sabotaged. Two probe bugs surfaced doing that,
both worth knowing about if you extend it:

- An item in inline-edit mode has moved its text into an `input.value`, where
  `innerText` cannot see it — so clicking the pencil read as a successful *delete*.
- A control list captured before a click is detached by the re-render that click causes,
  and clicking a detached node does nothing — so a working delete button reported as
  broken. Re-query every pass; never capture.

## Layout — why one file per run

```
benchmarks/results/
  A/  gemma4-e2b__all__2026-08-12T09-14-22.json
  B/  gemma4-e2b__all__2026-08-12T09-16-05.json
  C/  ...
```

Every run writes **one new file**, into **its own machine's directory**, named after the
model and the moment it started. Nothing is ever appended to a shared file and no file is
ever rewritten.

That is the whole conflict-avoidance strategy, and it is deliberate: three machines can
benchmark at the same time, on their own branches, and every one of those branches merges
into `main` cleanly, because no two of them ever touch the same path. A shared
`results.json` or a summary table updated in place would conflict on every single run.

So: **commit the JSON exactly as written, and never edit a result by hand.** Re-running a
model produces another file rather than replacing one — keeping both is the point, since
run-to-run variance on these models is real and worth seeing.

The compiled, human-readable tables are generated from these files afterwards and live in
[README.md](../README.md) and [doc/MODELS.md](../doc/MODELS.md). Those are the derived
artefacts; this directory is the source of truth.

## The image-recognition benchmark — `vision__*.json`

*New in 1.1.0.* `tools/bench-vision.js`. Where every other harness here asks whether a
model can do the work, this asks whether it can **see** — because 1.1.0 lets an attached
image reach a text-only model as a written description, and if that description is wrong
nothing downstream can tell.

That is the failure worth designing a harness around. A vision model that cannot see does
not error and does not hedge. It writes a fluent, confident paragraph about something
else, that paragraph is stored as "what is in this picture", and the coding model works
from it. So this benchmark exists to catch a describer that is **wrong while sounding
right**.

### The fixtures

Six photographs in `docs/test-images/`, each with a hand-written expectation of what is
actually in it. Written by looking at them rather than by reading the filenames:
`dog-1.jpg` is one corgi and `dog.jpg` is two retriever puppies, and grading both against
"dog" would hide a model that cannot count.

### Four axes, because they fail separately

| Axis | What it asks | How it is scored |
|---|---|---|
| **subject** | Did it name the right thing? | Any accepted synonym counts. `puppy` passes for `dog` |
| **detail** | Colour, setting, count | One word from each expectation group has to appear |
| **text** | Did it read the words printed in the image? | Only scored on the two fixtures that have any |
| **confusion** | Did it assert something the photo contradicts? | Can only be lost. A cat called a dog fails outright |

A confusion sinks the fixture whatever else it scored, and that is the distinction the
harness exists for: **vague is usable, wrong is worse than nothing**, because the user
cannot tell.

Matching is a word list, deliberately. Grading one local model's output with another
local model would make the benchmark's own reliability the thing in question, and a word
list cannot be talked into a false positive. It is word-boundary matched, which is not
pedantry: the first draft used `includes` and scored a description of a cat on a *carpet*
as having identified a car.

### The timings need `--cold`

Ollama caches the tokenized prompt, and for these requests the prompt is mostly the
image. So the second sample of a picture returns in about a second where the first took
fifteen, **and the cache survives between runs** — re-running this harness half an hour
later reported one second for everything, for a model that genuinely takes eleven.

`--cold` unloads the model between samples, which makes the `cold` column mean what it
says. Without it, treat that column as a lower bound and nothing more. None of this
touches the accuracy scores: a cached answer is the same answer.

### Running it

```bash
node tools/bench-vision.js <model> --machine <A|B|C> [options]

node tools/bench-vision.js minicpm-v4.6:latest --machine B --purpose both --repeat 2 --cold
node tools/bench-vision.js qwen3.5:2b --machine A --images cat,plane
```

| Flag | Meaning |
|---|---|
| `--machine <A\|B\|C>` | **Required.** Which device this is; picks the results directory |
| `--purpose <p>` | `answer` (default), `task`, or `both`. The two prompts in `core/imageRecognition` |
| `--images <list>` | Fixture ids, comma separated. Default: all six |
| `--repeat <n>` | Samples per image, default 1. These models are not stable across samples |
| `--cold` | Unload the model between samples. Slower, and the only way the timings mean anything |
| `--notes "..."` | Free text stored in the record |
| `--out <dir>` | Results root, default `benchmarks/results` |

A model that does not report Ollama's `vision` capability is refused **before** the run
rather than scored zero, because a zero there would look like a capability result and is
actually a configuration mistake.

### The 1.1.0 baseline

Machine B, `--purpose both --repeat 2 --cold`, so 24 graded descriptions per model.

| Model | Params | Subject | Detail | Text read | Confused | Cold |
|---|---|---|---|---|---|---|
| `minicpm-v4.6` | 752M | **24/24** | 42/48 | 4/8 | 0 | 11s |
| `qwen3.5:0.8b` | 873M | 23/24 | **46/48** | **8/8** | 0 | 13s |

Two findings worth carrying forward, both of which changed the shipped code:

- **`minicpm-v4.6` missed the same text every time.** All four of its text failures are
  `car.jpg`, whose only text is a small BMW badge on the grille. It read `cebu pacific`
  off the aeroplane, in a large clear typeface, on all four attempts. So the axis is not
  measuring "can it read" but "how small is the text", which is exactly the limitation
  [doc/IMAGE-RECOGNITION.md](../doc/IMAGE-RECOGNITION.md) now warns about.
- **`qwen3.5:0.8b` denied having vision once in twenty-four.** Sent the image, reporting
  the capability, having described the same photograph correctly one sample earlier, it
  replied *"I cannot see this image. I am an AI model designed to process text…"*. Left
  alone that paragraph becomes the description. `core/imageRecognition` now recognises
  the shape and reports a failed read instead, which is how a benchmark is supposed to
  earn its keep.

## The machines

The letters match the ones used throughout [doc/MODELS.md](../doc/MODELS.md):

| | Machine A — laptop | Machine B — desktop | Machine C — MacBook Pro |
|---|---|---|---|
| CPU | Intel Core i5-12450H | AMD Ryzen 5 3600X | Apple M4 Pro, 14-core |
| RAM | 16 GB | 32 GB | 24 GB unified |
| GPU | Intel UHD — not used | GTX 1650 Super, 4 GB | 20-core, shares the 24 GB |

Each record also stores what Node could detect on its own — CPU model, core count, total
RAM, platform — so a result stays interpretable even if these tables drift.
