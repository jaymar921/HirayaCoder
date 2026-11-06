# HirayaCoder: SAST Report

**Date:** 2026-10-09, dependency audit and unit suite re-run 2026-11-06 before release
**Commit / version:** `1.2.0`, branch `feat/1.2.0`
**Performed by:** 1.2.0 hardening pass
**Platform:** Windows 11 Pro 26200, Node v24.11.1, ESLint 9.39.5

Supersedes `security/sast-report-2026-08-21-1.1.0.md`. Every finding carried forward from it
is re-stated below with its current status.

1.2.0 adds no new permission, tool route to the disk, network path or process. What it adds
is a lot of **text processing over file contents and model output**: four new modules
(`codeShape`, `editRegion`, `contextWindow`, `tools/editFile`) and 138 new or changed regular
expressions, plus two new places that read a workspace file and put part of it in a prompt.
So most of this pass went into measuring regexes and checking that every new path from a
file to the model redacts the way `read_file` does. Two of the three findings that changed
shipped code came from that second check.

## 1. Tooling Run

| Tool | Command | Scope | Result |
|---|---|---|---|
| ESLint (security rules) | `npm run lint` | `/app`, `/test` | **0 errors, 85 warnings**, up from 42. All 43 new ones reviewed (SAST-025, SAST-026) |
| npm audit (production) | `npm audit --omit=dev` | shipped tree | **0 vulnerabilities** |
| npm audit (full) | `npm audit` | incl. dev tree | **0 vulnerabilities** on 2026-11-06, after clearing 13 dev-only advisories (SAST-027) |
| retire.js | not run | `/app` | Not run this pass. It needs an `npx` install, and `/app` still vendors no third-party JavaScript |
| Semgrep 1.172.0 | `semgrep --config p/javascript --config p/security-audit --metrics=off app tools` | `/app`, `/tools` | 7 findings, 6 locations, all `detect-child-process` (SAST-004, SAST-017) |
| Package contents | `npx vsce ls` | shipped `.vsix` | 101 files (97 plus the 4 new modules); **0** from `node_modules/`, `test/`, `tools/`, `benchmarks/` |
| ReDoS measurement | harness over every regex literal, §3 | 22 changed or new files, 240 literals | 5 super-linear patterns on reachable input, all fixed (SAST-022 to SAST-024) |
| Manual review | checklist in §4 | `/app`, `/security` | complete |
| Unit suite | `npm run test:unit` | `/app` | **1709 passing, 2 pending** |

The production dependency tree is still empty (`"dependencies": {}`).

## 2. Findings Summary

| Severity | Count | Resolved | Accepted Risk (with justification) | Open |
|---|---|---|---|---|
| Critical | 0 | 0 | 0 | 0 |
| High | 1 | 0 | 1, intended design (SAST-004) | 0 |
| Medium | 0 | 0 | 0 | 0 |
| Low | 5 | 4 | 1 (SAST-017) | 0 |
| Info | 4 | 1 | 3, measured or reviewed (SAST-003, SAST-025, SAST-026) | 0 |

No finding touched a permission, the path guard, or the allow-list, and `app/security/` has
no changes in this release. SAST-027 was left open by the hardening pass and closed before
release, with scoped `overrides` rather than a major version of either tool.

## 3. Findings Detail

