# HirayaCoder — SAST Report

**Date:** 2026-08-14
**Commit / version:** `0.7.0`, branch `feat/0.7.0`
**Performed by:** 0.7.0 hardening pass
**Platform:** Windows 11 Pro 26100, Node v24.11.1, Python 3.14.7

Supersedes `doc/SAST-0.6.1.md`, whose three deferred findings are all closed here.

## 1. Tooling Run

| Tool | Command | Scope | Result |
|---|---|---|---|
| ESLint (security rules) | `npm run lint` | `/app`, `/test` | **0 errors, 25 warnings** (all reviewed, §4) |
| npm audit (production) | `npm audit --omit=dev` | shipped tree | **0 vulnerabilities** |
| npm audit (full) | `npm audit` | incl. dev tree | **0 vulnerabilities** — first pass where this is true |
| Semgrep 1.172.0 | `semgrep --config p/javascript --config p/security-audit --metrics=off app` | `/app` | 2 findings, same rule and line (SAST-004, pre-existing) |
| retire.js | — | — | **Not run this pass**; see §6 |
| Manual review | checklist in §5 | `/app`, `/security` | complete |
| Unit suite | `npm run test:unit` | `/app` | 1323 passing |
| Integration suite | `npm run test:integration` | real VS Code host | 16 passing |

The production dependency tree is still empty (`"dependencies": {}`), which is what makes
the `--omit=dev` result meaningful rather than lucky.

**Semgrep coverage note.** The scan is limited to files tracked by git, which silently
skips anything newly added. All five modules added in 0.7.0 were committed before the
scan and are in the 77 targets (0.1.0 scanned 50). This was checked rather than assumed —
it is the trap recorded at the end of the 0.1.0 report.

## 2. Findings Summary

| Severity | Count | Resolved | Accepted Risk (with justification) |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 2 | **2** | 0 |
| Medium | 2 | **2** | 0 |
| Low | 1 | **1** | 0 |
| Info | 2 | 0 | 2 — reviewed, §4 and SAST-009 |

Every finding carried forward from 0.6.1 is closed. Two new findings were opened and
closed within this pass (SAST-007, SAST-008), both found by ESLint warnings that the
previous two passes had reviewed and dismissed as a class — see §4 for why that class
deserved re-examination rather than a third dismissal.

## 3. Findings Detail

