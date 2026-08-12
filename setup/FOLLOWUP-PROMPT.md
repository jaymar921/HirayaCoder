# HirayaCoder — Follow-up Prompt (Device Handoff)

> Feed this to a coding AI alongside `setup/PROMPT.md`. `PROMPT.md` is the original
> specification and remains the source of truth for *what* the extension is.
> **This file is the current state**: what is built, what is left, what is known
> broken, and what still needs measuring. Where the two disagree about details, this
> file is newer — but never treat it as licence to drop a requirement from `PROMPT.md`
> without saying so.

**Handoff date:** 2026-08-12
**Reason:** moving from a 16 GB laptop to a desktop with more RAM and a GPU, to
benchmark the models the laptop could not run and to measure what a GPU changes.

---

## 0. Read this first

Three things are load-bearing and easy to undo by accident:

1. **The mocked test suite passes clean while a real model destroys a file.** Almost
   every serious bug in this project was found by running a live model, never by unit
   tests. After *any* change to the agent loop, prompts, translator, or tools, run
   `tools/bench-agent.js` against at least one small model before calling it done.
2. **Judge a benchmark run by whether the workspace ended up worse**, not by whether
   the model finished. A guard firing and the session stopping is the system working.
3. **`think: false` is mandatory on every structured-output call.** Hybrid reasoning
   models return empty `content` with the whole budget spent in `message.thinking`.
   This has now broken the project twice — most recently it disabled the TODO feature
   entirely for a whole day. The `thinking` *capability* decides which models are
   trusted with a TODO list; that is a completely separate thing from enabling
   Ollama's thinking mode on a request.

---

## 1. Completed phases

All of the following are implemented, unit-tested, and lint-clean.
**Baseline at handoff: 525 tests passing, 2 pending, 0 lint errors, 0 production
vulnerabilities.**

### Phase 1 — Foundation ✅
- `package.json` manifest, full settings surface, 15 commands, context menu, `Ctrl+Shift+H`.
- `core/ollamaClient.js` — zero-dependency HTTP client (`/api/tags`, `/api/show`,
  `/api/chat`, `/api/generate`, `/api/pull`, `/api/version`), NDJSON streaming,
  abort support. **Loopback-only enforced at construction**, before any socket opens.
- `core/modelDiscovery.js` — `/api/tags` primary, lazy `/api/show` fallback, caching,
  and the `tools` / `thinking` / `vision` capability flags.
- `core/modelCapability.js` — tier rule (**Tier B if ≤ 3B params OR no tool support**),
  budget matrix, and `canPlanTodos`.
- `utils/platform.js`, `utils/logger.js`, `features/statusBar.js`, `app/extension.js`.

### Phase 2 — Security ✅
- `security/pathGuard.js` — traversal and symlink-escape blocking, case-folded on Windows.
- `security/scriptRunner.js` — `spawn` with argv arrays, `shell: false`, allow-listed
  binaries, always-confirm list (`git push`, `npm publish`, `ollama pull`, …),
  shell-operator refusal.
- `security/permissionGate.js` — the single chokepoint. Deletes confirm even under
  Auto Edit (`permissions.alwaysConfirmDeletes`).
- `security/permissionModes.js`, `secretsScanner.js`, `auditLog.js`.

### Phase 3 — Memory & context ✅
- `core/memoryStore.js` — plain-text session memory, injection neutralisation on the
  way in *and* out, duplicate suppression, and **subject-based superseding** (a later
  note about a file replaces the earlier, now-false one).
- `core/contextTranslator.js` — composed notes rather than model-written summaries;
  failed writes and deletes are not remembered, failed *commands* are.
- `core/contextBuilder.js`, `utils/tokenBudget.js`, `core/contextFilesManager.js`.

### Phase 4 — Agent core ✅
- `agent/reactLoop.js` (Tier B) — **JSON-Schema-constrained** actions, repeat guard,
  parse recovery, per-error corrective hints, echoed-status-line guard, retry
  forgiveness for content refusals.
- `agent/nativeToolLoop.js` (Tier A), `agent/toolRegistry.js`, `agent/tools/*`.
- `agent/agentSession.js` — modes, change set, TODO orchestration, honest summaries.
- `agent/plannerAgent.js` — plain planning pass and `planTodos`.
- `core/outputParser.js` — `actionSchema()`, prototype-pollution guards, path
  plausibility.

### Phase 5 — UI & editor features ✅
- `features/chatTab.js` — webview panel per session; **the trust boundary**. The
  webview never names a file; it asks the host to open VS Code's own picker.
