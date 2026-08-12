# HirayaCoder — Architecture

How the extension is put together and, more usefully, *why*. Roughly 13,000 lines of
JavaScript across 46 modules in `app/`, with **no production dependencies** — the
`dependencies` field in `package.json` is empty and the packaged `.vsix` contains no
`node_modules` at all.

---

## The shape of it

```
VS Code                                    Ollama (127.0.0.1 only)
   │                                              ▲
   │  commands, editor context                    │  HTTP, no auth, loopback-enforced
   ▼                                              │
┌──────────────────────────────────────────────────────────┐
│ extension.js — activation, commands, the HirayaCoder app │
└──────────────────────────────────────────────────────────┘
   │                │                    │
   │                │                    └────────────► features/  (chat tab, code
   │                │                                    actions, diffs, completion)
   │                ▼
   │        agent/agentSession.js ── the driver
   │            │        │
   │            │        ├── reactLoop.js       (Tier B: constrained JSON actions)
   │            │        └── nativeToolLoop.js  (Tier A: native tool calls)
   │            │                    │
   │            │                    ▼
   │            │            agent/tools/*  ─────┐
   │            ▼                                │
   │      core/  context, memory, parsing        │  every mutation
   │                                             ▼
   └───────────────────────────► security/permissionGate.js ── the chokepoint
                                          │
                                    pathGuard · scriptRunner · auditLog
```

Three ideas carry most of the weight. Everything else follows from them.

### 1. One chokepoint, not many checks

Every write, delete, and command execution goes through `security/permissionGate.js`.
Not "should go" — the tools have no other route to the disk. `writeFile` asks the gate,
gets back a *resolved* path, and writes to that. It never resolves a path itself.

This is why "did anyone approve this?" is answerable by reading one file, and why the
audit log can be complete rather than best-effort. A second code path that wrote
directly would not be a style problem; it would make the whole permission model a
suggestion.

The gate fails closed: if the confirmation handler throws, or was never wired up, the
answer is no.

### 2. The model is a source of input, never of authority

Everything a model produces is untrusted data: paths, file contents, commands,
summaries, and its own claims about what it did.

- `core/outputParser.js` parses actions against a **JSON Schema**, refuses
  prototype-polluting keys, and rejects paths that are prose rather than paths.
- `agent/tools/writeFile.js` carries seven guards, each one named after the live failure
  that produced it — truncation, unclosed brackets, commenting-out, deleted exports,
  a switched module system, an export pointing at nothing, a deleted implementation.
- `agentSession.judgeItem` decides whether a TODO item is done from **evidence** — did
  the change set grow, did any step fail — never from the model saying so.
- `appendUnfinishedNote` appends what actually failed to the model's own summary,
  because models describe what they intended.

The rule generalises: wherever the code could either check the world or believe the
model, it checks the world.

### 3. Two loops, one driver

`agent/agentSession.js` owns a turn: mode, budgets, change set, memory, TODO
orchestration, and the honest summary at the end. It delegates the actual stepping to
one of two loops, chosen by `core/modelCapability.js`:

| | Tier B — `reactLoop.js` | Tier A — `nativeToolLoop.js` |
|---|---|---|
| Chosen when | ≤ 3B params **or** no tool support | everything else |
| Mechanism | one JSON action per turn, schema-constrained | Ollama's native tool calling |
| Context | rebuilt each turn, tightly budgeted | conversation accumulated |
| Exists because | small models emit tool-call syntax far more reliably than they orchestrate it | the chat template was trained on this shape |

Both call the same `execute`, so the gate, the change set, and the audit log see
identical traffic regardless of tier. Swapping loops changes how an action is
*produced*, never what is *permitted*.

---

## Directory by directory

### `app/core/` — talking to the model, and deciding what it sees

