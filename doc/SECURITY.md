# HirayaCoder — Security Model

## Design Principles

1. **Offline-only, loopback-only.** The extension only ever talks to `127.0.0.1`/`localhost` (the local Ollama service). Any configured URL that isn't loopback is rejected by `core/ollamaClient.js` at load time.
2. **Default-deny on side effects.** Nothing writes to disk, deletes a file, or executes a shell/script command without explicit user approval via `security/permissionGate.js` — true at every step of every agent session, regardless of loop strategy (native tool-calling or simulated ReAct). The four explicit permission states (Approve Edits / Auto Edit / Approve Running Scripts / Auto Approve Running Scripts) are always visible in the chat tab, never hidden settings, and Auto Approve Running Scripts requires a deliberate one-time opt-in. Reads within the workspace don't require per-call approval so the agent can explore freely, but writes, deletes, and script execution always do unless the matching auto mode is on.
3. **Fail closed, not open.** If model output can't be parsed or validated, HirayaCoder shows the raw response and takes no action — it never guesses.
4. **Least privilege.** The agent can only read/write inside the current workspace root; `security/pathGuard.js` canonicalizes and validates every path.
5. **No silent data exfiltration.** `security/secretsScanner.js` screens content before it's sent to the model (even locally) so `.env` files, keys, and tokens aren't casually included in prompts by accident.
6. **Everything is logged, nothing is transmitted.** `security/auditLog.js` keeps a local, append-only record of agent actions for the user's own review.

## Threat Model Summary

See `/security/threat-model.md` for the full matrix. Key threats considered:

| Threat | Mitigation |
|---|---|
| Prompt injection via file/workspace content instructing the model to exfiltrate data or run destructive commands | Permission gate requires human approval on every write/exec regardless of what the model "decides"; no action is ever auto-approved based on model output alone. |
| Path traversal (`../../etc/passwd`-style) | `pathGuard.js` canonicalizes and rejects any path resolving outside the workspace root. |
| Command injection via a model-proposed command | `scriptRunner.js` executes approved commands itself, via `spawn` with an argument array and `shell: false` — there is no shell to re-parse anything. Shell operators (`;` `&&` <code>&#124;</code> `>` `` ` `` `$(`) are rejected at tokenize time rather than passed through as literal arguments, and `argv[0]` must match an allow-list that only the user can extend. On Windows, `.cmd` shims (`npm`, `npx`, `yarn`) are invoked through `cmd.exe /d /s /c` with pre-screened arguments, since Node refuses to spawn them otherwise. |
| An auto-approved command silently reaching the network | A subset of allow-listed commands — `git push`/`clone`/`fetch`, `npm publish`/`login`/`config`, `ollama pull` — always require a confirmation click, *even when Auto Approve Running Scripts is on*. Auto-approve exists to skip clicks on routine local work, not to let a model ship the user's code somewhere. |
| Symlink escape from the workspace | Lexical path checks cannot see that `docs/notes` is a link to `/etc`. `pathGuard.assertRealPath` resolves symlinks (and, for a file being created, its nearest existing ancestor) and re-checks containment against the real workspace root. |
| The agent tampering with its own oversight | `.git` and `.hirayacoder` are write/delete-protected, so the agent cannot rewrite its own audit log or poison the memory it later reads back as trusted context. Reads are still permitted. |
| Prompt injection *laundered through session memory* | The subtle one. A payload in file content or script output survives being summarized, and the resulting note is stored permanently and re-injected as trusted background on every later turn. Stripping delimiters is not enough — the meaning survives. `contextTranslator` therefore discards any note that reads as a standing instruction (`looksLikeInstruction`) or that claims an action the step did not perform (`contradictsAction`, compared against the action from the tool call rather than against the possibly-poisoned step text). Both checks apply to the model's answer and to the agent's own `thought`. |
| A summarized note misstating what happened | Success or failure is stamped from the tool result in code, never inferred from model output, so a failed build cannot be remembered as a successful one. Steps carrying no substance skip the model entirely rather than inviting invention. |
| Secrets leaking into prompts | `secretsScanner.js` regex/entropy-scans content before it's added to context; matches are redacted with a visible warning. |
| Malicious/compromised npm dependency | Minimal dependency surface; every dependency justified in the threat model; `npm audit` run in CI. |
| Webview XSS | Strict CSP (`default-src 'none'`, nonce'd scripts, no remote resources); no `innerHTML` with unsanitized model output — rendered via safe DOM APIs / sanitized markdown renderer. |
| Malformed/adversarial JSON from a small model breaking the parser | `outputParser.js` validates against a fixed schema; any failure is treated as "no action," never as a crash or an auto-apply. |
| The learning layer relaxing a guard it keeps seeing refused | Adaptation adjusts what a model is *told*, never what it is *allowed to do*: no permission decision, path check, or allow-list entry takes any input from `outcomes.jsonl`. `earnedHints.NEVER_EARNED` puts the sharpest case in code — a repeatedly declined action can never promote a hint, because a system that can learn "the user approves every time, so stop asking" is a data-loss incident with a progress bar. |
| Prompt injection *laundered through the outcome ledger* | The ledger is a file on disk and therefore untrusted input, the same as session memory. It is answered structurally rather than by sanitizing: the ledger contributes only counts, and every earned hint is a constant in `agent/earnedHints`. `promptRouter` re-checks each hint against the catalogue before rendering it, so a hand-edited or corrupted ledger can change *which* hint appears — never introduce a sentence of its own. The record shape is an allow-list of enum-shaped fields, so no path, command, or file content is ever stored there to leak in the first place. |

## What HirayaCoder Will Never Do

- Send code, files, session memory, or attached context files to any non-loopback network endpoint.
- Auto-run a shell/script command without the user explicitly enabling Auto Approve Running Scripts for that session — and even then, never a command that pushes, publishes, or downloads.
- Bypass the path guard or the binary allow-list in an auto mode. Auto modes remove the *confirmation click*, never the underlying safety check.
- Auto-write or auto-delete a file without either an explicit Apply click, or Auto Edit explicitly enabled.
- Collect telemetry, usage analytics, or crash reports.
- Store credentials, memory, or model output outside the local workspace `.hirayacoder/` folder — which the extension offers (never forces) to add to your `.gitignore`.

## Reporting a Security Issue

Document your project's actual reporting process here (e.g. a `SECURITY.md`-style contact or private issue tracker) before publishing.
