# HirayaCoder — Features

What the extension does, from a user's seat. For *how* it is built see
`doc/ARCHITECTURE.md`; for which model to run see `doc/MODELS.md`.

Everything here runs against your own Ollama on `127.0.0.1`. There is no cloud call, no
telemetry, and no account.

---

## Chat

`Ctrl+Shift+H` (`Cmd+Shift+H` on macOS), or **HirayaCoder: Open Chat**.

Each chat tab is its own session with its own memory file, so two tabs on two problems
do not contaminate each other. Closing a tab keeps its memory; reopening lets you resume
that session or start a new one.

### Three modes

| Mode | What it can do |
|---|---|
| **Agent** | Reads, writes, deletes, creates and removes folders, runs commands — all permission-gated. Answers conversationally when the message is conversation, without you switching anything. |
| **Plan** | Produces an ordered checklist and **cannot mutate anything** — the write, delete, and script tools are not in its tool set at all, rather than being offered and refused. Comes with a **Run this plan** button that hands it to Agent mode. |
| **Ask** | Answers questions. No loop, no tools. |

### Agent mode answers when you are talking to it

Agent mode constrains a small model's output to a grammar whose every branch is a tool
call, which is what makes a 1B model agentic at all — and which meant a greeting could
only come out as `read_file`. "hi", "what model are you", and "do you remember what we
were doing" each ended in the repeat guard.

Each message is now classified before it is routed, and a conversational one is answered
directly: one reply, no loop, no tools. The mode selector does not move and the next
message is judged on its own, so the moment you ask for work every tool is back.

The classifier is patterns, not another model call — it runs before every turn, and
spending an inference to establish that "hi" is not a refactor is a bad trade. It treats
a message as work unless there is positive evidence otherwise, and **any instruction
anywhere wins**: "hi, can you fix the bug in app.js" is work with a greeting attached.
Plan and Ask ignore it entirely, because those are you saying what you want.

### It has to have actually done it

A run that says it finished gets checked against what it produced, once:

- **Nothing changed**, on a request that asked for something to be built or edited. A
  request that only asked you to read, check, or explain is never challenged — those
  finish correctly having written nothing.
- **A function it just wrote was never implemented** — a body containing
  `// Implement the delete functionality here` and a `console.log`, and nothing else.

Once, not repeatedly. A model that cannot produce the work will not be argued into it,
and the honest "no files changed" report is better than a burned step budget.

### Thinking capacity

Low / Medium / High changes the step budget and how much session memory is recalled.

Note the deliberate asymmetry on Tier B: raising capacity buys **more recalled memory
and fresher context, not more steps**. Small models do not get better with a longer
leash; they get better with a shorter, cleaner context.

### What you see while it works

- A **Filipino thinking indicator** — rotating Taglish lines, pulsing dots, an elapsed
  counter, and honest long-wait variants after 90 seconds, because a two-minute CPU
  inference should not look like a hang.
- A **step trace** — thought → action → observation as compact chips, collapsed by
  default so a long session does not bury the answer.
- A **TODO checklist** that fills in as work completes, item by item.
- A **change summary** with per-file line counts, and **Review diff** on every write
  confirmation, which opens VS Code's own diff viewer rather than a reimplementation.

---

## Editor integration

Select code, right-click → **HirayaCoder**:

- **Explain Selection**
- **Refactor Selection**
- **Document Selection**
- **Fix Selection**
- **Generate Tests for This File**

Each opens a scoped chat session rather than running its own agent, so the permission
gate and the audit log see every action no matter where it started.

**Inline completion** is available and **off by default** (`inlineCompletion.enabled`).
It was off because CPU inference is too slow to be pleasant; on a machine where small
models are GPU-resident this is worth re-trying.

---

## Context

- **`+` attaches reference files.** They are scanned for secrets and redacted *at
  ingestion*, before truncation, so a credential cannot survive by sitting past the cut
  and reappearing when the budget changes.
- **Images** for vision-capable models — magic-number checked, 4 MB cap, first message
  only. The attach button is disabled for models without the capability, since such a
  model does not error on an image, it ignores it and answers from the text.
- **Session memory** persists across turns as plain text you can read and clear
  (**Show Session Memory**, **Clear Session Memory**). Notes are composed by the
  extension from what actually happened, not written by the model, and a failed write or
  delete is deliberately *not* remembered.
