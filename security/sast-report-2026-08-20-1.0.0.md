# HirayaCoder — SAST Report

**Date:** 2026-08-20
**Commit / version:** `1.0.0`, branch `feat/1.0.0`
**Performed by:** 1.0.0 release pass
**Platform:** Windows 11 Pro 26100, Node v24.11.1, ESLint 9.39.5

Follows `security/sast-report-2026-08-19-0.9.0.md`. All three of its findings — SAST-011,
SAST-012, SAST-013 — remain closed, and the regex SAST-011 replaced has not returned.

This is the pass behind the first Marketplace release, so it is also the first one where
the answer "nobody has installed it from a store yet" stops being available.

## 1. Tooling Run

| Tool | Command | Scope | Result |
|---|---|---|---|
| ESLint (security rules) | `npm run lint` | `/app`, `/test` | **0 errors, 42 warnings** (all reviewed, §5) |
| ESLint (security rules) | `npx eslint tools` | `/tools` | 0 errors, 27 warnings (dev-only tree, §5) |
| npm audit (production) | `npm audit --omit=dev` | shipped tree | **0 vulnerabilities** |
| npm audit (full) | `npm audit` | incl. dev tree | **0 vulnerabilities** |
| retire.js 5.4.3 | `npx retire --path app` | shipped code | **0 findings** |
| retire.js 5.4.3 | `npx retire --path tools` | dev harnesses | **0 findings** |
| retire.js 5.4.3 | `npx retire --path .` | whole checkout | 4 findings, all in `.vscode-test/` — §6 |
| ReDoS measurement | `scratchpad/redos.js`, 26 expressions | every `detect-unsafe-regex` hit in `/app` | **1 finding** — SAST-014, §4 |
| Manual review | checklist in §5 | `/app` | complete |
| Unit suite | `npm run test:unit` | `/app` | 1,540 passing |
| Webview wiring | `test/unit/webviewWiring.test.js` | `/app/webview`, `/app/features` | 52 checks passing |

The production dependency tree is still empty (`"dependencies": {}`), which is what makes
the `--omit=dev` result meaningful rather than lucky. Nothing was added for 1.0.0.

## 2. What is new in this release, from a security point of view

**Almost nothing, and that is the intended shape of a 1.0.0.** No new tool, no new
permission, no new network call, no new dependency, no change to `pathGuard`,
`permissionGate`, `scriptRunner`, or the allow-list.

Two additions were reviewed on their own terms:

### The setup guide (`app/webview/components/guideCard.js`)

A header button that renders a card of static text. Reviewed because every previous
webview addition has been a control that asks the host for something, and this one is
the first that does not.

| | Existing controls | The guide |
|---|---|---|
| Sends a message to the host | yes | **no** |
| Renders content originating in a model or a file | yes | no — string literals in the module |
| Builds nodes with `createElement`/`textContent` | yes | yes |
| Reachable before a workspace is trusted | n/a | no — the panel is not |

Having no host message is the security-relevant fact: there is no new entry point on the
privileged side of the boundary, so the attack surface is unchanged by construction
rather than by inspection. The card is built with `createElement` and `textContent` like
every other component, and contains no user, model, or file content to render. CSP is
untouched.

### The webview wiring test (`test/unit/webviewWiring.test.js`)

Test-only, and worth noting here because it closes the protocol in both directions: 13
webview-to-host message types, all handled; 16 host-to-webview types, all handled. A
control that posts a message the host does not handle is a correctness bug rather than a
vulnerability, but the same check is what would catch a control being added on the wrong
side of the trust boundary.

## 3. Findings Summary

| Severity | Count | Resolved | Accepted Risk (with justification) |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 1 | **1** | 0 |
| Low | 0 | 0 | 0 |
| Info | 2 | 0 | 2 — §5 (ESLint warnings) and §6 (`.vscode-test/`) |

The one finding came from measurement, not from a scanner verdict. ESLint has flagged the
expression in question at every release since it was written; what was missing was
someone timing it.

## 4. Findings Detail

| ID | Tool | File:Line | Description | Severity | Status | Resolution / Justification |
|---|---|---|---|---|---|---|
| SAST-014 | ESLint + measurement | `app/agent/stepBrief.js:80` (`PATH_TOKEN`) | `namedFiles` sweeps an item's text with `/g` looking for filenames. Finding *one* match is linear — the repeated group is separated by a mandatory `/` the character class excludes — and the comment above it said exactly that, correctly. The cost it did not account for is scanning for a token that is **not** there: every start position inside an unbroken run of word characters gets its own attempt, making the sweep O(n²) in the length of that run. Measured on a single run of `a`, which is what a pasted data URI, minified line, or hash looks like to this expression: **23 ms at 3,200 characters, 334 ms at 12,800, 6.1 s at 51,200, 85.2 s at 204,800** — the extension host frozen throughout. Reached by pasting into the composer, so the impact is denial of the editor rather than a compromise. | **Medium** | **Resolved** | Each segment bounded to 120 characters, which caps the work per start position and returns the sweep to linear: **244 ms at 204,800 characters**, from 85.2 s. 120 is far past any real path segment and the filter still requires an extension or a `/`, so nothing this repo has ever matched changes — verified against the benchmark briefs and every path in this repo's own documentation. Two tests pin it: one timing the 204,800-character sweep, one asserting a long real path still resolves. The comment now records the measurement, because the previous comment was true and still left this reachable. |