- `app/webview/` — `index.html` (CSP with per-load nonce), `style.css`,
  `main.js`, and components: `markdown.js`, `thinkingIndicator.js`,
  `messageBubble.js`, `planChecklist.js`.
- `features/codeActions.js`, `testGenerator.js`, `inlineCompletion.js`,
  `diffApply.js`, `modelManager.js`, `imageContext.js`.
- **TODO lists** for thinking-capable models ≥ 2B: a multi-part request is split and
  worked one item at a time, each with its own context and full step budget.
- **Filipino thinking indicator** — rotating Taglish lines, pulsing dots, elapsed
  counter, honest long-wait variants after 90s.
- **Image context** — vision-gated, magic-number checked, 4 MB cap, first message only.

---

## 2. Pending phases

### Phase 5 leftovers (small, do these first)
The chat tab works end to end, but `PROMPT.md` §2 lists component files that were
implemented **inline in `webview/main.js`** rather than as separate modules:
`welcomePanel.js`, `modelDropdown.js`, `thinkingSelector.js`, `modeSelector.js`,
`permissionMenu.js`, `contextFileChip.js`, and `features/welcomeScreen.js`.

The behaviour exists and is tested; only the file layout differs. Split them out if
you want the spec's structure — but do not split for its own sake. Extracting a
15-line control into its own module and a message protocol makes it harder to read,
not easier. Recommendation: extract `welcomePanel` and `permissionMenu` (which have
real logic) and leave the rest inline, documenting the deviation in `CHANGELOG.md`.

### Phase 6 — Harden & ship (not started)
1. **Integration tests** with `@vscode/test-electron`: activation, opening a chat tab,
   the webview message protocol, a full turn against a stubbed Ollama.
2. **SAST suite** and a manual review pass covering the checklist in `PROMPT.md` §15:
   command injection in `scriptRunner`, path traversal in `deleteFile`, SSRF,
   prototype pollution in every JSON path, webview CSP correctness, memory-file
   injection.
3. **`doc/ARCHITECTURE.md`** and **`doc/FEATURES.md`**.
4. **Packaging** — a script producing `builds/v<version>/*.vsix`. Verify
   `.vscodeignore` ships `setup/prompts/**` and `app/webview/**`; the prompts were
   silently excluded once already and the extension fell back to embedded defaults.
5. **Cross-platform check** — the `.vsix` on Windows, macOS, and Linux.

### New task — build the `frontend-design` skill
`PROMPT.md` §10 says to "use the `frontend-design` conventions available in this
environment … read that skill before writing the CSS". **That skill does not exist.**
The Phase 5 CSS was written by applying the conventions directly.

Create it at `.claude/skills/frontend-design/SKILL.md` so the instruction resolves.
It should encode what the existing `app/webview/style.css` already does, because that
file is the worked example:

- **Inherit the host theme.** Colour comes from `--vscode-*` variables, never hardcoded
  hex. An extension is a guest in someone else's editor.
- **One spacing scale.** A 4px base (`--sp-1` … `--sp-6`) so everything lands on a
  common grid; no ad-hoc pixel values.
- **Accent sparingly.** The sunrise gradient appears on exactly four things (send
  button, active step, thinking dots, welcome glyph). Spread wider it stops reading as
  an accent.
- **Wide content scrolls inside its own box.** Code blocks get `overflow-x: auto`; the
  page body must never scroll sideways.
- **Respect `prefers-reduced-motion`** — a static indicator, never a missing one.
- **Never build markup from model text.** `createElement` + `textContent`, never
  `innerHTML`. This is a security rule that lives in the design skill because that is
  where someone reaches when adding a component.

---

## 3. Bugs worth fixing on the new device

Ordered by how much they cost a user.

### 3.1 TODO progress never updates during a run — **confirmed, not yet fixed**
`webview/main.js` has a `todo-progress` handler, and `agentSession` emits
`todo-item-done`, but `chatTab._onAgentEvent` returns `undefined` for that event and
never posts anything. The checklist therefore sits at "all pending" for the whole
session and only fills in at the end, from `result.todos`.

Fix: forward `todo-item-done` as a `todo-progress` message carrying the current item
statuses. Small change, high visibility — a multi-minute run currently gives no sign
of which item it is on.

### 3.2 An item that succeeds but re-reads is recorded as failed
Reproduced on `qwen3.5:2b` in three consecutive runs. The model writes the file
correctly, then re-reads it "to verify", burns the rest of the item's steps, and never
emits `done`. `judgeItem` then reports `failed (stopped early after making changes)`.

The judgement is *honest* — work landed but the item was not closed — yet the summary
reads as a failure for an item that was, in substance, done. Options, in the order I
would try them:
1. Strengthen the post-write hint (it currently says "Do NOT read or write it again");
   possibly repeat it as the sole content of the next turn.
