# HirayaCoder — Threat Model

## Assets
- Source code and file contents within the user's workspace.
- Local conversation history (`.hirayacoder/`).
- Local audit log (`.hirayacoder/audit.log`).
- The developer's filesystem and shell, reachable via extension-initiated actions.

## Trust Boundaries
1. **VS Code extension host** ↔ **local Ollama server** (HTTP, loopback only).
2. **Extension host** ↔ **webview** (chat UI) — treated as untrusted rendering surface; CSP-locked, no remote content.
3. **Extension host** ↔ **filesystem/terminal** — every crossing gated by `permissionGate.js`.
4. **Model output** ↔ **extension logic** — model output is always treated as untrusted input, never as a trusted instruction to execute directly.

## Threats (STRIDE-style)

| # | Category | Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|---|---|
| 1 | Tampering | Model output attempts to instruct extension to write outside workspace | Medium | High | `pathGuard.js` rejects non-workspace paths; permission gate requires explicit approval per write. |
| 2 | Tampering | Model output attempts to trigger destructive shell command (`rm -rf`, etc.) | Medium | High | Terminal commands are insert-only by default; auto-run is opt-in per session with warning; allow-listed binaries only if auto-run is used internally. |
| 3 | Information Disclosure | Sensitive file (`.env`, private key) included in context sent to model | Medium | Medium | `secretsScanner.js` redacts before context assembly; user-visible warning. |
| 4 | Information Disclosure | Conversation history persisted in plaintext workspace folder | High (by design) | Low-Medium | Stored locally only, gitignored by default, user can delete anytime; documented clearly in README/TUTORIAL. |
| 5 | Denial of Service | Oversized context crashes small model / extension | Medium | Low | `tokenBudget.js` enforces hard caps before every request. |
| 6 | Elevation of Privilege | Extension dependency compromised (supply chain) | Low-Medium | High | Minimal dependency set, `npm audit` in CI, dependencies listed and justified below. |
| 7 | Spoofing | Extension accidentally configured to point at a non-local "Ollama-compatible" endpoint | Low | High | URL validated as loopback at config-load time; non-loopback values hard-rejected, not just warned. |
| 8 | Repudiation | No record of what the agent did/attempted | Medium | Medium | `auditLog.js` append-only local log of every proposed and approved/denied action. |

## Dependency Justification Log

| Package | Purpose | Why needed |
|---|---|---|
| (fill in as added, e.g.) `diff` | Compute unified diffs for the Apply UI | Small, no native bindings, no network calls |
| `eslint` + security plugins | Dev-only SAST tooling | Not shipped in the packaged `.vsix` |

*(Keep this table updated as dependencies are added; every new package must get a row before merging.)*
