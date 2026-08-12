# HirayaCoder — SAST Report

**Date:** 2026-08-12
**Commit / version:** `0.1.0` (Phase 6, pre-release)
**Performed by:** Phase 6 hardening pass
**Platform:** Windows 11, Node v24.11.1

## 1. Tooling Run

| Tool | Command | Scope | Result |
|---|---|---|---|
| ESLint (security rules) | `npx eslint app test` | `/app`, `/test` | **0 errors, 3 warnings** (all reviewed, below) |
| npm audit (production) | `npm audit --omit=dev` | shipped tree | **0 vulnerabilities** |
| npm audit (full) | `npm audit` | incl. dev tree | 3 (1 low, 1 moderate, 1 high) — all dev-only |
| retire.js | `npx retire --path app` | `/app` | **no findings** |
| Semgrep 1.172.0 | `semgrep --config p/javascript --config p/security-audit --metrics=off app` | `/app` | 2 findings, same rule and line (SAST-004) |
| Semgrep 1.172.0 | same, `--no-git-ignore`, on the files added this phase | `scripts/`, `test/integration/` | **no findings** (6 targets) |
| Manual review | checklist in §4 | `/app`, `/security` | complete |
| Integration suite | `npm run test:integration` | real VS Code host | 12 passing |
| Unit suite | `npm run test:unit` | `/app` | 573 passing |

The production dependency tree is empty (`"dependencies": {}`), which is what makes the
`--omit=dev` result meaningful rather than lucky.

## 2. Findings Summary

| Severity | Count | Resolved | Accepted Risk (with justification) |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 2 | 0 | 2 — dev-only and unshipped (SAST-002); intended, layered design (SAST-004) |
| Medium | 1 | 0 | 1 — dev-only, not shipped (SAST-002) |
| Low | 1 | 0 | 1 — dev-only, not shipped (SAST-002) |
| Info | 4 | 1 | 3 — reviewed as linear (SAST-001, SAST-003) |

No finding required a change to shipped behaviour. The one finding fixed this pass
(SAST-001) was defence in depth rather than an exploitable path.

## 3. Findings Detail

| ID | Tool | File:Line | Description | Severity | Status | Resolution / Justification |
|---|---|---|---|---|---|---|
| SAST-001 | ESLint `security/detect-non-literal-regexp` | `app/agent/tools/writeFile.js:251` | `new RegExp(\`\\b${name}\\b\`)` built a pattern from an identifier taken out of model-written file content. | Info | **Resolved** | Rewritten to tokenise the file (`body.match(/[A-Za-z_$][\w$]*/g).includes(name)`). The input was already constrained to an identifier by `exportedNames`, so this was defence in depth — but building patterns from model output is a habit worth not having. |
| SAST-002 | npm audit | `node_modules/mocha` → `diff`, `serialize-javascript` | jsdiff DoS (low); serialize-javascript RCE via `RegExp.flags` and CPU-exhaustion DoS (high); mocha transitively (moderate). | High | **Accepted** | Dev-only. `mocha` is a `devDependency` and **nothing from `node_modules` or `test/` is packaged** — verified with `vsce ls` (0 matches for either). Updated to mocha 11.8.0, the current release; the advisories persist upstream and `npm audit fix` offers no non-breaking resolution (`--force` would downgrade the test runner). Re-evaluate when mocha ships a patched `serialize-javascript`. |
| SAST-003 | ESLint `security/detect-unsafe-regex` | `app/agent/plannerAgent.js:75`, `:84`; `app/agent/tools/writeFile.js:218` | Patterns with adjacent optional groups flagged as potentially super-linear. | Info | **Accepted** | Reviewed individually. All three are `^`-anchored, and every optional group begins with a **literal** (`the`, `unit`, `as`) or a character class disjoint from the one preceding it (`\s` vs `[\w$]`). Whitespace cannot be distributed ambiguously, so each candidate split fails at a literal in O(1) and the whole match stays linear. Inputs are additionally bounded: TODO items are capped at 6 and truncated, and export entries are single identifiers. |
| SAST-004 | Semgrep `javascript.lang.security.detect-child-process` | `app/security/scriptRunner.js:366` | `spawn()` reached from the function arguments `command` and `options` — flagged twice, once per tainted argument. Impact HIGH, **confidence LOW**. | High (rule) → Accepted | **Accepted** | A true positive by pattern and the intended design: this is the *only* `child_process` call in the project, and the module exists to make it safe. `spawn` receives an **argument array with `shell: false`**, so no shell parses anything; `argv[0]` must match an allow-list; shell metacharacters are rejected at tokenize time; Windows `.cmd` shims have every argument pre-screened for characters `cmd.exe` would re-interpret; and the caller must already hold an approval from `permissionGate`. The rule's own confidence is LOW precisely because it cannot see that chain. Removing the call is not possible for a tool whose purpose is running the user's test suite. |

