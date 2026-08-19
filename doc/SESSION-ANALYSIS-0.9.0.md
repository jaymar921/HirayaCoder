# What the 0.9.0 evaluation showed

Three models were given the same brief on Machine B — build a React + Vite + Tailwind
TODO app from scratch, to a fixed folder structure, with every feature working — and run
to whatever end they reached. None of them delivered a working app.

The difference from the 0.7.0 evaluation is that this one is **measured in a browser**.
`tools/bench-realworld.js` runs the gates from disk after every turn, and where the build
passes it serves the production bundle and drives it in a real headless Chromium,
clicking every control the brief asked for. A build that exits 0 over an app whose delete
button is wired to nothing scores exactly what that app is worth.

Everything below is counted from `benchmarks/results/B/realworld__*.json` rather than
remembered from watching the runs.

---

## The headline numbers

Baseline, at commit `957e6ac`, before any of the 0.9.0 agent work:

| | `qwen3.5:0.8b` | `llama3.2:1b` | `qwen3.5:2b` |
|---|---|---|---|
| Wall clock | 10.2 min | 11.3 min | 53.8 min |
| Turns used | 11 | 11 | 2 |
| Scaffold created | **no** | partial | yes |
| Required files present | no | no | **yes** |
| `npm install` clean | no | no | **yes** |
| `npm run build` clean | no | no | **yes** |
| Features working | **0 / 12** | **0 / 12** | **2 / 12** |
| Delivered a working app | no | no | no |

Three different failures, and only one of them is about the model's ability to write
code.

---

## 1. `llama3.2:1b` — eleven turns, every one unparseable

The action ledger for the whole evaluation is four actions. Every turn ended
`stopReason: "unparseable"`.

That reads as a model too small to be an agent. It is not what happened. Asked the same
question three ways, outside the loop:

| How it was asked | What came back |
|---|---|
| Constrained to the action schema | `{"thought":"Toggle Todo Item Complete","action":"done","summary":"Toggle Todo Item Complete"}` |
| `format: "json"` | `{}` |
| In plain words, "reply with the file in a code block" | a complete, correct, exported React component |

The model can write the component. It cannot express the *decision* to write it through
a JSON action protocol. And schema-constrained decoding makes this **worse rather than
better**: `done` is the cheapest object that satisfies the grammar, so a model with no
budget for the harder answer emits the easy one that ends the session.

Measured across all three models, asking in plain words produced a complete file with its
exports intact on **every single attempt**:

| Model | `TodoItem.jsx` | `useTodos.js` |
|---|---|---|
| `llama3.2:1b` | 827 chars, 2s | 1,558 chars, 4s |
| `qwen3.5:0.8b` | 3,426 chars, 14s | 1,489 chars, 5s |
| `qwen3.5:2b` | 3,406 chars, 73s | 1,334 chars, 19s |

**At this size the protocol is the bottleneck, not the coding.** That is the finding the
release is built on, and it is the one that was hiding behind eleven identical
`unparseable` stops.

---

## 2. `qwen3.5:0.8b` — nine listings and three writes

```
list_files     9   (75% of all steps)
write_file     3
```

Two sessions ended `repeating`, nine ended `done` having changed nothing. The scaffold
gate never passed: `todo-glass-app/package.json` did not exist at the end of eleven
turns.

This is the 0.7.0 failure with the sharp edge filed off. 0.8.0's working set and recon
substitution stopped the run being *killed* at step two — the run now survives — but
surviving is not progress. The model spends its turns looking at the project because the
whole 98-line brief is in its prompt every turn and nothing in it tells the model which
sentence to act on.

`goalReminder` restates the request at the point of decision, capped at 240 characters.
On this brief those 240 characters are:

> You are an autonomous coding agent. Build a complete, working **TODO application** from
> scratch. Follow every instruction below in order. Do not stop until the app builds
> successfully and all features are verified working. ### 1. Tech Stack - React…

Which is the preamble. The work is in the four thousand characters after it.

---

## 3. `qwen3.5:2b` — every gate green, and it shipped the demo

The instructive row. In 53.8 minutes it scaffolded the project, wrote all five
components and the `useTodos` hook, installed cleanly, and **built cleanly**. Every gate
a normal CI check would run came back green.

The app scored **2 / 12**. The probe's report on the first interaction it tried:

> `addEnter` — no visible text input on the page

`src/App.jsx`, at the end of the run:

```jsx
import reactLogo from './assets/react.svg'
…
      <h1>Get started</h1>
      <p>Edit <code>src/App.jsx</code> and save to test <code>HMR</code></p>
      <button className="counter" onClick={() => setCount((count) => count + 1)}>
        Count is {count}
      </button>
```

Vite's scaffolded counter demo, untouched. The five components it wrote are on disk,
correct, and imported by nothing.

Two things made this invisible until now:

- **The structure gate passes.** `src/App.jsx` exists — the scaffold created it. Every
  file-presence check the brief asks for is satisfied by a project that does nothing.
- **The build passes.** Unused components are not an error. Nothing in a Vite build
  objects to an app that renders a counter.

Only clicking the buttons finds it, which is why the harness now does.

It is also the exact failure `doc/SESSION-ANALYSIS-0.7.0.md` recorded across five models
eight months earlier: *"Across five models, `App.jsx` ended every run holding Vite's
scaffolded counter demo."* 0.8.0 gave the agent a record of what it had written. It did
not give it a reason to go back to a file it never wrote.

---

## What this implied for 0.9.0

In priority order, with the evidence each rests on:

1. **Stop asking the smallest models to choose an action.** Eleven of eleven turns
   unparseable, against a 100% success rate at "write me this file". The decision — the
   action and the path — can be made off the model, from the request.
2. **Split the request outside the model.** `planTodos` needs `thinking` and 2B
   parameters; below that the whole brief goes into every prompt. The brief's own
   headings are a decomposition that needs no inference to read.
3. **A file the request named, with a purpose attached, is the unit of work.** The tree
   in section 3 gives twelve full paths and, for six of them, a comment saying what the
   file is for. `App.jsx` is one of the six.
4. **Grade in a browser, always.** Four green gates and a counter demo is not an
   unusual outcome, it was the *best* outcome in this sweep.
