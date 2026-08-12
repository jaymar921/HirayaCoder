# Self-Optimization — design note

Being built in **0.2.0**. The first two slices — the outcome ledger and earned
corrective hints — have shipped; see [Status](#status) at the bottom for what is in the
code and what is not. This records what was asked for, what this project can actually
do, and what was decided, so the reasoning does not have to be rebuilt later.

---

## What was asked for

A self-optimizing algorithm for a ≈1B-parameter local coder: contextual replay buffer,
LoRA/adapter weight updates, gradient-free optimization, meta-learning hooks, episodic
memory, semantic compression, attention over external memory, parameter-efficient
fine-tuning, sparse activation, quantization-aware updates, contextual reward signals,
uncertainty estimation, self-distillation, adaptive context windowing.

## The constraint that decides most of it

**HirayaCoder does not own any weights.** It is an HTTP client: `core/ollamaClient.js`
talks to `/api/tags`, `/api/show`, `/api/chat`, `/api/generate`, `/api/pull`, and
`/api/version`, with `"dependencies": {}`. The model lives in Ollama's process. There is
no tensor, no gradient, no layer and no training loop in this repository, and no API to
reach one.

| Asked for | Verdict |
|---|---|
| Contextual replay buffer | Feasible — partly exists (`memoryStore`, `contextBuilder`) |
| Semantic compression | **Already built** — `contextTranslator` composes notes rather than asking the model to summarize |
| Episodic memory in `.hirayacoder/memory/` | **Already built**, with injection neutralisation and subject-superseding |
| Adaptive context windowing | Feasible — `utils/tokenBudget.js` and the tier budget matrix are the levers |
| Contextual reward signals | Feasible, and the richest unused asset in the project |
| Uncertainty estimation | Feasible — Ollama 0.32.9 returns per-token `logprobs` with `top_logprobs` (verified on this machine) |
| Meta-learning / few-shot hooks | Feasible as exemplar and hint selection in the prompt |
| Attention over external memory | **Blocked** — requires inference-engine internals |
| LoRA / adapters / dynamic weight adjustment | **Blocked** — requires a training stack |
| Gradient-free weight optimization | **Blocked** — same |
| Sparse activation | **Blocked** — requires engine internals |
| Quantization-aware updates | **Blocked** — requires a training stack |
| Self-distillation across layers | **Blocked** — hidden states are not exposed |

Everything blocked would require a second program: a Python/PEFT training pipeline
producing a GGUF adapter, loaded through an Ollama Modelfile `ADAPTER` line. Buildable,
but it ends "zero dependencies, runs anywhere Node runs".

## Why weight-level adaptation was not chosen

Measured, not assumed. A 17-run sweep across 8 models produced these failures:

1. **Plausible-but-wrong logic** — `qwen3.5:2b` wrote `!isNaN(cleanName)`, so
   `greet("World")` returns `"Hello there"`.
2. **Destructive rewrites** — exports deleted, implementation deleted, CommonJS silently
   converted to ESM.
3. **Claiming success having done nothing** — `llama3.2:latest`, twice.
4. **Format failure** — one tool call written as prose.

Fine-tuning is good at (4) and does nothing for (1)–(3), which are reasoning-capacity
failures: no adapter teaches a 1B model that `isNaN` is the wrong test. And the cheap
form of the (4) win is already banked — `MODELS.md` records schema-constrained decoding
taking `llama3.2:1b` from **0/6 to 6/6**.

So the adaptation happens in **context and configuration**, not in weights.

---

## The design: earned adaptation

Every session already produces an honest, local, evidence-based record — guard refusals
with error codes, `judgeItem` verdicts, stop reasons, change sets, declined
confirmations. Nothing consumes it. That is the gap.

### 1. Outcome ledger (first slice) — shipped

Append-only `.hirayacoder/outcomes.jsonl` (`core/outcomeLedger.js`). The
serialized-append discipline, rotation, bounded fields, and tolerant reads that
`auditLog` had were lifted into `utils/jsonlLog.js` and are now shared by both, so
there is one implementation of "this file cannot be torn or lost" rather than two.

Two records: one per step (model, tier, thinking capacity, mode, action, guard error
code, whether the user declined) and one per message (stop reason, step count, whether
the change set grew).

The reward signal is taken from **evidence, never from the model's self-report** — the
principle `judgeItem` already enforces, for the same reason.

One thing the design gained on contact with the code: **no free text, ever.** The record
shape is an allow-list of enum-shaped fields, so no path, command, or summary can reach
the file even if a later caller passes one. The audit log next door already answers
"what was touched"; the ledger only has to answer "how often does this model trip this
guard". Keeping workspace content out of it is what makes it safe for the learning layer
to read back into a prompt.

### 2. Earned corrective hints — shipped

`reactLoop` carries per-error corrective hints, hardcoded and identical for every model,
and reactive: the guard fires, the hint is shown, the next session starts over knowing
nothing. `agent/earnedHints.js` closes that loop. Once a *specific model* trips a
*specific guard* three times in this workspace, the matching correction is promoted into
that model's prompt preamble. `llama3.2:1b` repeatedly dropping exports now starts its
next session already being told to keep them.

This is the meta-learning idea implemented where it can actually run: the model does not
learn, the extension learns what to tell it. Measured by guard-trip rate before and
after, using `tools/bench-agent.js`.

Three decisions worth keeping:

- **Counts select, they never compose.** Every hint is a constant in `earnedHints`; the
  ledger only decides which ones apply. `promptRouter` re-checks each hint against the
  catalogue before rendering it, so a corrupted or hand-edited ledger can change which
  hint appears and can never introduce a sentence of its own. That is why none of this
  needs the neutralisation `memoryStore` entries require.
- **Three trips, three hints, most-tripped first.** One trip is an accident, two a
  coincidence. And the preamble competes with the task for a Tier B budget of ~1800
  tokens, so a model that has struggled with everything must not be made worse at
  everything.
- **Read once, before the first turn.** A session does not adapt to itself mid-run; the
  evidence it produces counts towards the next message. A prompt that shifts underneath
  a task in progress is one more variable when a run goes wrong.

Visible and disposable, per the rule below: **Show Learned Adaptation** prints each
model's record and the hints in force, **Reset Learned Adaptation** discards the lot, and
`hirayacoder.adaptation.enabled` turns off recording and hinting together — a user who
declines the feature should not find the file in their project either.

### 3. Later slices, in the order they earned their place

- **Per-model calibration** — automate the manual sweep into a command that measures a
  model on the fixture tasks and writes a profile (tier, step budget, prompt token
  target, TODO on/off).
- **Self-consistency on risky writes** — sample a write twice; if the two disagree
  materially, do not auto-apply. Targets failure (1), the most common one. Costs one
  extra inference, which is affordable at desktop speeds and is not on the 1B laptop
  target — so it must stay optional.
- **Retrieval memory** — recall by similarity rather than recency. Needs an embedding
  model *and* an Ollama server started with `--embeddings`; on the test machine the
  endpoint returns "This server does not support embeddings". Opt-in, never required.

---

## The rule the learning layer may not break

**Adaptation may never weaken a guard, a permission prompt, or path confinement.** It
tunes budgets, hints, and retrieval. It does not touch safety.

A system that can learn "the user approves every time, so stop asking" is a data-loss
incident with a progress bar. The permission gate stays the single chokepoint, the write
guards stay unconditional, and no ledger statistic is an input to either.

Profiles are advisory, visible to the user, and resettable. A learned setting that makes
things worse must be as easy to discard as it was to acquire.

`earnedHints.NEVER_EARNED` is where that rule lives in code, and `USER_DENIED` is the
entry that matters. Repeated denials are the user exercising judgement, not a habit to
correct out of a model — so no amount of evidence promotes a hint about them, and the
only response to a denial stays the one `reactLoop` already gives in the moment: move on.

---

## Status

| Slice | State |
|---|---|
| Outcome ledger | Shipped — `core/outcomeLedger.js`, `utils/jsonlLog.js` |
| Earned corrective hints | Shipped — `agent/earnedHints.js`, rendered by `core/promptRouter.js` |
| Per-model calibration | Not started |
| Self-consistency on risky writes | Not started |
| Retrieval memory | Not started, and blocked on an Ollama server started with `--embeddings` |

The three unshipped slices are unchanged from the plan above. The next one worth doing is
per-model calibration: the ledger now holds the evidence a calibration command would
otherwise have to gather from scratch.