| Module | Responsibility |
|---|---|
| `ollamaClient.js` | Zero-dependency HTTP against `/api/tags`, `/api/show`, `/api/chat`, `/api/generate`, `/api/pull`, `/api/version`. NDJSON streaming, timeouts, abort. **Loopback enforced at construction**, before a socket opens. |
| `modelDiscovery.js` | Normalises `/api/tags`; falls back to `/api/show` only for incomplete entries. Caches by name+digest. |
| `modelCapability.js` | Tier rule, budget matrix, `canPlanTodos`. Indexes budgets through a `Map` so a settings-supplied key cannot reach a prototype member. |
| `promptRouter.js` | Assembles the system prompt and the tool set for the current mode. Plan and Ask modes **omit** the mutating tools rather than refusing them later. |
| `contextBuilder.js` | Assembles the prompt under a token budget, by priority. Redacts on the way in. |
| `contextFilesManager.js` | Files attached with `+`. Scans and redacts at ingestion, before truncation. |
| `memoryStore.js` | Plain-text session memory. Treats its own file as untrusted on read; neutralises injection both directions; supersedes by subject. |
| `contextTranslator.js` | Turns a step trace into memory notes. **Composed**, not model-written. |
| `outputParser.js` | Model output → validated action. |
| `tokenBudget.js` (in `utils/`) | Estimation and truncation that errs high. |

### `app/agent/` — deciding what to do

`agentSession.js` drives; `reactLoop.js` and `nativeToolLoop.js` step; `toolRegistry.js`
dispatches; `tools/*` act; `plannerAgent.js` plans and splits; `todoList.js` holds the
checklist **outside** the model, because a small model holding three goals at once drops
one.

### `app/security/` — the part that is allowed to say no

`permissionGate.js` (chokepoint) · `permissionModes.js` (two independent toggles) ·
`pathGuard.js` (lexical + `realpath` symlink checks) · `scriptRunner.js` (the only
`child_process` in the project) · `secretsScanner.js` · `auditLog.js`.

Deletes confirm **even under Auto Edit**, because a wrong write is visible in a diff and
recoverable from the change set, and a wrong delete is neither.

### `app/features/` and `app/webview/` — the parts a user touches

`chatTab.js` is the trust boundary. The webview renders and collects clicks; everything
that touches the machine happens in the extension host. Concretely: **the webview never
sends a path.** It sends "the user clicked attach", and the host opens VS Code's own
picker — so a compromised webview can ask for a dialog, never name a file.

The webview runs under `default-src 'none'` with a per-load script nonce, and builds
every node with `createElement` + `textContent`. There is no `innerHTML` anywhere in
`app/`, and that is a rule rather than an accident.

---

## Data on disk

Everything lives under `.hirayacoder/` in the workspace, and nothing leaves the machine.

| Path | Contents |
|---|---|
| `.hirayacoder/memory/session<N>.txt` | Plain-text session memory, one file per chat tab |
| `.hirayacoder/audit.log` | Append-only JSONL: action, decision, mode, timestamp |
| `.hirayacoder/context-files/` | Index of files attached with `+` |

Both `.git` and `.hirayacoder` are write- and delete-protected, so the agent cannot
rewrite its own audit log or memory.

---

## Testing, and what each layer can actually tell you

| Suite | Command | What it proves |
|---|---|---|
| Unit (573) | `npm run test:unit` | Logic, guards, parsing, permission decisions — against a stubbed `vscode`. |
| Integration (12) | `npm run test:integration` | Activation, command registration, webview protocol, and a full turn to disk **in a real VS Code**, against a stub Ollama on loopback. |
| Live benchmark | `node tools/bench-agent.js <model>` | What a real model does to a real workspace. |

That third row is not optional, and the reason is written into the project's history:
**the mocked suite has passed clean while a real model destroyed a file**, repeatedly.
Every serious bug in `doc/MODELS.md` was found by running a model, never by a unit test.
After any change to the agent loop, prompts, translator, or tools, run the benchmark
before calling it done.

---

## The constraint behind the design

A 1B model on a laptop with no GPU. Not as a floor to clear, but as the thing the
architecture is shaped around: the constrained JSON loop, the tight context budgets, the
externally-held TODO list, and every guard in `writeFile.js` exist because a small model
did something specific and destructive that a larger one would not have.

Faster hardware changes how long a turn takes. It does not change what a 1B model
understands, and it is not a reason to stop supporting the machine that has none.