### The other 21 expressions

The value of this pass is mostly the table below: every `security/detect-unsafe-regex`
warning in `/app`, timed against an input built to be its worst case — a pump that lets
each quantifier make progress and then fails at the end. The number that matters is not
the milliseconds but whether they quadruple when the input doubles.

| Expression | 400 | 800 | 1,600 | 3,200 | ×2 growth | Verdict |
|---|---|---|---|---|---|---|
| `agentSession.js:267` protected paths | 0.173 | 0.076 | 0.002 | 0.002 | 1.14× | linear |
| `agentSession.js:267` (`.env` tail) | 0.005 | 0.010 | 0.003 | 0.004 | 1.36× | linear |
| `completionCheck.js:63` stub comment | 0.147 | 0.065 | 0.002 | 0.002 | 1.05× | linear |
| `completionCheck.js:98` stub string | 0.111 | 0.058 | 0.006 | 0.009 | 1.53× | linear |
| `completionCheck.js:98` (plain fill) | 0.002 | 0.003 | 0.004 | 0.006 | 1.62× | linear |
| `dictation.js:183` exported names | 0.073 | 0.040 | 0.008 | 0.013 | 1.65× | linear |
| `dictation.js:195` default export | 0.055 | 0.032 | 0.007 | 0.012 | 1.67× | linear |
| `dictation.js:243` python defs | 0.042 | 0.028 | 0.004 | 0.007 | 1.53× | linear |
| `dictation.js:262` java public types | 0.066 | 0.041 | 0.008 | 0.009 | 1.17× | linear |
| `dictation.js:269` java bare types | 0.053 | 0.036 | 0.006 | 0.009 | 1.57× | linear |
| `plannerAgent.js:75` save no-op | 0.079 | 0.036 | 0.002 | 0.002 | 0.96× | linear |
| `plannerAgent.js:119` verify-only | 0.261 | 0.078 | 0.004 | 0.003 | 0.89× | linear |
| `stepBrief.js:80` path token | 0.186 | 0.056 | 0.005 | 0.008 | 1.61× | linear |
| **`stepBrief.js:80` path token (no dot)** | **0.343** | **1.226** | **5.399** | **19.402** | **3.59×** | **SAST-014** |
| `runScript.js:252` cd-chain | 0.132 | 0.050 | 0.011 | 0.020 | 1.78× | linear |
| `writeFile.js:219` export name | 0.032 | 0.021 | 0.005 | 0.008 | 1.71× | linear |
| `commonSense.js:116` path token | 1.539 | 0.700 | 2.692 | 10.851 | 4.03× | quadratic, **already bounded** — see below |
| `commonSense.js:116` (no dot) | 0.008 | 0.004 | 0.006 | 0.011 | 1.82× | linear |
| `commonSense.js:148` dangling reference | 0.288 | 0.108 | 0.002 | 0.002 | 0.94× | linear |
| `fileTree.js:85` looks-like-path | 0.036 | 0.018 | 0.007 | 0.015 | 2.31× | linear (sub-µs absolute) |
| `intentRouter.js:96` build verbs | 0.312 | 0.089 | 0.002 | 0.001 | 0.87× | linear |
| `intentRouter.js:291` identity | 0.383 | 0.116 | 0.003 | 0.009 | 3.31× | linear — ratio is jitter on 9 µs |
| `intentRouter.js:386` memory question | 0.169 | 0.076 | 0.004 | 0.007 | 1.49× | linear |
| `intentRouter.js:452` it-works | 0.828 | 0.262 | 0.005 | 0.007 | 1.51× | linear |
| `missingDeps.js:61` package name | 0.053 | 0.034 | 0.005 | 0.008 | 1.67× | linear |
| `ignoreRules.js:71` dotenv | 0.016 | 0.015 | 0.003 | 0.003 | 1.32× | linear |

All times in milliseconds. Two notes on reading it:

- **`commonSense.js:116` is the same defect and is not a finding**, because it was found,
  measured, documented and bounded when it was written: the caller slices to
  `MAX_SCANNED_CHARS = 4000` before the expression sees anything, so the shipped path
  costs about 10 ms in the worst case. It is in the table because it is what made
  SAST-014 findable — `stepBrief` holds a near-identical expression and inherited the
  comment about a single match being linear without inheriting the bound.
- **A high growth ratio on a sub-10-µs measurement is timer noise**, which is why
  `intentRouter.js:291` and `fileTree.js:85` are not findings. Both were re-measured at
  larger sizes and stay flat.

**ESLint still reports 22 `detect-unsafe-regex` warnings after the fix**, including the
bounded expression: `safe-regex` objects to the nested quantifier's *shape*, and a
bounded repetition does not satisfy it. This is the clearest case in the codebase for why
these warnings are reviewed and measured rather than counted — the count did not move,
and an 85-second freeze was removed.