## 4. Manual Review Checklist

- [x] **Command injection** — `child_process` is imported in exactly one file
      (`security/scriptRunner.js:36`, `spawn` only). All execution uses argument arrays
      with `shell: false`, an allow-listed `argv[0]`, and shell-metacharacter rejection
      at tokenize time. Windows `.cmd` shims route through `cmd.exe /d /c` with
      pre-screened arguments. *Fixed this phase:* `/s` was removed from those flags — it
      overrode Node's argument escaping and broke every `npm`/`npx`/`yarn` command when
      Node is installed under a path with a space (the Windows default). Covered by a
      test that runs a real `.cmd` shim.
- [x] **Path traversal** — every mutation resolves through `pathGuard` (lexical
      traversal, absolute-escape, NUL, Windows reserved names) plus `assertRealPath`
      (symlink escape, including the parent of a file being created), in every
      permission mode. `deleteFile.js` and `writeFile.js` both call the gate before
      touching disk.
- [x] **SSRF / non-loopback egress** — `assertLoopbackEndpoint` throws at client
      construction, before any socket. Verified in the integration suite against a real
      host: a remote endpoint sets `configError`, the client is never repointed at it,
      and `refresh()` refuses to issue a request while that error stands.
- [x] **Insecure deserialization** — no `eval`, no `new Function`, anywhere in `/app`.
      Model output is `JSON.parse`d inside try/catch and then schema-validated.
- [x] **Webview CSP** — `default-src 'none'; img-src <cspSource> data:; style-src
      <cspSource> 'unsafe-inline'; font-src <cspSource>; script-src 'nonce-<generated>'`,
      with a fresh nonce per load. No remote origins. No `innerHTML`, `outerHTML`,
      `insertAdjacentHTML`, or `document.write` in any webview module — every node is
      built with `createElement` + `textContent`.
- [x] **Prototype pollution** — `outputParser` refuses `__proto__`, `constructor`, and
      `prototype` keys and copies into `Object.create(null)`; the same guard is applied
      to native tool-call argument objects. `modelCapability` indexes its budget matrix
      through a `Map` so a settings-supplied key cannot resolve to a prototype member.
- [x] **Secrets handling** — `redact()` covers file reads, search results, script
      stdout/stderr, editor selection and open-file content, the task text, and the last
      observation. Attached context files are scanned at **ingestion**
      (`contextFilesManager._buildEntry`), before truncation, so a secret cannot survive
      by sitting past the cut and reappearing when the budget changes; only the redacted
      excerpt is stored. Memory notes are redacted *and* injection-neutralised before
      being written by `contextTranslator`.
- [x] **Permission gate coverage** — every tool that mutates or executes calls the gate:
      `writeFile` → `requestWrite`, `deleteFile` → `requestDelete`, `runScript` →
      `requestScript`, reads → `requestRead`. `runTests.js` has no gate call of its own
      **by design** — it only discovers the right command from the project manifest and
      then delegates to `runScript` (line 82), which gates it. Confirmed by reading, not
      by grep, since the shape looks like a gap.
- [x] **Dependency review** — the production dependency tree is empty. Every
      `devDependency` is a test, lint, or packaging tool and none is bundled into the
      `.vsix`.

## 5. Sign-off

- [x] All Critical/High findings resolved or explicitly accepted with documented
      justification. Two Highs, neither reachable by a user of the packaged extension:
      SAST-002 is dev-only and unshipped, and SAST-004 is the deliberate single
      `child_process` call behind the allow-list, the metacharacter screen, and the
      permission gate.
- [x] Every tool in `PROMPT.md` §16 has now been run: ESLint, `npm audit` (both modes),
      Semgrep, and retire.js.
- [x] Manual checklist fully reviewed, with evidence recorded above rather than
      asserted.

**Reviewer signature:** `_______________`
**Date:** `_______________`

## 6. Semgrep run notes

Semgrep 1.172.0 via `python -m pip install semgrep` on Python 3.14.7.

```bash
semgrep --config p/javascript --config p/security-audit --metrics=off app
```

- **91 rules** ran against **50 targets**; ~100% of lines parsed.
- **2 findings**, both `detect-child-process` at `scriptRunner.js:366` — the same call
  reported once per tainted argument (`command`, `options`). See SAST-004.
- `--metrics=off` keeps the run from reporting usage back to the registry, which matters
  for a project whose main promise is that nothing leaves the machine.
- The default scan is **limited to files tracked by git**, so anything newly added is
  silently skipped. The files added this phase (`scripts/`, `test/integration/`) were
  therefore scanned in a second pass with `--no-git-ignore` and explicit paths: 6
  targets, no findings. Worth remembering on the next run.

The rule packs are fetched from the registry on first use and cached under
`~/.semgrep`. To keep later runs fully offline, point `--config` at that cache.