- **The conversation itself** is carried into the prompt — what was actually said, not
  just a distilled note about what was done. It outranks session memory when the budget
  cannot fit both, since the notes are a compression of the same material. This is what
  makes "do it the way we discussed" and "the file I mentioned earlier" work at all.
- **What it changed, and what it changed it from.** Every write is recorded to
  `.hirayacoder/history.jsonl` as a bounded diff — **Show File History** renders them
  newest-first as a diff document. A `ChangeSet` used to hold both versions of a file
  for exactly as long as the turn lasted, so "what did it do to this file two turns ago"
  had no answer anywhere.

  Diffs rather than snapshots, deliberately: storing both versions of every file would
  duplicate the workspace on each write, and in a git repo it would duplicate git. A
  large rewrite is recorded as a truncated diff and is not reversible from this file —
  git is the tool for that, and this is for seeing what happened without leaving the
  editor.

  The agent gets the short version — paths and line counts, not the diffs — under the
  heading *"files you have already changed in this session — do not redo this work"*.
  That is the half that fixes behaviour rather than reporting on it: a model asked to
  modify a file it edited three turns ago has no idea it did so, and re-does or undoes
  its own work. Observed exactly that way, more than once.
- **Facts about the workspace** persist across *every* session in it, not just the one
  that learned them: a toolchain that is missing, a decision you made, what the project
  is meant to produce. They are typed and labelled in the prompt, and ordered so your
  decision outranks anything the agent observed.

  Nothing here comes from a model call — a fact is read out of what a program printed,
  or it is not recorded, because a wrong one persists and is stated to every later turn
  as settled. In practice this is mostly about missing toolchains, recognised in all
  three of the ways one announces itself:

  ```
  macOS    The operation couldn't be completed. Unable to locate a Java Runtime.
  Linux    javac: command not found
  Windows  'javac' is not recognized as an internal or external command
  ```

  The macOS case is the one no `PATH` check can catch — Apple ships a `javac` stub, so
  the program really is there and really does fail. **Clear Session Memory** gains an
  entry for these, kept separate because they have a different scope; use it after
  installing something the agent recorded as absent.

---

## Multi-part requests

Models that report Ollama's `thinking` capability and clear the 2B floor split a
multi-part request into a TODO list and work it **one item at a time**, each with its
own context and its own full step budget.

The list is held by the extension, not the model. The model proposes items; it never
marks its own work complete. Completion is judged from evidence — did files change, did
any step fail, how did the loop stop — with three outcomes:

- **done** — finished cleanly.
- **done, with a caveat** — the files changed and nothing failed, but the model never
  closed the item off. Counted as complete, flagged so you look at the diff.
- **not completed** — including when the model *claimed* success but nothing changed and
  something failed.

Non-deliverable items ("Read the file", "Save changes", invented verification steps) are
filtered out, and a request that turns out to be a single change runs as one pass
instead of several.

### Step sessions (experimental)

Off by default. Toggle it per chat from **Steps** in the header, or set
`hirayacoder.experimental.stepSessions`.

With it on, each item is run as a briefed step rather than as the whole request with one
item highlighted. Three things change:

- **The step is told what the earlier steps produced**, not merely that they finished.
  "Item 3 is done" is not the fact item 6 needs; "item 3 wrote `src/hooks/useTodos.js`"
  is. The original request is still included, explicitly as background.
- **The step is checked against its own text before it may close.** What changed on disk
  is compared with the files the step named, so an item about `App.jsx` that edited
  `vite.config.js` is reported as not done rather than as done.
- **A step that fails gets one retry, and then the run stops.** The retry is given the
  diagnosis, so it differs from the first attempt. If it fails too, the run stops and
  prints what went wrong, which steps it did not attempt, and what to try instead —
  rather than running the rest against a project that does not have what they need.

A step also counts as failed when the file it wrote imports something that is not there.
That check runs on every write regardless of the toggle: `write_file` resolves the
relative imports of what it just wrote and, when one reaches nothing, says so and gives
the path that would work. The file is still written — the content is usually right and
only the route is wrong, and discarding it would cost more than it saves.

**Leave it off unless you have a reason.** It was measured on three machines after it
shipped, and the result did not go the way the feature's author expected: across 33 runs
of the wiring benchmark, step sessions made **no measurable difference to correctness** —
Machine C saw 8/10 against 7/10 without, Machine B saw the two arms disagree in the
opposite direction, and neither gap is significant. What *is* significant is the cost:
Machine B's `nosteps` arm was faster in **all eight pairs**, about **17% less wall clock**,
which is exactly what an extra planning call plus one loop per item should cost.

