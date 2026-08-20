# HirayaCoder — SAST Report

**Date:** 2026-08-19
**Commit / version:** `0.9.0`, branch `feat/0.9.0`
**Performed by:** 0.9.0 release pass
**Platform:** Windows 11 Pro 26100, Node v24.11.1

Follows `security/sast-report-2026-08-14-0.7.0.md`, whose findings are all closed and
stay closed.

## 1. Tooling Run

| Tool | Command | Scope | Result |
|---|---|---|---|
| ESLint (security rules) | `npm run lint` | `/app`, `/test` | **0 errors, 34 warnings** (all reviewed, §4) |
| npm audit (production) | `npm audit --omit=dev` | shipped tree | **0 vulnerabilities** |
| npm audit (full) | `npm audit` | incl. dev tree | **0 vulnerabilities** |
| retire.js 5.4.3 | `npx retire --path app` / `--path tools` | shipped + dev harnesses | **0 findings** |
| retire.js 5.4.3 | `npx retire --path .` | whole checkout | 4 findings, all in `.vscode-test/` — see §6 |
| Manual review | checklist in §5 | `/app`, `/tools` | complete |
| Unit suite | `npm run test:unit` | `/app` | 1,418 passing |

The production dependency tree is still empty (`"dependencies": {}`), which is what makes
the `--omit=dev` result meaningful rather than lucky.

## 2. What is new in this release, from a security point of view

0.9.0 adds one thing that deserves scrutiny on its own terms: **the extension can now
write a file the model never asked to write.** `agent/dictation` composes the
`write_file` action itself, taking the path from the user's request and asking the model
only for the contents.

That reads like an increase in authority and it is the opposite. The comparison that
matters is against the existing path, where the *model* chooses both the action and the
path:

| | Ordinary loop write | Dictated write |
|---|---|---|
| Who chooses the action | the model | the extension (`write_file`, always) |
| Who chooses the path | the model | the user's own request text |
| Path guard (`pathGuard`) | yes | yes — same call |
| Permission gate / diff approval | yes | yes — same call |
| Change set, file history, audit log | yes | yes — same call |
| Can target a path nobody named | **yes** | no |

Every dictated write goes through `AgentSession._execute`, which is the same function the
loop calls. Nothing is bypassed. One degree of freedom is removed, and it is the one that
could previously point at an arbitrary path.

Additional constraints, each pinned by a test in `test/unit/structuredRequest.test.js`:

- Only for items read from the **request's own structure**; a model-proposed checklist
  never dictates.
- Only on the constrained tier.
- Never `package.json`, lockfiles or `.env`, and never anything under `node_modules/`,
  `dist/`, `build/`, `out/`, `coverage/` or `.git/`.
- Never an **existing** file unless the user annotated it in their own folder tree.
- Capped at 12 files per step.

## 3. Findings Summary

| Severity | Count | Resolved | Accepted Risk (with justification) |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 0 | 0 | 0 |
| Medium | 1 | **1** | 0 |
| Low | 1 | **1** | 0 |
| Info | 2 | 0 | 2 — §4 and SAST-013 |

Both findings were opened and closed inside this pass. Neither came from a scanner:
SAST-011 came from measuring a regex this pass had just written, and SAST-012 from
reading the new parser against the threat model rather than against its tests.

## 4. Findings Detail

