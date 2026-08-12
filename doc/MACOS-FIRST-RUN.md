# macOS first run (Machine C)

The first time a human installed and exercised the packaged extension on macOS. CI had
run the automated suites on macOS since the beginning; nobody had used it.

**Date:** 2026-08-12
**Machine:** MacBook Pro 16-inch, M4 Pro, 24 GB unified, macOS (Darwin 25.3.0)
**Build:** v0.1.0, `builds/v0.1.0/hirayacoder-0.1.0.vsix`, installed with
`code --install-extension`
**Node:** 24.13.0 **Ollama:** 0.32.9

## Automated suites

`npm run test:all` — lint + 598 unit + 15 integration — **passes on macOS.**

The integration suite launches against a real VS Code. The handoff flagged the macOS
binary path inside `Visual Studio Code.app/Contents/MacOS/` as *predicted* by the
downloader rather than checked, with a resolver in `test/integration/runTests.js` that
reports the directory's real contents when the prediction is wrong. **That resolver did
not fire.** The predicted path was correct on this machine and VS Code version, so the
fallback remains untested by a real failure.

## Packaging

`npm run package` produces the `.vsix` cleanly (66 files, 228.58 KB). Re-running it
without `--force` exits non-zero and refuses to overwrite a populated `builds/v0.1.0/`,
which is the intended guard rather than a failure.

`setup/prompts/**` is present in the package and **should be** — `promptLoader.js` reads
those at runtime. `setup/*.md`, including the handoff documents, is correctly excluded.
Verified with `vsce ls --tree` against `.vscodeignore`.

## Checks that do not need the GUI

Run with a harness driving `app/security/scriptRunner.js` and `app/security/pathGuard.js`
directly. All security-relevant checks pass.

| Check | Result |
|---|---|
| `npm test` through the runner | **pass** — exit 0, output captured |
| Workspace path containing a space (`My Projects …`) | **pass** — `npm test` runs correctly from it |
| `node --version` through the runner | **pass** |
| `rm -rf .` | **pass** — refused, `BINARY_NOT_ALLOWED` |
| `../secret.txt` traversal | **pass** — refused, `OUTSIDE_WORKSPACE` |
| `../SECRET.TXT` (case-variant escape) | **pass** — refused, `OUTSIDE_WORKSPACE` |
| `../../<ROOT-UPPERCASED>/secret.txt` | **pass** — refused, `OUTSIDE_WORKSPACE` |
| `SRC/app.js` (case-variant path *inside* the workspace) | **pass** — accepted, which is what `foldCase` on `darwin` is for |

The path-with-a-space case is the one that had actually broken on Windows. It is clean
here, both for the workspace root and for `npm test` executed inside it.

## Two corrections to the handoff

**1. macOS does not take a `/bin/sh -c` path.** The handoff
(`setup/FOLLOWUP-PROMPT-MACOS.md`, item 5) says macOS takes the `/bin/sh -c` path in the
script runner. It does not. In `app/security/scriptRunner.js` the shell wrapper is
reached only when `isShim` is true, and `isShim` requires `isWin` — it exists solely for
`.cmd`/`.bat` shims on Windows, per CVE-2024-27980. On macOS every allowed binary is
spawned directly with `shell: false`. The macOS path is *simpler* than Windows, not a
separate untested branch. Item 5 was still worth running, but not for the stated reason.

**2. The module paths in the handoff are wrong.** It refers to `security/scriptRunner.js`
and `security/pathGuard.js`. Both live under `app/security/`. The top-level `security/`
directory holds the threat model and SAST reports, not code.

Neither is a code bug; both are corrected here rather than by editing the handoff, which
is a historical document.

## Not verified

**`javac` / `java` (handoff item 9) could not be exercised.** No JDK is installed on this
machine — `/usr/bin/java` and `/usr/bin/javac` exist but are Apple's stub shims, and
`/usr/libexec/java_home -V` reports no runtime. The handoff makes this item conditional
on a JDK being present.

What *was* verified is the part the allow-list controls: `javac` resolved on `PATH`,
passed the allow-list, and was spawned — execution reached the stub, which then reported
no Java runtime. So the allow-list change from commit 8108029 works on macOS; only the
actual compile-and-run is untested. **Install a JDK and re-run this one.**

## Still needs a human at the GUI

These require driving the VS Code UI and are **not yet done**. They are the remaining
half of "be the first human to use it on macOS":

1. **Activation** — status bar connection, and the activity-bar icon legible in both
   light and dark themes. It is monochrome line art recoloured by the theme, so a solid
   block or blank square is a bug.
2. **`Cmd+Shift+H`** opens the chat tab, and the tab carries the icon.
3. **An Agent-mode edit** with the **Review diff** button, which should open VS Code's
   own diff viewer.
4. **A declined delete** — the summary must say it was not deleted. The benchmark sweep
   confirms the underlying judge works (two models claimed a declined delete had
   succeeded and were caught), but the *rendered summary* has not been read on macOS.
8. **Close a chat tab and reopen the session** from the activity bar; the conversation
   should still be there. The integration suite covers session restore programmatically,
   but not through the UI.