2. Treat a read of a file the item just wrote as a no-op that does not consume a step.
3. Let `judgeItem` return a third state — `done-with-warning` — when the item's target
   file was changed and every step succeeded.

Do **not** fix it by trusting the model's own claim of completion. That is the failure
mode the whole judgement exists to avoid.

### 3.3 `diffApply.confirmChange` is registered but never called
`diffApply.register(context)` runs at activation and the content provider works, but
the permission gate's `confirm` handler still uses a plain modal. Wire
`confirmChange()` in so "Review diff" appears on every write confirmation. Until then
the diff viewer is dead code.

### 3.4 Re-verify the user-refusal hint — one run per condition is not proof
When a delete is declined, the loop now tells the model that a refusal is a decision:
do not retry, and do not achieve the same effect another way. On `qwen3.5:2b`, same
task before and after, shell escalations went **2 → 0** and audit `blocked` events
went **2 → 0**.

That is one run per condition. Re-run it on the new hardware — ideally on a larger
model too, since a more capable model is *better* at finding a way around a refusal,
which makes it the more interesting test. The file survived in both runs regardless:
the hint changes how often a model goes looking, the allow-list is what stops it
succeeding, and neither should be removed on the strength of the other.

### 3.5 `status` message is never sent
`main.js` renders `msg.text` into the composer hint on a `status` message; nothing
posts one. Either send something useful (model name, tier, token budget) or delete the
handler.

### 3.6 `MODULE_TYPELESS_PACKAGE_JSON` warning in tests
`test/unit/webviewComponents.test.js` imports the webview ES modules with dynamic
`import()`, and Node warns because nothing declares them as modules. Harmless, noisy.
Fix by adding `app/webview/package.json` containing `{"type": "module"}` — **verify
`vsce package` still works afterwards**, which is why it was not done on the laptop.

### 3.7 Windows filesystem slowness is not a code bug
If the unit suite suddenly takes minutes instead of ~10 seconds and the failures are
all timeouts, measure a file write before suspecting the code. On the laptop a filter
driver (real-time AV scanning) made every `writeFileSync` take **~605 ms** while reads
stayed fast, turning an 8-second suite into 16 minutes. See `doc/MODELS.md`.

---

## 4. Benchmarking on the new device

### 4.1 Install the same models
Mirror the laptop exactly so the two machines are comparable, then add what the laptop
could not run:

```bash
# Mirrors the laptop — benchmark these first, for a like-for-like comparison.
ollama pull qwen3.5:0.8b        # 1.0 GB   873M   below the usable floor, keep for the floor test
ollama pull llama3.2:1b         # 1.3 GB   1.2B   the project's primary low-spec target
ollama pull qwen3.5:2b          # 2.7 GB   2.3B   the laptop's recommended daily driver
ollama pull qwen3.5:4b          # 3.4 GB   4.7B
ollama pull gemma4:e2b          # 7.2 GB   5.1B   best full-task result on the laptop
ollama pull gemma4:e4b          # 9.6 GB   8.0B   never ran on 16 GB — the headline test
ollama pull llama3.2:latest     # 2.0 GB   3.2B
ollama pull stable-code:latest  # 1.6 GB   3B     no tool support; exercises the Tier B fallback
```

### 4.2 How to run it

```bash
node tools/bench-agent.js <model> [mode] [approve|auto] [simple|full] [A|B]

node tools/bench-agent.js qwen3.5:2b agent auto simple    # one file
node tools/bench-agent.js qwen3.5:2b agent auto full      # three parts, three files
node tools/bench-agent.js gemma4:e2b agent auto full B    # force the ReAct loop
```

Rules that make the numbers mean anything:

- **Nothing else running.** On the laptop, a concurrent test suite pushed a single
  turn past the 300 s timeout and produced a "failure" that was pure measurement
  artefact.
- **One run at a time.** Two models at once measures contention.
- **Let the machine cool between long runs.** A model that suddenly runs many times
  slower than before is a thermal signal, not a regression.
- Report time as **seconds and minutes** — `299s (5.0 min)` — as `doc/MODELS.md` does.

### 4.3 What has *not* been benchmarked