| ID | Tool | File:Line | Description | Severity | Status | Resolution / Justification |
|---|---|---|---|---|---|---|
| SAST-005 | Manual (0.6.1 §1) | `app/security/scriptRunner.js:72` | `npx` was on the default allow-list and absent from `ALWAYS_CONFIRM`, while `NON_INTERACTIVE_ENV` sets `npm_config_yes` — suppressing npx's own *"Ok to proceed?"*. Under auto-approve-scripts this fetched and executed an arbitrary npm package with no confirmation, in an extension whose headline claim is that it works fully offline. Not theoretical: `.ignore/3.todo-app-0.6.0/.hirayacoder/audit.log:7` records `npx create-vite@latest …` auto-approved on a live run. | **High** | **Resolved** | `ALWAYS_CONFIRM` now covers all six spellings — `npx` (any arguments), and `exec`/`x`/`create` under `npm`, `yarn`, `pnpm` — with the reason *"this downloads and runs a package from the internet"*. Bare `npm init` is deliberately excluded: it writes a manifest and touches no network, and a click for nothing is a click trained away. `init` **with** an initializer (`npm init vite`) does confirm. Nine-command test pins every spelling. |
| SAST-006 | Manual (0.6.1 §2) | `app/core/workspaceBootstrap.js:90`, `app/core/environmentProfile.js:199` | `ensureGitignore` and `environmentProfile.persist` wrote to `path.join(workspaceRoot, …)` directly — the only two writes in the extension that bypassed `pathGuard` and therefore its `realpath` symlink check. A workspace whose `.gitignore` is a symlink pointing outside the tree would have been appended to. | Low | **Resolved** | Both now resolve through `pathGuard.resolvePath` + `assertRealPathSync`, and skip the write with a logged warning on refusal. The guard gained a synchronous twin because activation reads the profile immediately and making that path async would have been a wider change than the check it was adding; the containment decision is shared between the two forms so they cannot drift. Symlink and directory-junction cases tested against both twins on every platform. |
| SAST-002 | npm audit | `node_modules/mocha` → `diff`, `serialize-javascript` | jsdiff DoS (low); serialize-javascript RCE via `RegExp.flags` and CPU-exhaustion DoS (high); mocha transitively (moderate). Open and accepted since the 0.1.0 pass. | High / Medium | **Resolved** | `overrides` pinning `diff@^9.0.0` and `serialize-javascript@^7.1.0`, with mocha at 11.8.0. This is what actually clears the advisories: upstream mocha still declares `diff@^7` and `serialize-javascript@^6`, so neither range reaches a patched release, and `npm audit fix --force` proposed mocha@11.3.0 — a *sideways* move that fixes neither. Both are two majors and one major ahead of what mocha asks for, so the suite was verified three ways: serially (1323 passing), in `--parallel` mode (the `serialize-javascript` path, 1323 passing), and against a deliberately failing assertion to confirm the `diff`-backed reporter still renders. `npm audit` now reports **0 across the full tree**. |
| SAST-007 | ESLint `security/detect-unsafe-regex` | `app/core/commonSense.js` (`DANGLING_REFERENCE`) | Pattern anchored with `^\s*` … `\s*$` around an optional character — two unbounded whitespace runs either side of `[.!?]?`, which is the classic ambiguous shape. A message ending in a long whitespace run could be split between them in quadratically many ways. | Medium | **Resolved** | **Measured before and after, not argued.** 1 ms at 1,000 trailing spaces, 68 ms at 10,000, **1,660 ms at 50,000**. The caller now trims and both anchors are gone: **0 ms at 50,000**. The optional groups that remain each begin with a distinct literal (`please`, `can`, `could`), so any candidate has one way to match. Pinned by a test with a 250 ms budget. |
| SAST-008 | ESLint `security/detect-unsafe-regex` | `app/core/commonSense.js` (`PATH_TOKEN`) | A single match is linear — the nested quantifier's outer group must consume a separator and its character class cannot match one — but the pattern is scanned with `/g`, so a string containing no match gets one scan per start position: O(n²) overall. | Medium | **Resolved** | **3,089 ms on 50,000 characters** of `a/a/a/…`. Input to `referencedPaths` is now bounded to 4,000 characters, the same discipline `todoList` applies to its items. A message longer than that is a paste, not a request naming a mistyped file. Pinned by a test with a 250 ms budget. |
| SAST-004 | Semgrep `javascript.lang.security.detect-child-process` | `app/security/scriptRunner.js:451` | `spawn()` reached from the function arguments `command` and `options` — flagged twice, once per tainted argument. Impact HIGH, **confidence LOW**. Unchanged from 0.1.0 apart from the line number. | High (rule) → Info | **Accepted** | A true positive by pattern and the intended design: this is the only `child_process` call in the project, and the module exists to make it safe. `spawn` receives an argument array with `shell: false`; `argv[0]` must match an allow-list; shell metacharacters are rejected at tokenize time; Windows `.cmd` shims have every argument pre-screened; and the caller must already hold a `permissionGate` approval. 0.7.0 **narrows** this further rather than widening it — see SAST-005. The rule's confidence is LOW precisely because it cannot see that chain. |
| SAST-009 | Manual | `app/features/chatTab.js:_answerClarification` | New in 0.7.0: the webview can now post a `clarify` message whose free text is appended to the model's next prompt and written to session memory. A compromised webview could therefore inject text into a running turn. | Info | **Accepted** | Same trust level as the composer, which has always been able to send arbitrary text to the model — this adds no capability the webview did not have. Three properties bound it: answers are matched by clarification id, so a stale card from an earlier turn cannot answer the current question; an answer arriving with nothing outstanding is logged and dropped; and text written to memory goes through `memoryStore.append` → `normalizeEntry` → `neutralize`, so injection delimiters cannot survive into a later session's prompt. The webview still names no path and opens no file — the boundary the architecture rests on is unchanged. |

## 4. On the warning class this pass stopped dismissing

The 0.1.0 and 0.6.1 passes both reviewed `security/detect-unsafe-regex` warnings
individually and accepted all of them, each time with a written argument about why the
pattern was unambiguous. Those arguments were correct for the patterns they were about.

The failure mode is that "reviewed and dismissed" becomes the default answer for a rule,
and 0.7.0 added two patterns where it would have been wrong. **SAST-007 and SAST-008 were
both real, and both were found by warnings of exactly the class the previous passes had
learned to wave through.** Neither is an attack — the input is the user's own composer,
on their own machine — but a three-second freeze of the extension host is a defect
regardless of who caused it.

What changed procedurally: a flagged pattern is now **measured on adversarial input**
before it is accepted, and the measurement is recorded in the code beside the pattern.
Arguing from the shape of a regex is how both of these would have been dismissed again.

The remaining 25 warnings break down as:

- **`detect-unsafe-regex` (13).** Eleven pre-existing, each `^`-anchored with every
  optional group beginning with a literal or a disjoint character class. The two in
  `commonSense` are SAST-007 and SAST-008, now bounded, with their measurements written
  in place; the linter still flags the shapes, which is why the numbers are in the source
  rather than only in this report.
- **`detect-non-literal-regexp` (9).** `projectOverview` and `ignoreRules` build patterns
  from workspace filenames, bounded by filename length; the rest are in tests.
