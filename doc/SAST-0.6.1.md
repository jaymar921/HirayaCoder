# SAST report — 0.6.1

Run against the `fix/0.6.1-os-aware-scripts` branch. **Nothing here blocks the 0.6.1
release**: no finding is exploitable by a remote party, and the two that matter are
pre-existing behaviours rather than anything 0.6.1 introduced. They are recorded here to
be fixed in **0.7.0**.

## What was run

| Pass | Tool | Result |
|---|---|---|
| Dependency audit, runtime | `npm audit --omit=dev` | **0 vulnerabilities** — the extension ships no runtime dependencies at all |
| Dependency audit, full | `npm audit` | 3, all dev-only and all reached through `mocha` |
| Static analysis | `eslint-plugin-security`, `eslint-plugin-no-unsanitized` | 0 errors, 18 warnings, all reviewed below |
| Manual review | the 0.6.1 diff, the script path, the new filesystem writes | 3 findings |

---

## To fix in 0.7.0

### 1. `npx` reaches the network and never asks — HIGH, pre-existing

`scriptRunner.ALWAYS_CONFIRM` exists so that *"a handful of allow-listed subcommands
publish code or reach the network"* always cost a click, even under auto-approve. It
covers `git push/clone/fetch/pull`, `npm publish/login`, and `ollama pull`. It does not
cover `npx`, which is on the default allow-list and whose entire purpose is to download a
package from the npm registry and execute it.

`NON_INTERACTIVE_ENV` sets `npm_config_yes: 'true'`, which is what suppresses npx's own
*"Ok to proceed?"* prompt. Together that is: arbitrary remote code, fetched and run, with
no confirmation from anyone, in an extension whose headline claim is that it works fully
offline.

This is not theoretical. `.ignore/3.todo-app-0.6.0/.hirayacoder/audit.log` line 7:

```json
{"action":"run_script","decision":"auto-approved","command":"npx create-vite@latest todo-glass-app -- --template react"}
```

A package was downloaded and executed on a live run, auto-approved, and the log records it
as routine. The command was the right one and the package was the real one — the problem is
that nothing checked, and the same path takes any package name the model emits.

0.6.1 makes `npm exec` and `npm x` behave consistently with `npx` (see the pre-flight
change), which does not widen the hole — `npx` was always there — but it does mean the fix
must cover all four spellings.

**Suggested fix:** add `npx`, `npm exec`, `npm x`, `yarn dlx`, `pnpm dlx`, and `npm create`
to `ALWAYS_CONFIRM` with the reason *"this downloads and runs a package from the internet"*.
Scaffolding is a once-per-project action, so the cost is one click on the run where it
matters and none on the rest.

### 2. `workspaceBootstrap` writes two files without going through `pathGuard` — LOW, new in 0.6.1

`ensureGitignore` and `environmentProfile.persist` do `fs.appendFileSync` /
`fs.writeFileSync` on `path.join(workspaceRoot, …)` directly. Every other write in the
extension goes through `pathGuard`, which has an `assertRealPath` stage precisely because
*"a lexically-clean path like `docs/notes` can still be a symlink pointing at
`/etc`"* — and neither of these paths gets that check.

Reaching it requires the user to have opened a workspace whose `.gitignore` is already a
symlink pointing somewhere they did not intend, which is a strange thing to arrange for
yourself. It is a real inconsistency with the module that exists to make this decision in
one place, and it costs two lines to close.

**Suggested fix:** route both through `pathGuard.assertRealPath`, and skip the write with a
logged warning when it fails.

### 3. Dev-only advisories in the `mocha` tree — MODERATE, dependency

`serialize-javascript` (high, RCE), `diff` (low, DoS), both reached only through `mocha`,
which is a `devDependency`. `npm audit --omit=dev` reports zero, and `.vscodeignore`
excludes `test/**` and `node_modules`, so none of it is in the `.vsix` or in anything a
user runs. The exposure is to whoever runs `npm test` on a checkout.

`npm audit fix --force` moves to `mocha@11.3.0` and calls it a breaking change. Worth doing
deliberately in 0.7.0 with the suite green, not as a drive-by.

---

## Reviewed and dismissed

- **`security/detect-unsafe-regex` (11 warnings).** Includes `runScript.js:252`, the new
  `unchainCd` pattern. Its nested quantifier is unambiguous — the inner alternative
  requires a literal `/`, which the character class excludes — so there is no backtracking
  explosion. Measured at 50,000 characters of adversarial input: **1 ms**. The other ten
  are pre-existing and were checked the same way.
- **`security/detect-object-injection` (3).** All three index into a fixed, code-owned map
  or array; none takes its key from model output or from a file. The new
  `PROJECT_CREATING_SUBCOMMANDS` lookup was written as a `Map` specifically so it does not
  add a fourth.
- **`security/detect-non-literal-regexp` (4).** `projectOverview` and `ignoreRules` build
  patterns from workspace filenames. Worth keeping an eye on, but both are bounded by
  filename length and neither pattern is ambiguous.
- **`no-unsanitized` — no findings.** The webview still builds every node with
  `createElement` + `textContent`. No `innerHTML` anywhere in `app/`.
- **The `unchainCd` rewrite path.** The rewritten command reaches the gate, so the
  confirmation prompt, the audit log, the allow-list, and `ALWAYS_CONFIRM` all see what
  will actually run rather than what the model typed. The folder is composed only from a
  character class that cannot express `..` and is rejected outright if a segment is `.` or
  `..`, then confined by `pathGuard` like every other `cwd`.
- **The pre-flight exemption.** It removes a check on `npm create`/`init`/`exec`/`x` only.
  `npm install` — the command that actually climbs out of the workspace, and the one that
  once installed a dependency into this extension's own `package.json` — is guarded
  exactly as before, and there is a test pinning that.
- **Loopback enforcement.** `assertLoopbackEndpoint` still rejects any non-loopback host,
  covering the whole `127.0.0.0/8` range rather than just `127.0.0.1`.
