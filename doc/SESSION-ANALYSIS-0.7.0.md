# What the 0.7.0 live sessions showed

Two models were given the same brief on Machine B — build a React + Vite + Tailwind TODO
app from scratch, to a fixed folder structure — and run to whatever end they reached.
`qwen3.5:4b` finished it. `qwen3.5:0.8b` never wrote a single file.

The logs are in `.ignore/1.todo-app-0.7.0-qwen3.5-4b` and
`.ignore/2.todo-app-0.7.0-qwen3.5-0.8b`: `outcomes.jsonl` for the step and session
ledger, `audit.log` for every tool call with its path, `transcripts/session1.json` for
what the user actually saw.

This document is the evidence behind the 0.8.0 work items. Everything below is counted
from those files rather than remembered from watching the runs.

---

## The headline numbers

| | `qwen3.5:4b` (Tier A) | `qwen3.5:0.8b` (Tier B) |
|---|---|---|
| Sessions | 11 | 7 |
| Steps taken | 126 | 22 |
| `write_file` calls | 21 | **0** |
| Wall clock | 88.2 min | 1.9 min |
| Share of wall clock spent in inference | **97%** | 99% |
| Sessions ending `repeating` | 0 | **5 of 7** |
| Task completed | yes | no |

The two failures are different in kind, and neither is a failure of the model's coding
ability. The 4B model wrote correct code slowly. The 0.8B model was stopped before it
was ever allowed to write any.

---

## 1. The 0.8B model: killed by the repeat guard, every time

Five of seven sessions ended with `stopReason: "repeating"`. Four of those five ended
at **exactly two steps**. The action ledger for the whole evaluation:

```
list_files    12   (55% of all steps)
run_script     7
read_file      3
write_file     0
```

The shape is the same every session. The model calls `list_files`, gets the listing,
calls `list_files` again with the same arguments, gets the same listing, calls it a
third time — and `reactLoop`'s repeat guard (`REPEAT_LIMIT = 2`) ends the entire
session. The user saw this seven times:

> I stopped because I kept repeating the same step (list_files). Before that I completed
> 2 step(s) — check the changes above before relying on them.

### Why the existing anti-repetition machinery did not catch it