| ID | Tool | File:Line | Description | Severity | Status | Resolution / Justification |
|---|---|---|---|---|---|---|
| SAST-021 | Manual review, this pass | `app/agent/agentSession.js` (`_dictateEdit`), `app/agent/tools/editFile.js` (`EDIT_NOT_FOUND`) | **File contents reached the model unredacted on two new paths.** `read_file` passes everything through `redact` before the model sees it. The dictated edit reads the named file itself and sends the region, a related function and the file's signatures. And a missed `edit_file` answers with the closest lines of the file. Neither redacted. A key on or near the lines being edited went to the model as-is. | Low | **Resolved** | The two paths need different fixes. **`edit_file`'s refusal** is now redacted, the same as a `read_file` result: the model sees `[REDACTED:…]` and cannot copy that into `find`, which is correct. **The dictated edit** cannot simply redact, because the model's answer is written back over the lines it was shown, so a redacted region would put the marker in the file in place of the real key. So a file that holds anything the scanner redacts is not dictated at all: it goes to the ordinary loop, which reads it through `read_file`. Checked that neither benchmark fixture trips the scanner, so this does not quietly disable dictated edits. Both covered by tests that fail with the fix removed. Same class as SAST-020, and found the same way: by asking of each new path from a file to a prompt whether it goes through `redact`. The model is local, so nothing left the machine either way. |
| SAST-022 | ReDoS harness, this pass | `app/agent/dictation.js` (`outOfScope`, the declared-name pattern) | **Quadratic on one line of a workspace file.** `^(?:export[ \t]+)?(?:keyword)?[ \t]*(name)` gives two ways to spend one run of spaces after `export`. It runs on every line of a file up to 256 KB. Measured: `export` and 16,000 tabs, 284 ms; 64,000, 4.4 s; **200,000, 44 s**, blocking the extension host. Reachable from any file in the workspace that a request names, including one from a cloned repository. | Low | **Resolved** | The keyword now requires a space after it, so each run of spaces has one owner: 0.48 ms at 200,000. The same pattern was **also wrong on ordinary code**: with no space required, `constant = 1` read as the keyword `const` declaring `ant`, `letter` as `ter`, `classes` as `es`. A new line that used `constant` was then refused as out of scope. Both behaviours covered by tests. |
| SAST-023 | ReDoS harness, this pass | `app/core/editRegion.js` (`withExports`), `app/agent/dictation.js` (`extractEdit`, two sites; `extractCode`, one site) | **`/\s+$/` trims.** V8 retries the pattern from every position in a run of whitespace that something else follows, so it grows with the square of the run. On a 200,000-character line, **33.7 s**. `withExports` runs it on a line of the user's file. The `dictation` sites run on model replies, which `num_predict` bounds (about 24,000 characters at worst, roughly half a second). | Low | **Resolved** | Replaced with `trimEnd()`, which strips exactly the characters `\s` matches (checked on every Unicode space and line terminator) and is linear: under 0.01 ms at 200,000. The `extractCode` site predates 1.2.0 and is bounded by `MAX_CODE_CHARS`; it was changed anyway because the fix is one word and identical in effect. |
| SAST-024 | ReDoS harness, this pass | `app/core/contextTranslator.js` (`asksForMore`) | Splitting a request on joining words with `\s+(?:and\|then\|…)\s+`. Every position in a long run of spaces scanned to its end. Input is the user's own request, sliced to 20,000 characters, so the worst case was **0.34 s per turn**. | Info | **Resolved (hardening)** | The spaces are bounded to `\s{1,40}`: 5.7 ms at 20,000. Splits identically on ordinary requests (checked on a multi-clause sample). Covered by a timing test. |
| SAST-025 | ESLint `security/detect-unsafe-regex` | 24 new sites: `codeShape.js` (15), `dictation.js` (5), `editRegion.js` (2), `contextTranslator.js` (1), `agentSession.js` (1) | Patterns with adjacent optional groups, in the new parsing code. | Info | **Accepted, measured** | **Measured, not argued**, per the standing rule from 0.7.0. A harness parsed every regex literal in the 22 new or changed files (240 in all) and ran each against pumped input: 60 pump strings, every word in the pattern as a prefix, four suffixes, at 4,000 and 16,000 characters. Every pattern ESLint flagged in the new modules stayed under 2 ms at 4,000 characters, i.e. linear. Most had been fixed during development (the comments in `codeShape.js` and `dictation.js` record the measurements: one took 17 s on 80,000 blank lines before `^\s*` became `^[ \t]*`). The super-linear patterns the harness did find were mostly **not** flagged by ESLint; the reachable ones are SAST-022 to SAST-024, and the rest run on input capped well below where they matter (a 160-character filename candidate, a 180-character phrase, a 2,000-character export list, a 4,000-character related file, a path under `MAX_PATH_LENGTH` with no newlines). |
| SAST-026 | ESLint `security/detect-object-injection` | 18 new sites: `editRegion.js` (14), `editFile.js` (3), `agentSession.js` (1) | Bracket access with a computed key. | Info | **Accepted, reviewed** | Every one is a numeric index into a local array of lines (`lines[index]`, `lines[best]`, `lineWords[best]`), counted by a loop or returned by `findIndex`. No string key from a file, the model or the settings reaches any of them. |
| SAST-027 | `npm audit` | `package-lock.json` (dev tree) | **New advisories since 1.1.0, dev dependencies only.** `brace-expansion` (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p: quadratic expansion and unbounded recursion), pulled in by ESLint and Mocha. `braces` (GHSA-vfj7-8cjw-p6xm, stack exhaustion), pulled in by `@vscode/vsce` through `secretlint`, `globby`, `fast-glob` and `micromatch`. | Low | **Resolved** | Not shipped: production dependencies are empty and `vsce ls` lists nothing from `node_modules/`. By 2026-11-06 the count had grown to 13 (7 high, 5 moderate, 1 low), all in the dev tree. `braces` was no longer among them. `npm audit fix` cleared 9, including `brace-expansion`, `undici` and `markdown-it`, with no breaking change. The last 4 were `glob` and `minimatch` under Mocha and `@vscode/vsce`. Current Mocha 12 still asks for a vulnerable `glob`, so upgrading would not have fixed it. They are pinned with `overrides` scoped to those two tools (`glob` ^14.0.3, `minimatch` ^11.0.5), the approach 0.7.0 used for Mocha, and ESLint keeps its own `minimatch` 3. `npm audit` reports zero, and lint, the unit suite and `npm run package` pass with the pins. Remove the pins once both tools depend on fixed versions themselves. |
| SAST-017 | Semgrep `javascript.lang.security.detect-child-process` | `tools/bench-build.js:290`, `tools/bench-realworld.js:99`, `tools/lib/javaProbe.js:44`, `tools/lib/pythonProbe.js:351`, and new: **`tools/bench-edit.js:103`** | `spawnSync` in the benchmark harnesses. | Low (rule) | **Accepted** | Developer tooling, not shipped. The new site runs `node -e` or `python -c` with a check from the fixture against the file the model edited, so it **executes model-written code on the developer's machine**. That is what grading by running means, and it is the same as `bench-build`. The bounds are a fresh temporary directory per task, a 10-second timeout, an argument array with no `shell`, and a file whose only author is a local model working on a 164-line fixture. Run it on a machine where that is acceptable. |
| SAST-004 | Semgrep `javascript.lang.security.detect-child-process` | `app/security/scriptRunner.js:451` | Carried forward. `spawn()` reached from the `command` and `options` arguments. Impact HIGH, **confidence LOW**. | High (rule) | **Accepted, unchanged** | The only `child_process` call in shipped code, in the module that exists to make it safe: argument array with `shell: false`, `argv[0]` checked against the allow-list, shell metacharacters rejected, Windows `.cmd` shims pre-screened, and a `permissionGate` approval required. Unchanged by 1.2.0. |
| SAST-003 | ESLint `security/detect-unsafe-regex` | 22 sites across `/app` | Carried forward. | Info | **Accepted, unchanged** | Re-covered this pass by the SAST-025 harness wherever the file changed. |
| SAST-014 | Prior pass | `app/agent/stepBrief.js` | Carried forward, **fixed in 1.0.0**. | | **Closed** | Its bound and timing test are present and passing. `contextTranslator.ANCHOR`, new in 1.2.0, has the same shape and was written bounded from the start, with a comment citing this finding. |

