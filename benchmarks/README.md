# Build benchmark — results

Raw output from `tools/bench-build.js`, the **build-a-project** benchmark. Where
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
[the requirements section of the README](../README.md#requirements).

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

## The machines

The letters match the ones used throughout [doc/MODELS.md](../doc/MODELS.md):

| | Machine A — laptop | Machine B — desktop | Machine C — MacBook Pro |
|---|---|---|---|
| CPU | Intel Core i5-12450H | AMD Ryzen 5 3600X | Apple M4 Pro, 14-core |
| RAM | 16 GB | 32 GB | 24 GB unified |
| GPU | Intel UHD — not used | GTX 1650 Super, 4 GB | 20-core, shares the 24 GB |

Each record also stores what Node could detect on its own — CPU model, core count, total
RAM, platform — so a result stays interpretable even if these tables drift.