The three bug fixes shipped alongside it in 0.5.0 are what fixed the original failure. Step
sessions are worth turning on when you want the stricter reporting — a step checked against
its own text, and a run that stops and explains itself instead of cascading — not because
they make the model more likely to succeed.

### Memory recalled by subject

Session notes are normally recalled by recency. In step mode each step instead recalls
the notes that bear on *it* — matched on the files and commands they name, path-aware, so
a step saying `useTodos` finds a note saying `src/hooks/useTodos.js` — and fills whatever
is left of the window by recency. It is never worse than plain recency, and much better
for a step whose dependency was established six items ago.

---

## When it feels slow, or stops answering

A local model on a laptop is slow in several different ways, and they need different
responses. All of this is recorded locally in `.hirayacoder/outcomes.jsonl` and never
leaves the machine — durations and states are numbers and enums, so the file's existing
rule holds: no paths, no commands, no content.

**Timing.** Every turn logs how long it took and how much of that was spent waiting on
Ollama, to the output channel as it happens and to the ledger for later:

```
Turn finished in 94.2s (96% waiting on the model) — done, 4 step(s).
```

The split is the useful part. A four-minute turn is a different problem depending on
whether the model was thinking or a script was hanging, and 96% says which. Individual
steps are timed too, including any wait on a confirmation dialog — a session that looks
slow because a prompt sat unanswered is not a slow model.

**Up, down, or wedged.** Three states, because two of them need opposite actions from
you:

| State | What it means | What to do |
|---|---|---|
| `down` | Nothing is listening on the endpoint | Start it — `ollama serve` |
| `unresponsive` | It accepted the connection and then didn't answer, twice running | Restart it; it's wedged |
| `up`, request failed | The server answered with an error | Nothing — the request was wrong, not the server |

The last row is why this isn't a boolean. A 404 for a model that isn't pulled would
otherwise be reported as an outage and send you to restart something that is working.
And one timeout is never enough to call a server wedged: on CPU inference a large model
loading into memory legitimately blows a deadline.

Transitions are recorded, not individual requests, so a healthy server costs nothing and
a flapping one reads as a short list of flips with timestamps. You get a notification
only when entering a state you can act on. **Show Status** has the numbers at a glance —
last, average, and slowest call, plus any current failure streak.

---

## Safety

The parts that decide what the agent is *allowed* to do.

- **Two independent permission toggles**, both off by default: Auto Edit, and Auto
  Approve Running Scripts. Off means every write, delete, and command asks first.
- **Deletes always confirm, even under Auto Edit.** A wrong write is visible in a diff
  and recoverable from the change set; a wrong delete is neither. This is not
  theoretical — a 1B model once deleted the file it had been asked to edit while
  reporting an unrelated thought.
- **Folder deletes always confirm, in every mode, with no setting that turns it off.**
  They are also refused for a folder that still has anything in it unless the call
  explicitly asks to recurse, and refused outright past 100 items with a note to do it
  yourself. The distance between `src/main/java` and `src` is one token of model output,
  and a subtree is the one thing the change set cannot put back.
- **Some commands always ask**, even in auto-approve mode: `git push`, `npm publish`,
  `ollama pull`, and anything else that publishes code or reaches the network.
  Auto-approve means *routine local work*.
- **Workspace confinement.** Every path is canonicalised and checked, including through
  symlinks and the parent directory of a file being created. `.git` and `.hirayacoder`
  are write-protected so the agent cannot rewrite its own audit log or memory.
- **Allow-listed commands only**, run with argument arrays and no shell. Shell operators
  are refused outright rather than passed through as literal text.
- **Secret redaction** on everything sent to the model: file reads, search results,
  command output, your selection, and attached files.
- **Write guards.** Seven of them, each named after a real failure a real model
  produced: truncated content, unclosed brackets, a file commented out wholesale,
  deleted exports, a silently switched module system, an export pointing at a symbol
  that no longer exists, and a deleted implementation behind intact exports. A refusal
  explains itself so the model can correct and retry.
- **An append-only audit log** of every action, decision, and permission mode, at
  `.hirayacoder/audit.log` (**Show Audit Log**).