## 4. Manual Review Checklist

Items unchanged by this release are marked *(unchanged)* and were re-verified rather than
re-argued.

- [x] **Command injection** *(unchanged)*. `child_process` is imported in exactly one shipped
      file, `security/scriptRunner.js`. (`core/missingDeps.js` contains the string only as a
      Node builtin name in a list.) No 1.2.0 module opens a process.
- [x] **Path traversal: the new file reads.** Two new reads put workspace content in a prompt.
      `agentSession._singleNamedFile` reads a file the user's request names; `fileHistory._shapeOf`
      reads a file the session changed. Both go through `pathGuard.resolvePath` and then
      `assertRealPath`, so a symlink cannot reach outside the workspace, then `stat` with a
      256 KB cap **before** the read, and a NUL-byte check after. A name that fails any of
      these is skipped, not reported, because plenty of words in a request look like filenames.
- [x] **The new write route.** None. `edit_file` reads through `gate.requestRead` and writes by
      calling `writeFile` with the full new content, so the gate, the diff the user approves,
      every content guard and the audit entry are the same as for `write_file`. Verified by a
      test in which the user declines and the file stays unchanged. The dictated edit applies
      its result through `_execute` as an ordinary `edit_file` action.
- [x] **Secrets on the new paths.** SAST-021. Also checked: the signature lines `fileHistory`
      adds to memory are redacted before `codeShape` reads them and neutralised before they
      are stored, and the memory note the panel shows is the same text the prompt got.