It did fire. `nextStepHint` has a case for exactly this
([reactLoop.js:230](../app/agent/reactLoop.js#L230)):

> You now know what is in the project. Open the file you need with `read_file`.

and a stronger one on the second occurrence ([reactLoop.js:216](../app/agent/reactLoop.js#L216)):

> You have already done list_files and have the result above. Do NOT do it again.

The model was told, in plain English, twice, and did it again anyway. That is the
finding. **At 0.8B, a hint is not a control.** Everything in the loop that prevents
repetition is currently written as text addressed to the model's judgement, and this
model has no budget for judgement — it has 2,000 prompt tokens, no plan, no checklist,
and a fresh context every turn.

### And the punishment is aimed at the wrong thing

Repeating `list_files` is not a dangerous act. It is a read-only call on a directory,
costing 5 milliseconds of tool time. The response to it is to **end the user's whole
session** — the most destructive outcome available — while a genuinely expensive
mistake (a wrong `npm install`) gets a diagnosis and a retry.

The guard was designed against a model burning its budget in a loop. Against a model
that is merely disoriented, it converts confusion into termination.

### Compounding: this tier gets none of the scaffolding

At 0.87B the model falls below two thresholds at once
([modelCapability.js:211](../app/core/modelCapability.js#L211),
[modelCapability.js:244](../app/core/modelCapability.js#L244)):

- `canPlanTodos` requires ≥ 2B → **no checklist, no per-item `stepBrief`**
- Tier B budgets set `planning: 'none'` → **no plan either**

So the only structure this model ever receives is one `goalReminder` line and one
`nextStepHint` line appended to a 2,000-token prompt. `stepBrief` — the module whose
entire job is to tell a model what it already did, what exists, and what to do next —
is unreachable from this tier. It is built and tested and the model that needs it most
never sees it.

---

## 2. The 4B model: correct, and slow for a reason that is not the GPU

88.2 minutes of wall clock, of which **85.7 minutes were inference** — 97%. Tool
execution across all 126 steps totalled about 152 seconds, and 150 of those were
`run_script` (npm doing real work). The remaining six tool types cost **1.8 seconds
combined**. All 73 `read_file` steps together took 1.2 seconds.

So the run was not slow because of disk, or the extension, or the GPU. It was slow
because it took **126 model round-trips at roughly 42 seconds each**, and most of those
round-trips did nothing but move a file the model had already seen back into its context.

### 90% of reads were of a file the agent had already read

From `audit.log`: **263 `read_file` entries across 25 distinct paths.**

| Times read | Path |
|---|---|
| 57 | `.` |
| 28 | `todo-glass-app/src/App.jsx` |
| 17 | `todo-glass-app/src/components/ClearButton.jsx` |
| 16 | `todo-glass-app/src/components/TodoInput.jsx` |
| 15 | `todo-glass-app/src/hooks/useTodos.js` |
| 15 | `todo-glass-app/src/components/TodoList.jsx` |
| 14 | `todo-glass-app/src/App.css` |
| 13 | `todo-glass-app/src/assets/hero.png` |
| 13 | `todo-glass-app/src/assets/react.svg` |
| 13 | `todo-glass-app/src/assets/vite.svg` |
| 13 | `todo-glass-app/src/components/TodoItem.jsx` |
| 12 | `todo-glass-app/src/components/TodoStats.jsx` |

`App.jsx` was read 28 times and written 4 times. A binary PNG was read into the prompt
13 times. At the step level, **73 of 126 steps (58%) were `read_file`**, against 21
writes.

Nothing in the loop tracks that a file has already been read. `nextStepHint` says "do
not read it again" after a successful read, and — as with the 0.8B case — that is a
sentence, not a mechanism. There is no cache, no per-session file table, and no way for
the agent to be handed content it already has without spending a step to ask for it.

### What that costs, bounded honestly

The audit figure (263 reads / 25 paths) includes reads the extension performs itself
while building context, so it is not a clean count of wasted *steps*. The clean figure
is the step ledger: 73 `read_file` steps for 25 distinct files. Even assuming every file
legitimately needed re-reading once after each of the 21 writes, that leaves roughly
**25–30 steps of pure redundancy — 18–24 minutes of this session's 88.**

---

## 3. Casual messages start real work

Two instances, one per model, and they have the same root cause.

**4B, final exchange.** The user wrote:

> It all works now, thank you

The agent built a checklist and began re-fixing bugs it had already fixed:

> 1. Fix the `onToggleComplete` function error in TodoItem.jsx. — not completed (stopped: error)
> 2. Resolve the issue where the Clear all button does not clear the todo list. — not attempted (the session was cancelled)

The user aborted it. Note what the checklist contains: the *previous* turn's items,
regenerated. A thank-you did not merely start a run — it started a run that would have
undone finished work.

**0.8B, second message.** The user wrote `hi`. The model replied with a complete
`App.jsx` in a code fence — 1,900 characters of inline-styled React, no Tailwind, no
components, contradicting the folder structure it had been given. Nothing was written to
disk (`changed: false`), so the user was shown a plausible finished app that did not
exist anywhere.

### Why `intentRouter` let the compliment through

Tracing `"It all works now, thank you"` through
[classify()](../app/core/intentRouter.js#L465):

- `MUTATING_VERB` — no match
- `ABOUT_THE_PROGRESS`, `ABOUT_THE_CONVERSATION`, `ABOUT_THE_ASSISTANT` — no match
- `WORK_VERB` — no match
- `NAMES_A_FILE` — no match
- `isPurelySocial` — **fails**: `it`, `all`, `thank`, `you` are in `SOCIAL_WORDS`, but
  `works` and `now` are not
- `isGreetingWithName` — fails, six words
- falls through to the default: **`task`, "no conversational signal"**

The module is not missing two words. It is missing a *category*: **the user reporting
that the work succeeded.** "it works now", "that fixed it", "all good", "we're done" —
none are greetings, none contain a verb, none name a file. And the fix genuinely cannot
be to add `works` to the social vocabulary, because "the delete button no longer works"
is a bug report and must stay a task.

`hi` is a different bug with the same consequence: it classified correctly as `chat`,
but the conversational path had the whole coding task in its context and answered by
writing the app in prose.

---

## 4. What worked, and should not be disturbed

Worth recording, because three of these are load-bearing and easy to break while fixing
the above.

- **Error diagnosis earned its place.** `NO_PACKAGE_JSON` and
  `DEPENDENCIES_NOT_INSTALLED` both fired with the specific remedy attached ("Run
  `npm install` with `"cwd": "todo-glass-app"` first"). The 4B model acted on them
  correctly.
- **`cwd` in the repeat key was right.** `npm install` at the root and inside
  `todo-glass-app` are correctly distinct actions; the 4B session depended on that.
- **The user's own error paste is the highest-value input in the run.** Every one of the
  4B session's real fixes came from the user pasting a console error. The agent resolved
  the postcss plugin move, the missing autoprefixer, four missing default exports, and
  two prop-name mismatches — each within one or two steps of being shown the message.
- **`clarification` never blocked a session.** No spurious questions in 18 sessions.

And one thing that worked and *should* be disturbed: at message 14 the user had to say

> you have not modified the components, you just read them. Can you fix the exports of each components?

The agent had announced the fix ("I need to add `export default` statements to the
remaining 4 components") and then stopped, having only read them. `completionCheck`
covers "claimed done with an empty change set", but not "announced an intention and
ended the turn". That is a third failure mode and it is adjacent to the read-loop
problem: the model spent its step budget reading and had none left to write.

---

## What this implies for 0.8.0

In priority order, with the evidence each rests on:

1. **Serve repeated reads from a session file table instead of a model round-trip.**
   58% of steps, 90% redundancy, 97% inference-bound. This is the single largest cost in
   the log and it does not need the model's cooperation to fix.
2. **Make anti-repetition a mechanism rather than a sentence,** and stop ending sessions
   over read-only recon. 5 of 7 sessions on the small model died here at step 2.
3. **Give Tier B the scaffolding it is currently excluded from** — the reminder layer of
   `stepBrief`, restated every turn, without requiring a 2B checklist.
4. **Add an outcome-report category to `intentRouter`,** so "it works now, thanks" ends a
   task rather than starting one.
5. **Show the user what the agent is doing while it does it** — at 42 seconds a step,
   the panel is silent for minutes at a time, and the user's only signal that a run went
   wrong is the summary at the end.