| ID | Tool | File:Line | Description | Severity | Status | Resolution / Justification |
|---|---|---|---|---|---|---|
| SAST-011 | Manual + measurement | `app/agent/agentSession.js` (`DICTATABLE_FILENAME`, now removed) | The filename check written earlier in this same release was `[\w@.-]*[\w-]{2,}[\w@.-]*\.[a-z][a-z0-9]{1,7}$` — three adjacent variable-length classes over overlapping character sets, followed by a literal a non-matching input never reaches. Quadratic-or-worse backtracking, measured against a run of `a` with no dot in it: 400 chars 19 ms, 800 chars 196 ms, 1,600 chars 1.4 s, **3,200 chars 10.6 s**. The input is a path-like token taken out of the user's own request, so the impact is a frozen extension rather than a compromise — but a pasted spec containing one long unbroken token would hang the UI thread. | **Medium** | **Resolved** | Replaced with `isDictatableFilename`, which splits on the last `/` and the last `.` and checks the two halves separately. Every step is linear and the extension is bounded to eight characters before any regex sees it. Same input through the shipped code path: **22.7 ms**, down from 10.6 s. The old expression is gone rather than bounded, because the bound would have been the second thing to remember. |
| SAST-012 | Manual | `app/core/fileTree.js:looksLikeEntry` | The tree reader accepted `..` as a path segment, so a drawn structure containing `../../etc/passwd` produced that as a "path inside the project". `pathGuard` refuses it on the read *and* again on the write, so nothing could escape the workspace — but the parser was returning something untrue about its own output, several layers before anything checked, and `_filesForItem` would have carried it into a dictation attempt. | **Low** | **Resolved** | `..` and `.` segments are rejected in `looksLikeEntry`, with a comment saying explicitly that this is not the control that stops traversal — `pathGuard` is — but the parser being honest about what it returns. A rejected line is skipped rather than ending the tree, so one odd line cannot silently drop the rest of the structure. Pinned by two tests. |
| SAST-013 | Manual | `app/agent/dictation.js:buildPrompt` | A dictation that rewrites an existing file includes that file's current contents in the prompt, and every dictation includes the source of neighbouring files in order to read their exports. Either could contain text intended to steer the model. | **Info** | **Accepted** | The same exposure as `read_file`, which has put workspace content into prompts since 0.1.0, and bounded more tightly than it: the output of a dictation can only ever be written to the one path already decided before the call, and the user still approves the diff. A file that could rewrite *itself* into something else is a file the user is shown a diff of. Mitigating this further would mean not reading the project, which is the product. |

### ESLint warnings

34, up from 25 at 0.7.0. Every new one is `security/detect-non-literal-fs-filename` in
`tools/` — the benchmark harness, which is developer tooling excluded from the package by
`.vscodeignore` and which by design reads and writes paths given on the command line. The
`/app` warnings are unchanged in number and character from the 0.7.0 review.

## 5. Manual Review Checklist

- [x] **Command injection** — no new `child_process` use in `/app`. `tools/lib/cdp.js`
      spawns a browser with a fixed argument array and a temp profile directory it
      created; `tools/bench-realworld.js` uses `spawnSync` with an argument array.
- [x] **Path traversal** — every new file operation goes through `pathGuard`
      (`_readInWorkspace`, `_existsInWorkspace`, and `_execute` for the write).
      `fileTree` hardened separately, SAST-012.
- [x] **SSRF / non-loopback egress** — no new network code in `/app`. The benchmark's
      static server binds `127.0.0.1` on an ephemeral port and confines every request to
      the directory it was given; the CDP client connects to `127.0.0.1` only.
- [x] **Insecure deserialization** — `dictation` never parses model output as code or
      config. `matchesPath` calls `JSON.parse` inside `try/catch` purely as a *type
      test*, and discards the result.
- [x] **Webview CSP** — untouched this release.
- [x] **Prototype pollution** — no new object construction from model-supplied keys. The
      dictation result is a string.
- [x] **Secrets handling** — `.env` and lockfiles are excluded from dictation targets
      outright. `secretsScanner` continues to run on the read path unchanged.
- [x] **Permission gate coverage** — grepped: the only new write is
      `AgentSession._dictateFiles`, which calls `this._execute`. No new `fs.write*` in
      `/app`.
- [x] **ReDoS** — every regex added this release was measured rather than reasoned
      about, which is what produced SAST-011. `fileTree.PREFIX` is a single character
      class with no nesting; `dictation.FENCE` is non-greedy with a literal terminator;
      `requestPlan.IMPERATIVE` is a fixed alternation anchored at the start.
- [x] **Dependency review** — nothing added. Still `"dependencies": {}`.

## 6. retire.js and `.vscode-test/`

A whole-checkout `retire --path .` reports four DOMPurify advisories against
`DOMPurify 3.4.8`, in:

```
.vscode-test/vscode-win32-x64-archive-1.133.0/…/workbench.desktop.main.js
.vscode-test/vscode-win32-x64-archive-1.132.1/…/workbench.desktop.main.js
```

These are inside the **VS Code binaries the integration test harness downloads**. They
are not this project's code, not its dependencies, and not shipped: `.vscode-test/**` is
the fourth line of `.vscodeignore`. The remedy is a VS Code update, which is Microsoft's
to publish and the user's to install.

Recorded rather than omitted, because a future pass running the same command will see the
same four lines and should not have to re-derive that they are out of scope. Scoped runs
against `app/` and `tools/` report nothing.