| Model | Simple | Full | TODO path | Note |
|---|---|---|---|---|
| `qwen3.5:0.8b` | done | done | n/a (below floor) | — |
| `llama3.2:1b` | done | done | n/a (no thinking) | — |
| `qwen3.5:2b` | done | done | **done** | 1 of 3 items completed cleanly |
| `qwen3.5:4b` | **missing** | done (pre-TODO) | **missing** | Tier A; re-run now TODO exists |
| `gemma4:e2b` | done | done | n/a (no thinking) | best full-task result on the laptop |
| `gemma4:e4b` | **missing** | **missing** | **missing** | never ran on 16 GB — the headline test |
| `llama3.2:latest` | **missing** | **missing** | n/a | 3.2B, Tier A |
| `stable-code:latest` | **missing** | **missing** | n/a | no tools; forced Tier B |

Every existing timing in `doc/MODELS.md` is a **pre-TODO single-pass run** except the
`qwen3.5:2b` TODO rows. Re-running the thinking-capable models now that TODO lists
work is the main open measurement.

---

## 5. Laptop baseline — keep this, compare against it

**Do not overwrite these numbers.** Add a second column or a second table so the two
machines sit side by side. The laptop is the low-spec target the whole design is
shaped around, and losing its baseline loses the ability to tell whether a change
helped the machine that needed it.

### Laptop (baseline)
| | |
|---|---|
| Model | Lenovo IdeaPad Slim 3i |
| CPU | 12th Gen Intel Core i5-12450H, 2.00 GHz base (4P + 4E) |
| RAM | 16 GB LPDDR5-4800 |
| GPU | Intel UHD (integrated) — **not used for inference** |
| Inference | CPU-only, Ollama 0.32.7 |

| Model | Simple | Full | Time |
|---|---|---|---|
| `qwen3.5:0.8b` | fails | fails | 45–105s (0.8–1.8 min) |
| `llama3.2:1b` | partial | fails | 45–170s (0.8–2.8 min) |
| `qwen3.5:2b` | **passes** | partial | ~125s (2.1 min) |
| `qwen3.5:4b` | not run | **passes** | 299s (5.0 min) |
| `gemma4:e2b` | passes | **passes** | 180–200s (3.0–3.3 min) |
| `gemma4:e2b` forced Tier B | passes | not run | ~183s (3.1 min) |
| `gemma4:e4b` | — | — | could not run on 16 GB |

Laptop recommendation, for comparison: **`qwen3.5:2b` daily, `llama3.2:1b` for quick
single-file edits, `gemma4:e2b` for genuine multi-file work.**

### Desktop (to measure)
| | |
|---|---|
| CPU | AMD Ryzen 5 3600X (6C/12T) |
| RAM | 32 GB DDR4-3200 |
| GPU | NVIDIA GTX 1650 Super, **4 GB VRAM** |

**Predictions worth testing rather than assuming.** Write down what actually happens:

1. **4 GB of VRAM is the interesting constraint, not the 32 GB of RAM.** Ollama offloads
   as many layers as fit and runs the rest on CPU. Models comfortably under ~4 GB
   (`qwen3.5:0.8b`, `llama3.2:1b`, `qwen3.5:2b`, `qwen3.5:4b`, `llama3.2:latest`,
   `stable-code`) should fit almost entirely on the GPU and speed up **dramatically** —
   this is the case where a laptop-minute becomes a few seconds.
2. **`gemma4:e2b` (7.2 GB) and `gemma4:e4b` (9.6 GB) will only partially offload.**
   Expect a much smaller gain than the small models see, possibly little at all. Record
   `ollama ps` for each run — it reports the CPU/GPU split, and that split explains the
   timing better than any other single number.
3. **32 GB finally makes `gemma4:e4b` runnable.** On 16 GB it made the whole machine
   unresponsive. Whether it is *usable* is a separate question from whether it loads.
4. **A Ryzen 5 3600X is slower per-core than the i5-12450H** but has more full cores.
   For the CPU-resident portion, do not assume the desktop wins on raw CPU alone.

If the small models do get dramatically faster, that changes two recommendations:
`hirayacoder.inlineCompletion.enabled` becomes genuinely usable (it is off by default
precisely because CPU inference is too slow for it), and the TODO path's extra
inference calls stop being expensive. **Re-evaluate both, and update the defaults if
the data supports it.**

---

## 6. Working agreements

- **Per-phase confirmation.** Do not start the next phase without the user's go-ahead.
- **Deviations from `PROMPT.md` get recorded** in `CHANGELOG.md` with the reason, as
  the existing entries do.
- **Comments explain why, not what.** The existing code is written that way; match it.
  Every guard in `agent/tools/writeFile.js` and `agent/reactLoop.js` names the live
  failure that produced it, and that is the most useful documentation in the repo.
- **The 1B model stays the design constraint**, even on faster hardware. Its
  limitations are documented rather than designed around. A GPU making things fast is
  not a reason to stop supporting the machine that has none.