- [x] **Model output crossing into the file.** The dictated edit's answer is checked before it
      is written: no dropped comparison, no name that does not exist at the insertion point,
      no placeholder comment, no JSON action object, no reply far longer than its region. Then
      `writeFile`'s guards run as for any write. These are correctness guards, but they are
      also what stops a confused reply from being written over working code.
- [x] **The webview.** `messageBubble.appendMemoryNote` and the new context reading build with
      `createElement` and `textContent`; there is no `innerHTML` in the file. Memory lines are
      neutralised before they are stored and stay text here.
- [x] **The new setting.** `hirayacoder.ollama.contextLength` is a number the user sets for
      their own machine. It is floored at 2,048 and capped at the model's own trained maximum.
      A very large value costs the user memory on their own GPU; it opens nothing.
- [x] **The network path** *(unchanged)*. `num_ctx` is a field in the body of a request the
      loopback-only client already sends. No new endpoint, host or protocol.
- [x] **Denial of service.** SAST-022 to SAST-024, measured. The new reads are size-capped
      before reading. The dictated edit is at most three model calls with `num_predict` 1,500
      and a three-minute timeout each.
- [x] **Permissions and path confinement** *(unchanged)*. No change under `app/security/`.
- [x] **Shipped artefact contents.** `npx vsce ls` reviewed in full: 101 files, the 4 new being
      the 4 new modules. `tools/lib/cartFixture.js`, `tools/lib/inventoryFixture.js` and the new
      benchmark results are not packaged.

## 5. What Changed Since 1.1.0

- **New modules reviewed in full:** `app/core/codeShape.js`, `app/core/editRegion.js`,
  `app/core/contextWindow.js`, `app/agent/tools/editFile.js`.
- **Modified and re-reviewed:** `agentSession.js`, `dictation.js`, `errorRecovery.js`,
  `nativeToolLoop.js`, `reactLoop.js`, `toolRegistry.js`, `tools/writeFile.js`,
  `workingSet.js`, `contextTranslator.js`, `fileHistory.js`, `modelCapability.js`,
  `ollamaClient.js`, `outputParser.js`, `promptRouter.js`, `extension.js`, `chatTab.js`,
  and the webview (`index.html`, `main.js`, `style.css`, `components/messageBubble.js`).
- **New developer tooling, not shipped:** `tools/bench-edit.js`, `tools/lib/cartFixture.js`,
  `tools/lib/inventoryFixture.js`.
- **Fixes with a security dimension:** SAST-021 (two unredacted paths from a file to the
  model), SAST-022 and SAST-023 (patterns that could block the extension host for tens of
  seconds on one long line), SAST-024 (hardening).

## 6. Residual Risk

Unchanged from 1.1.0 in kind, with one addition:

- **`scriptRunner` runs programs.** By design, allow-listed, shell-free and gated.
- **Images are shown to a local model.** As in 1.1.0.
- **Hand-written text processing over untrusted text.** New this release in volume rather than
  in kind. 138 regexes were added or changed in code that parses files and model replies, and the harness in this pass
  tests them with a fixed set of pump shapes, not every possible input. A pattern it does not
  pump the right way could still be slow on some input. The bounds at the call sites (file
  size caps, `num_predict`, slice lengths) are what limit the damage when that happens, so
  keep them when changing these modules, and re-run the measurement when adding a pattern.