## 7. Sign-off

- [x] All Critical/High findings resolved or explicitly accepted with documented
      justification — none were opened.
- [x] Manual checklist fully reviewed.
- [x] Both new findings closed within the pass.

**Reviewer:** 0.9.0 release pass
**Date:** 2026-08-19

---

## 8. Addendum — the code added after this report was first written

The release continued past the pass above: three more briefs, two more probes, and six
more agent-side modules. This addendum covers them so the report describes the branch as
it stands rather than as it stood halfway through.

### Re-run of every scan

| Tool | Result |
|---|---|
| `npm audit --omit=dev` | **0 vulnerabilities** |
| `npm audit` | **0 vulnerabilities** |
| `npx retire --path app` | nothing |
| `npx retire --path tools` | nothing |
| `npm run lint` | 0 errors, 38 warnings (all `security/detect-non-literal-fs-filename` in `tools/`, reviewed) |
| `npm run test:unit` | 1,480 passing |

The production dependency tree is still empty. Nothing was added to `package.json` in
this release.

### Every regex added since §4, measured

The 0.7.0 report's standing instruction is to measure a flagged expression rather than
dismiss it, and SAST-011 in this report was a quadratic expression written *during* it.
So each pattern added afterwards was timed rather than reasoned about:

| Pattern | Input | Time |
|---|---|---|
| `fileTree.PREFIX` | 4,000 chars | 0.04 ms |
| `dictation.FENCE` | 20,006 chars | 0.13 ms |
| `dictation.LITERAL_TOKENS` | 4,000 chars | 0.06 ms |
| `requestPlan.FILENAME_TOKEN` | 24,000 chars | 0.37 ms |
| `pythonExports` | 16,000 chars | 0.07 ms |
| `jvmExports` | 21,000 chars | 0.20 ms |
| `fileSpec.words` | 16,000 chars | 0.13 ms |

All linear. Two were written deliberately to avoid the shape that caused SAST-011:
`requestPlan.namesFilesIn` counts matches in a loop rather than repeating a group in the
pattern, and `isDictatableFilename` does no regex matching on the variable-length part
at all.

### New surface, and why it is narrower than it looks

**`agent/dictation` now writes files in four more situations** — a marker file created
empty, an assembly rewrite, a requirement-driven retry, and a project directory created
when the request names no scaffold command. Every one of them goes through
`AgentSession._execute`, which is the same path a model-chosen write takes: `pathGuard`,
the permission gate, the change set, the file history, the audit log. No new `fs.write*`
call was added to `/app` in this release.

The path a dictation may target got **narrower**, not wider, and each restriction is
pinned by a test in `test/unit/structuredRequest.test.js`:

- An allow-list of writable extensions replaced the deny-list of binary ones — the space
  of dotted module paths is open and the space of file types is not, so `pathlib.Path`
  and `tkinter.ttk` are no longer candidates.
- `..` and `.` segments are refused by `fileTree.looksLikeEntry` (SAST-012).
- Manifests, lockfiles and `.env` remain excluded outright.
- A file that already exists is untouched unless the user annotated it in their own tree.
- A directory is created only when the request draws it as the project root *and* names
  no command that would create it — otherwise the scaffold command owns it.

**`core/namedCommands` extracts a command from the request and runs it.** This is the one
addition that executes something, and it is worth being precise about what it does not
change: the command still goes through `_execute` and the gate's allow-list, and a
scaffold command reaches the network, so it is one the gate *always* confirms regardless
of auto-approve. What is removed is the transcription step, not the approval. It reads
only from code spans and fenced blocks — never prose, because acting on a paraphrase is
how the wrong thing gets run — and returns a command only when it both matches a
project-creating binary and names the directory in question. On the four shipped briefs
it fires on one and correctly declines the other three.

**The benchmark harness grew a Java and a Python probe**, both of which compile and run
code written by a model. Both are developer tooling excluded from the package by
`.vscodeignore`, both run in a temp directory, and the Python one sets
`PYTHONDONTWRITEBYTECODE`. They execute model output by design — that is what grading it
means — and they do so in the same place the model already ran its own build.

### Findings

None. Nothing in the addendum's scope opened a new finding, and SAST-011 through
SAST-013 stand as recorded.

**Reviewer:** 0.9.0 wrap-up pass
**Date:** 2026-08-20