- **`detect-object-injection` (3).** All index a fixed, code-owned map or array. The
  Damerau-Levenshtein matrix added in 0.7.0 is disabled explicitly with the reason
  written in place: every index is a loop counter bounded by one of the two string
  lengths, and the matrix is local to the function.

## 5. Manual Review Checklist

- [x] **Command injection** — `child_process` is imported in exactly one file
      (`security/scriptRunner.js:36`, `spawn` only), confirmed by grep across `/app`.
      Unchanged this pass except that the set of commands reaching it without a
      confirmation click is now **smaller** (SAST-005).
- [x] **Path traversal** — every mutation resolves through `pathGuard` plus
      `assertRealPath`. As of this pass that is now *every* write without exception:
      the two that bypassed it are closed (SAST-006). The new synchronous twin shares
      its containment check with the async form, and both are asserted to agree on the
      same inputs, including a `.gitignore` symlink and a `.hirayacoder` junction.
- [x] **SSRF / non-loopback egress** — `assertLoopbackEndpoint` throws at client
      construction, before any socket. Verified in the integration suite against a real
      host. Nothing in 0.7.0 opens a socket; the clarification channel is
      `postMessage` between the webview and the extension host.
- [x] **Insecure deserialization** — no `eval`, no `new Function` anywhere in `/app`,
      re-confirmed by grep. Model output is `JSON.parse`d inside try/catch and then
      schema-validated.
- [x] **Webview CSP** — unchanged: `default-src 'none'` with a per-load script nonce and
      no remote origins. The new `components/clarificationCard.js` builds every node with
      `createElement` + `textContent`; the only `innerHTML` string in `/app` is the
      comment in `markdown.js` saying there must never be one.
- [x] **Prototype pollution** — `outputParser` refuses `__proto__`, `constructor`, and
      `prototype` and copies into `Object.create(null)`. The new clarification path adds
      no object built from model output: option ids are generated by
      `clarification.build`, and an answer naming an unknown id resolves to *stop* rather
      than to a lookup.
- [x] **Secrets handling** — `redact()` coverage unchanged. Checked specifically for
      0.7.0: `errorRecovery` quotes a failure's first meaningful line into a question and
      into memory, and that text has already passed through `runScript`'s `redact()`
      before it reaches the observation this reads from.
- [x] **Permission gate coverage** — every mutating tool still calls the gate. The
      clarification path grants nothing: its effects are *skip*, *stop*, and *instruct*,
      and `instruct` adds text to a prompt. A user answering a question cannot approve a
      write, and an answer cannot reach `scriptRunner` at all.
- [x] **Denial of service through a blocked run** — new this pass, because the feature is
      new. A run awaiting an answer is parked on a promise and holds its lane in the turn
      queue. Every path that removes the card settles it: panel dispose, `cancel()`, and
      the turn's `finally`. A session constructed without `onClarify` never asks at all —
      the escalation ladder tops out at guidance — which is the configuration benchmarks
      and detached runs use. Both directions are tested.
- [x] **Dependency review** — production tree empty; every `devDependency` is a test,
      lint, or packaging tool, none bundled into the `.vsix`. The `overrides` added for
      SAST-002 affect only the dev tree.

## 6. Sign-off

- [x] All Critical/High findings resolved. **For the first time, none are accepted with
      a standing risk**: SAST-002 is fixed rather than deferred, SAST-005 is closed, and
      SAST-004 is downgraded to Info as the deliberate single `child_process` call behind
      the allow-list, the metacharacter screen, and the permission gate.
- [x] Manual checklist reviewed with evidence recorded above rather than asserted.
- [ ] **retire.js was not run this pass.** It is not installed, and fetching it would mean
      `npx retire` — downloading and executing a package from the registry, which is the
      exact behaviour SAST-005 exists to require a decision about. Running it silently
      inside the pass that closed that finding would have been the wrong way to close it.
      Its value here is also low: it scans dependencies, the production tree is empty, and
      `npm audit` reports zero across the full tree. **To run it deliberately:**
      `npm i -D retire && npx retire --path app`.

**Reviewer signature:** `_______________`
**Date:** `_______________`

## 7. Reproducing this pass

```bash
npm ci
npm run lint
npm audit --omit=dev
npm audit
npm run test:unit
npm run test:integration
semgrep --config p/javascript --config p/security-audit --metrics=off app
```

`--metrics=off` keeps the Semgrep run from reporting usage back to the registry, which
matters for a project whose main promise is that nothing leaves the machine. The rule
packs are fetched on first use and cached under `~/.semgrep`; point `--config` at that
cache to keep later runs fully offline.

On this machine Semgrep is installed under Python 3.14 and `python -m semgrep` prints a
deprecation notice and exits **without scanning** — a silent no-op that reads like a
clean run. Invoke the executable directly.