## 5. Manual Review Checklist

- [x] **Command injection** — no change to `child_process` use in `/app`. `scriptRunner`
      still spawns with an argument array, no shell, one command, against the built-in
      allow-list plus whatever the user added; the model cannot extend it. No new call
      sites this release.
- [x] **Path traversal** — no new file operations in `/app`. Every existing one still
      routes through `pathGuard`. `guideCard` touches no path, and the webview still
      never names a file: it asks the host to open VS Code's own picker.
- [x] **SSRF / non-loopback egress** — no new network code. The loopback check on
      `hirayacoder.ollama.endpoint` is unchanged and still covered by an integration test
      that asserts a non-loopback endpoint is refused rather than attempted. The guide
      card is static text — notably, it fetches nothing, so the CSP has no new exception.
- [x] **Insecure deserialization** — `outputParser` unchanged: `JSON.parse` in a
      try/catch behind an allow-listed field pick, never `eval`/`Function`, and an action
      outside the mode's set is refused structurally.
- [x] **Webview CSP** — `default-src 'none'` intact; the only change to `index.html` is
      one `<button>` with no inline handler, which the nonce policy could not have
      executed anyway. Confirmed no `innerHTML`, `insertAdjacentHTML`, or string-built
      markup anywhere under `app/webview/` — `eslint-plugin-no-unsanitized` is clean and
      `guideCard` builds every node with `createElement` + `textContent`.
- [x] **Prototype pollution** — no new JSON parsing. The existing allow-listed field pick
      in `outputParser` is what keeps `__proto__` out, and it is unchanged.
- [x] **Secrets handling** — `secretsScanner` unchanged and still runs on context
      assembly rather than on explicit opens. The guide adds no context path.
- [x] **Permission gate coverage** — re-grepped `writeFile`, `fs.write`, `exec`, `spawn`
      across `/app`: every path still passes through `permissionGate`. Mode enforcement
      re-verified at both layers — `toolRegistry.forMode` withholds mutating tools outside
      Agent mode, and `AgentSession._execute` refuses a name it was not offered. Ask mode
      still builds no loop at all.
- [x] **Dependency review** — nothing added; `security/threat-model.md`'s justification
      log needs no new row.
- [x] **ReDoS** — every `detect-unsafe-regex` hit in `/app` measured, §4. One finding,
      resolved.

### ESLint warnings

**42** across `/app` and `/test`, from 34 at 0.9.0. Composition:

| Rule | Count | Assessment |
|---|---|---|
| `security/detect-unsafe-regex` | 22 | All measured this pass (§4). One real, fixed. |
| `security/detect-non-literal-regexp` | 14 | `RegExp` built from an escaped literal or from an allow-listed constant, never from model output unescaped. |
| `security/detect-object-injection` | 6 | Each is an index into an array declared on the line above, or a key from a literal list. Individually suppressed with a reason at the site. |

The rise from 34 is scope, not decay: 0.9.0's headline number counted `/app` and `/test`
while attributing new warnings to `/tools`, which `npm run lint` does not cover. Measured
consistently this pass: `/app` 36, `/test` 6, `/tools` 27.

`/tools` also carries 2 `no-undef` (`WebSocket` and `fetch` in `tools/lib/cdp.js` — both
Node 18+ globals the ESLint environment is not told about) and 8 unused
`eslint-disable` directives. Both are in the benchmark harness, which `.vscodeignore`
excludes from the package. Neither is a security defect; both are worth tidying and
neither blocks the release.

## 6. `.vscode-test/` findings

`npx retire --path .` reports 4 findings, all DOMPurify 3.4.8 advisories
(CVE-2026-65898/65899/66010/75838), in these files:

```
.vscode-test/vscode-win32-x64-archive-1.132.1/.../workbench.desktop.main.js
.vscode-test/vscode-win32-x64-archive-1.132.1/.../sessions.desktop.main.js
.vscode-test/vscode-win32-x64-archive-1.133.0/.../workbench.desktop.main.js
.vscode-test/vscode-win32-x64-archive-1.133.0/.../sessions.desktop.main.js
```

**Accepted, and not ours.** These are inside the VS Code builds `@vscode/test-electron`
downloads to run the integration suite. They are Microsoft's bundled copies of DOMPurify,
in a directory that is `.gitignore`d, never published, and not part of the `.vsix`. The
same four were accepted at 0.9.0 on the same reasoning; the count is unchanged, one
VS Code version newer. Nothing HirayaCoder ships contains DOMPurify — or any third-party
code at all.

## 7. Sign-off

- [x] All Critical/High findings resolved or explicitly accepted with documented
      justification. **None were opened.**
- [x] The one Medium finding (SAST-014) is resolved, measured before and after, and
      pinned by tests.
- [x] Manual checklist fully reviewed.
- [x] `npm run test:all` green — lint, 1,540 unit tests, and the integration suite
      against a real VS Code.

**Reviewer signature:** `jaymar921`
**Date:** `2026-08-20`
