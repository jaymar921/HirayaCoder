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
| Command injection via terminal suggestions | Commands are only ever *inserted* into the terminal, never executed by the extension, unless the user has explicitly opted into auto-run for the session. Any internal `child_process` use is `execFile`/`spawn` with argument arrays and an allow-list of binaries — never `exec` with string concatenation. |
| Secrets leaking into prompts | `secretsScanner.js` regex/entropy-scans content before it's added to context; matches are redacted with a visible warning. |
| Malicious/compromised npm dependency | Minimal dependency surface; every dependency justified in the threat model; `npm audit` run in CI. |
| Webview XSS | Strict CSP (`default-src 'none'`, nonce'd scripts, no remote resources); no `innerHTML` with unsanitized model output — rendered via safe DOM APIs / sanitized markdown renderer. |
| Malformed/adversarial JSON from a small model breaking the parser | `outputParser.js` validates against a fixed schema; any failure is treated as "no action," never as a crash or an auto-apply. |

## What HirayaCoder Will Never Do

- Send code, files, session memory, or attached context files to any non-loopback network endpoint.
- Auto-run a shell/script command without the user explicitly enabling Auto Approve Running Scripts for that session.
- Auto-write or auto-delete a file without either an explicit Apply click, or Auto Edit explicitly enabled.
- Collect telemetry, usage analytics, or crash reports.
- Store credentials, memory, or model output outside the local workspace `.hirayacoder/` folder — which the extension offers (never forces) to add to your `.gitignore`.

## Reporting a Security Issue

Document your project's actual reporting process here (e.g. a `SECURITY.md`-style contact or private issue tracker) before publishing.