- **Honest summaries.** What actually failed is appended to the model's own account from
  the step record, so a claim that a declined delete succeeded is contradicted in place.

---

## Adaptation: the extension learns, the model doesn't

HirayaCoder owns no weights — the model lives in Ollama's process — so it adapts in
context rather than in parameters. Every session's outcomes are recorded to
`.hirayacoder/outcomes.jsonl`: which model, which tier, which action, which guard
refused it, how the session ended, whether anything actually changed. The signal is
taken from what the guards reported, never from the model's account of itself.

When one model trips the same guard three times in a workspace, the matching correction
is promoted into that model's prompt preamble. A model that keeps dropping exports
starts its next session already being told to keep them. The model does not learn; the
extension learns what to tell it.

Three properties hold it in place:

- **It cannot touch safety.** Adaptation tunes what a model is told, never what it is
  allowed to do. Permissions, path confinement, and the allow-list take no input from
  the ledger, and a repeatedly declined action can never earn a hint — a system that can
  learn "the user approves every time, so stop asking" is a data-loss incident with a
  progress bar.
- **It cannot write your project into a prompt.** The ledger stores counts and error
  codes, never paths, commands, or file contents. Hints are constants in the source; the
  ledger only selects among them.
- **It is visible and disposable.** **Show Learned Adaptation** prints every model's
  record and the hints currently in force; **Reset Learned Adaptation** discards all of
  it. `hirayacoder.adaptation.enabled` turns off recording and hinting together.

---

## Models

**Select Model** lists what you have installed with a tier badge; **Refresh Installed
Models** re-reads them; **Pull a Model…** downloads one with progress.

Every model runs the full agent loop. The tier only changes how actions are produced:

- **Agentic (Tier A)** — native tool calling, for models above 3B that support it.
- **Lite (Tier B)** — one schema-constrained JSON action per turn, for models at or
  below 3B or without tool support.

Tier B is not a degraded mode; it is what makes a 1B model usable at all. Measured on
`llama3.2:1b`, schema-constrained output produced a valid action **6 times out of 6**
where bare JSON mode managed **0 out of 6**.

---

## Settings

| Setting | Default | Notes |
|---|---|---|
| `hirayacoder.ollama.endpoint` | `http://127.0.0.1:11434` | Loopback only. A remote address is rejected at construction, before any socket opens. |
| `hirayacoder.ollama.requestTimeoutMs` | `300000` | CPU inference is slow; the default is deliberately generous. |
| `hirayacoder.model.selected` | *(first installed)* | |
| `hirayacoder.model.liteTierMaxParams` | `3` | At or below this, Tier B. |
| `hirayacoder.model.tierOverrides` | `{}` | Force a tier per model. |
| `hirayacoder.model.todoMinParams` | `2` | Floor for TODO lists, alongside the `thinking` capability. |
| `hirayacoder.model.recommendAboveParams` | `7` | One-time suggestion if a larger model is installed. |
| `hirayacoder.thinkingCapacity` | `medium` | Step budget and memory recall depth. |
| `hirayacoder.mode` | `agent` | Default for new messages. |
| `hirayacoder.permissions.autoEdit` | `false` | |
| `hirayacoder.permissions.alwaysConfirmDeletes` | `true` | Applies even when Auto Edit is on. |
| `hirayacoder.permissions.autoApproveScripts` | `false` | Enabling requires a separate confirmation. |
| `hirayacoder.scripts.allowedBinaries` | `[]` | Extends the built-in allow-list. |
| `hirayacoder.scripts.timeoutMs` | `120000` | |
| `hirayacoder.security.protectedPaths` | `[".git", ".hirayacoder"]` | |
| `hirayacoder.experimental.stepSessions` | `false` | Run each TODO item as a briefed, verified step. See above. |
| `hirayacoder.inlineCompletion.enabled` | `false` | |
| `hirayacoder.statusBar.enabled` | `true` | Connection, model, tier. |
| `hirayacoder.logLevel` | `info` | **Show Logs** opens the channel. Local only. |

---

## Requirements

- VS Code 1.85 or newer, Node 18+.
- [Ollama](https://ollama.com) running locally with at least one model pulled.
- A **trusted** workspace folder. HirayaCoder reads, writes, and deletes files and runs
  permission-gated commands, so it declares `untrustedWorkspaces: false` and does
  nothing useful without a folder open — without a workspace root there is nothing to
  confine the agent to, so every tool refuses.
