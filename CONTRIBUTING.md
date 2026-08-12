# Contributing to HirayaCoder

Contributions are welcome. This document is the short version of what "done" means
here, and the rules are stricter than they look — mostly because this project ships
software that **edits and deletes files on a user's machine**, and because almost every
serious bug in it was found by running a real model rather than by a test.

---

## The one hard rule: pull requests only

**Never push to `main`.** Not for a typo, not for a one-line fix, not as the maintainer.

```bash
git checkout -b fix/short-description
# … work …
git push -u origin fix/short-description
# then open a pull request
```

Every change reaches `main` through a pull request that CI has passed. CI runs on
Ubuntu, macOS, and Windows, and it is the *only* evidence this project has that anything
works on the two platforms the maintainer does not own. A direct push skips that
entirely, and the failure it hides is usually a platform one.

Branch names: `feat/…`, `fix/…`, `docs/…`, `test/…`, `chore/…`. Commit messages follow
the same prefixes (`feat:`, `fix:`, `docs:`…), since the release notes are generated
from them.

## Before you open a pull request

```bash
npm install
npm run test:all      # lint + 590 unit tests + 15 integration tests
```

`test:all` downloads a real VS Code the first time (~330 MB) and runs the integration
suite inside it. On Linux you need a display: `xvfb-run -a npm run test:integration`.

A pull request should also say **what you ran it against**. "Tests pass" is necessary
and not sufficient — see below.

## If you touched the agent loop, prompts, translator, or tools

Run a real model before calling it done:

```bash
node tools/bench-agent.js gemma4:e2b agent auto full
```

This is not ceremony. The mocked test suite has passed clean while a real model
destroyed a real file, repeatedly — deleted exports, a silently switched module system,
an implementation replaced by `module.exports = { name: '' }`. Every guard in
`app/agent/tools/writeFile.js` is named after the specific failure that produced it, and
none of them came from a unit test.

**Judge a run by whether the workspace ended up worse, not by whether the model
finished.** A guard firing and the session stopping is the system working.

Paste the outcome into the pull request: the model, the task, the time, and what the
file looked like afterwards.

## Rules that are not negotiable

These encode decisions that were expensive to learn. If you think one is wrong, open an
issue and argue the case — but don't quietly route around it in a pull request.

- **Nothing leaves the machine.** The endpoint is loopback-enforced at client
  construction, before any socket opens. No telemetry, no analytics, no crash reporting.
- **Every write, delete, and command goes through `security/permissionGate.js`.** It is
  the single chokepoint, and it is what makes "did anyone approve this?" answerable by
  reading one file.
- **Never trust the model's account of itself.** Completion is judged from evidence —
  did the change set grow, did a step fail — never from the model saying it finished.
- **`think: false` on every structured-output call.** Hybrid reasoning models otherwise
  return empty content with the whole budget spent in `message.thinking`. This has
  broken the project twice.
- **No `innerHTML` in the webview, ever.** `createElement` + `textContent`. Everything
  rendered there originated in a model or a file a model read.
- **No new production dependencies** without a justification in
  `security/threat-model.md`. The shipped tree currently has zero, which is what makes
  `npm audit --omit=dev` meaningful rather than lucky.
- **The learning layer may never weaken a guard or a permission prompt.** See
  `doc/SELF-OPTIMIZATION.md`.

## Style

- **Comments explain *why*, not *what*.** The most useful documentation in this
  repository is the comment above each guard naming the live failure that produced it.
  Match that.
- Match the surrounding code's density and idiom rather than importing your own.
- `npm run lint` must be clean. Warnings are reviewed, not suppressed: if you add an
  `eslint-disable`, the comment has to say why it is safe.

## Adding a model to the matrix

```bash
ollama pull <model>
node tools/bench-agent.js <model> agent auto simple
node tools/bench-agent.js <model> agent auto full
```

Run one at a time with nothing else competing, record the `ollama ps` split, and add a
row to `doc/MODELS.md` **naming the machine it ran on**. A timing without its hardware
is not a measurement. Do not overwrite another machine's numbers; add a column or a
table.

Then run the build benchmark, which starts from an empty folder rather than a fixture
and grades adding, reading, running, and modifying files separately:

```bash
node tools/bench-build.js <model> --machine <A|B|C> --notes "<ollama ps split>"
```

It writes one JSON file into `benchmarks/results/<your machine>/`. **Commit that file
unedited** — it is generated, and the tables in `README.md` and `doc/MODELS.md` are
compiled from it afterwards. Because every machine writes only into its own directory
and never appends to a shared file, three people can benchmark simultaneously and every
branch merges into `main` without a conflict. Protocol:
[benchmarks/README.md](benchmarks/README.md).

## Reporting a security issue

Please do not open a public issue for anything that would let the agent escape the
workspace, bypass the permission gate, or reach the network. Contact
[jaymar921](https://github.com/jaymar921) directly. See `security/threat-model.md` for
what is already in scope and deliberately accepted.

## For maintainers: enforce this in GitHub

The pull-request rule is a convention until the repository enforces it. On GitHub:

**Settings → Branches → Add branch ruleset** for `main`:

- Require a pull request before merging
- Require status checks to pass — select the three `Verify / ubuntu-latest`,
  `macos-latest`, and `windows-latest` jobs
- Require branches to be up to date before merging
- Block force pushes
- Include administrators, so the rule applies to you too

Releases are tagged, never pushed to `main` directly:
`git tag v0.2.0 && git push origin v0.2.0` runs `.github/workflows/release.yml`, which
verifies on all three platforms before it packages anything.
