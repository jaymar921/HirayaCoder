# HirayaCoder — SAST Report

**Date:** YYYY-MM-DD
**Commit / version:** `<git sha or version tag>`
**Performed by:** `<name>`

## 1. Tooling Run

| Tool | Command | Scope |
|---|---|---|
| ESLint (security rules) | `npx eslint app --ext .js` | `/app` |
| npm audit | `npm audit` / `npm audit --omit=dev` | full dependency tree |
| Semgrep | `semgrep --config p/javascript --config p/security-audit app/` | `/app` |
| retire.js | `npx retire --path .` | full repo |
| Manual review | see checklist below | `/app`, `/security` |

## 2. Findings Summary

| Severity | Count | Resolved | Accepted Risk (with justification) |
|---|---|---|---|
| Critical | | | |
| High | | | |
| Medium | | | |
| Low | | | |
| Info | | | |

## 3. Findings Detail

| ID | Tool | File:Line | Description | Severity | Status | Resolution / Justification |
|---|---|---|---|---|---|---|
| SAST-001 | | | | | | |

## 4. Manual Review Checklist

- [ ] Command injection — all `child_process` calls use `execFile`/`spawn` with argument arrays, no string interpolation into shell commands.
- [ ] Path traversal — every file operation routed through `pathGuard.js`; verified with test cases (`../`, absolute paths, symlink escape).
- [ ] SSRF / non-loopback egress — confirmed no code path can reach a non-`127.0.0.1`/`localhost` endpoint even via user-supplied config.
- [ ] Insecure deserialization — `outputParser.js` uses `JSON.parse` inside try/catch with schema validation, never `eval`/`Function` on model output.
- [ ] Webview CSP — verified `default-src 'none'`, nonce'd scripts only, no remote resource loads, no `innerHTML` of unsanitized content.
- [ ] Prototype pollution — JSON parsing paths checked for `__proto__`/`constructor` key injection; validated against allow-listed schema keys only.
- [ ] Secrets handling — confirmed `secretsScanner.js` runs before every context assembly step, not just on explicit file opens.
- [ ] Permission gate coverage — confirmed every write/exec code path (grep for `writeFile`, `fs.write`, `exec`, `spawn`) passes through `permissionGate.js`.
- [ ] Dependency review — every dependency has a row in `security/threat-model.md`'s justification log.

## 5. Sign-off

- [ ] All Critical/High findings resolved or explicitly accepted with documented justification.
- [ ] Manual checklist fully reviewed.

**Reviewer signature:** `_______________`
**Date:** `_______________`
