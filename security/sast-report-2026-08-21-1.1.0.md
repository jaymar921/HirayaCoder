# HirayaCoder — SAST Report

**Date:** 2026-08-21
**Commit / version:** `1.1.0`, branch `feat/1.1.0-image-recognition`
**Performed by:** 1.1.0 hardening pass
**Platform:** Windows 11 Pro 26100, Node v24.11.1, ESLint 9.39.5

Supersedes `security/sast-report-2026-08-20-1.0.0.md`. Every finding carried forward
from it is re-stated below with its current status.

The release under review adds one new capability with a genuinely new shape: **an image
file, chosen by the user, base64-encoded and sent to a local model, whose free-text reply
is then placed in another model's prompt.** That is a new untrusted-input path and it is
where most of this pass went.

## 1. Tooling Run

| Tool | Command | Scope | Result |
|---|---|---|---|
| ESLint (security rules) | `npm run lint` | `/app`, `/test` | **0 errors, 42 warnings** (all reviewed, §4) |
| ESLint, changed files only | `npx eslint <the 1.1.0 diff>` | 9 files | **0 errors, 0 warnings** after SAST-016 |
| npm audit (production) | `npm audit --omit=dev` | shipped tree | **0 vulnerabilities** |
| npm audit (full) | `npm audit` | incl. dev tree | **0 vulnerabilities** |
| retire.js 5.4.3 | `npx retire --path app` | `/app` | **no findings** |
| Semgrep 1.172.0 | `semgrep --config p/javascript --config p/security-audit --metrics=off app tools` | `/app`, `/tools` | 6 findings, 5 locations, all one rule (SAST-004, SAST-017) |
| Package contents | `npx vsce ls` | shipped `.vsix` | 97 files; **0** from `node_modules/`, `test/`, `tools/`, `benchmarks/` |
| Manual review | checklist in §4 | `/app`, `/security` | complete |
| Unit suite | `npm run test:unit` | `/app` | **1584 passing** |
| ReDoS measurement | `node`, adversarial inputs | 2 regexes | linear, §3 |

The production dependency tree is still empty (`"dependencies": {}`), which is what makes
the `--omit=dev` result meaningful rather than lucky.

## 2. Findings Summary

| Severity | Count | Resolved | Accepted Risk (with justification) |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 1 | 0 | 1 — intended, layered design (SAST-004) |
| Medium | 0 | 0 | 0 |
| Low | 3 | 3 | 0 |
| Info | 4 | 2 | 2 — measured as linear (SAST-003, SAST-016) |

No finding required a change to a permission, a path guard, or the allow-list. Three were
fixed (SAST-015, SAST-018, SAST-020), and one Info-level ordering hardening was applied
(SAST-016). SAST-020 is the one worth reading: it is a real gap, it was found by manual
review rather than by any tool, and the first draft of this report argued for accepting
it on grounds that turned out to be false when measured.

## 3. Findings Detail

| ID | Tool | File:Line | Description | Severity | Status | Resolution / Justification |
|---|---|---|---|---|---|---|
| SAST-015 | Manual review, this pass | `app/core/imageRecognition.js` (new) | **Model output placed in another model's prompt without validation.** A vision model's free-text reply becomes the description block in the coding model's context. An unbounded or adversarial reply could crowd out the task, or assert its own instructions. | Low | **Resolved** | Three bounds, all in `describe`: `num_predict` caps generation at 640 tokens; the stored string is truncated to 1600 characters; and `contextBuilder` allocates the block a priority and a `minTokens` floor, so it competes for budget rather than consuming it. The block is also framed — `renderForPrompt` states the text is a *description produced by a vision model*, which is the same untrusted-content framing the Context Files block uses. Prompt injection via an image remains **out of scope by threat model**: the image comes from the user's own file picker, and a user who wants to instruct the model can type. |
| SAST-016 | ESLint `security/detect-unsafe-regex` | `app/agent/agentSession.js:268` (`UNDICTATABLE`) | Pre-existing. Alternation with an adjacent optional group (`\\.env(?:\\..+)?$`) flagged as potentially super-linear. Called on model-written path strings. | Info | **Resolved (hardening)** | **Measured rather than argued.** Worst case over adversarial shapes: `/.env` + 395 dots → 0.210 ms; 400 slashes → 0.085 ms; and *unbounded* at 40,000 characters → 0.030 ms. Linear. The greedy `.+` is `$`-anchored with no ambiguous adjacent quantifier, so no candidate split is retried. **Separately fixed:** the call site ran this regex *before* the 400-character bound in `isDictatableFilename`, despite `MAX_TARGET_PATH_CHARS` being documented as the bound that keeps the check linear. Both are side-effect-free `continue` guards, so the order was free to change; the bounded check now runs first. Not a fix for a live ReDoS — it is the ordering that means one is never reachable here if the pattern is later edited into an ambiguous one. |
| SAST-017 | Semgrep `javascript.lang.security.detect-child-process` | `tools/bench-build.js:290`, `tools/bench-realworld.js:99`, `tools/lib/javaProbe.js:44`, `tools/lib/pythonProbe.js:351` | `spawnSync(argv[0], argv.slice(1))` in the benchmark harnesses. | Low (rule) | **Accepted** | Developer tooling, **not shipped** — `npx vsce ls` returns 0 files from `tools/`. Every `argv` is built inside the harness from a fixture task or a command-line flag typed by the person running it, `shell` is not set, and there is no path from model output to any of them. *Newly relevant this pass:* `tools/bench-vision.js` was drafted with a `spawnSync('ollama', ['stop', model], { shell: true })` to unload a model between samples. `shell: true` with an argument array is precisely the DEP0190 unescaped-concatenation shape, so it was replaced with an HTTP call (`generate` with `keep_alive: 0`) through the existing loopback-only client. The new harness imports no `child_process` at all. |
| SAST-018 | `tools/bench-vision.js`, this pass | `.vscodeignore` | **3.6 MB of benchmark fixture photographs would have shipped in the `.vsix`.** `docs/**` is not ignored wholesale — only `docs/assets/**` and `docs/images/**` are — so `docs/test-images/`, added this release, was packaged by default. | Low | **Resolved** | Rule added, with a comment naming the general hazard: a new subdirectory under `docs/` is packaged unless someone thinks about it. Verified with `npx vsce ls`: 103 files before, 97 after, 0 matching `test-images`. Not a vulnerability, but it is an unreviewed-content-in-the-shipped-artefact problem and it is cheaper to catch here than in a release. |
| SAST-019 | Manual review, this pass | `app/core/imageRecognition.js` (`REFUSAL`) | New regex, run against model output. Checked for catastrophic backtracking before it was accepted, per the standing rule that a flagged-or-not pattern over model text gets measured. | Info | **Resolved** | Input is sliced to 400 characters before the test, so the bound is structural. Measured anyway: worst case 1.195 ms on 400 characters of `"i cannot see "` repeated, 0.033 ms *unbounded* at 100,000 characters. ESLint flags neither `detect-unsafe-regex` nor `detect-non-literal-regexp` on it — it is a literal, not constructed. |
| SAST-020 | Manual review, this pass | `app/core/imageRecognition.js` → `app/core/contextBuilder.js` | **A credential visible in a screenshot reached the prompt unredacted.** Every other block `contextBuilder` assembles — file contents, selections, observations, the open editor — is passed through `redact`. The new image-description block was not. | Low | **Resolved** | Now redacted like the rest. The reasoning matters more than the diff: this path does not merely *permit* a secret through, it **asks for one**. The `task` recognition prompt instructs the describer to copy every piece of visible text exactly, because a misread filename sends the agent to the wrong file — so a screenshot of a terminal showing `export OPENAI_API_KEY=sk-…` yields a description containing the key by design. Verified against `secretsScanner`: `redact` replaces the matched token and leaves the surrounding sentence standing, so the description stays useful; an initial draft of this report justified skipping it on the grounds that a false positive would blank the answer, which measurement showed to be simply wrong. Covered by a test. **Not** applied to the on-screen panel: that shows the user the contents of their own picture, which they are already looking at, and it is not persisted to the transcript. |
| SAST-004 | Semgrep `javascript.lang.security.detect-child-process` | `app/security/scriptRunner.js:451` | Carried forward. `spawn()` reached from the `command` and `options` arguments. Impact HIGH, **confidence LOW**. | High (rule) | **Accepted, unchanged** | A true positive by pattern and the intended design: the only `child_process` call in shipped code, in the module that exists to make it safe. Argument array with `shell: false`; `argv[0]` must match the allow-list; shell metacharacters rejected at tokenize time; Windows `.cmd` shims pre-screened; the caller must already hold a `permissionGate` approval. Unchanged by 1.1.0 — the image path opens no process. |
| SAST-003 | ESLint `security/detect-unsafe-regex` | 22 sites across `/app` | Carried forward. Patterns with adjacent optional groups. | Info | **Accepted, unchanged** | Each reviewed individually in previous passes and re-confirmed unchanged this pass. All are `^`-anchored with optional groups beginning at a literal or a disjoint character class, and every input is length-bounded at its call site. SAST-016 is the one that gained a call-site ordering fix. |
| SAST-014 | Prior pass | `app/agent/stepBrief.js` | Carried forward, **already fixed in 1.0.0.** O(n²) path-token sweep. | — | **Closed** | Re-verified: the 120-character segment bound and its timing test are both present and passing. |

## 4. Manual Review Checklist

Items unchanged by this release are marked *(unchanged)* and were re-verified rather than
re-argued.

- [x] **Command injection** *(unchanged)* — `child_process` is still imported in exactly
      one shipped file (`security/scriptRunner.js`, `spawn` only). Confirmed by grep
      across `/app`. The image path opens no process. `tools/bench-vision.js`
      deliberately does not import it (SAST-017).
- [x] **Path traversal — the new file read.** `imageContext.readImage` is the only new
      filesystem read, and its path comes from `vscode.window.showOpenDialog`, i.e. from
      the user clicking a file, never from model output. Re-confirmed that nothing in
      the 1.1.0 diff lets a model name an image: `_attachImage` is reachable only from
      the webview's `attach-image` message, which carries no path, and the picker is
      opened host-side. The webview never names a file, which is the rule
      `.claude/skills/frontend-design` states and this diff keeps.
- [x] **Content validation on the new input.** Extension allow-list (5 formats), a
      `stat` size check **before** the read so an enormous file is never pulled into
      memory, then a magic-number sniff of the actual bytes with a warning on
      extension/content mismatch. Pre-existing and unchanged; re-read this pass because
      the input is newly reachable on models where it previously was not.
- [x] **The new network path.** None. Images go to the same `ollamaClient` as every other
      request, which validates loopback at construction. No new socket, no new host, no
      new protocol. `assertLoopbackEndpoint` is unchanged.
- [x] **Model output crossing a trust boundary.** The one genuinely new boundary in this
      release, covered by SAST-015. Also checked: the description reaches the **webview**
      as well as the prompt, and `messageBubble.appendVisionNote` builds it with
      `createElement` + `textContent`, never `innerHTML`. `eslint-plugin-no-unsanitized`
      is clean on the file.
- [x] **Denial of service via the new path.** A description is one bounded model call
      with `num_predict` set; `describeAll` is sequential, so N images are N serial calls
      rather than N concurrent ones; the in-memory cache is bounded at 32 entries with
      the oldest evicted, keyed on a 32-hex-character digest rather than on the megabyte
      of base64 itself. A failed call returns text, so one unreadable attachment cannot
      throw away the turn.
- [x] **Secrets.** See SAST-020 — the one finding this pass that changed shipped
      behaviour on its own merits rather than as hardening.
- [x] **Permissions and path confinement** *(unchanged)* — the image path grants nothing.
      It reads one user-chosen file and produces text. No tool, no mode, no allow-list,
      and no `permissionGate` call site was touched by this release; confirmed by
      reviewing the diff for `app/security/**` (empty).
- [x] **Prototype pollution / object injection** — 6 ESLint warnings across `/app`, all
      pre-existing and previously reviewed. The two the new module raised were resolved
      before this report: `PROMPTS[purpose]` is now a single lookup on a value narrowed
      to one of two string literals, annotated at the line; the other is a loop counter
      over a local array.
- [x] **ReDoS** — SAST-016 and SAST-019, both measured rather than assumed, per the
      standing rule for this repository.
- [x] **Shipped artefact contents** — SAST-018. `npx vsce ls` reviewed in full this pass
      rather than grepped, which is how the fixture photographs were found.

## 5. What Changed Since 1.0.0

- **New module reviewed in full:** `app/core/imageRecognition.js`.
- **Modified and re-reviewed:** `app/agent/agentSession.js`, `app/features/chatTab.js`,
  `app/core/contextBuilder.js`, `app/extension.js`,
  `app/webview/components/messageBubble.js`, `app/webview/main.js`.
- **New developer tooling, not shipped:** `tools/bench-vision.js`.
- **Three fixes with a security dimension:** SAST-020 (a credential visible in a
  screenshot reaching the prompt unredacted), SAST-018 (unreviewed content in the shipped
  package), and the SAST-016 guard ordering.
- **One behavioural fix found by measurement rather than by review:** a vision model
  replying *"I cannot see this image"* had that sentence stored and presented as the
  description. Not a vulnerability — it is a correctness bug — but it is the class of
  thing where a model's output is trusted as data, and it is recorded here because that
  is the same class SAST-015 is about.

## 6. Residual Risk

Unchanged from 1.0.0 in kind, with one addition:

- **`scriptRunner` runs programs.** By design, allow-listed, shell-free, and gated. The
  residual risk is a program on the allow-list being used to do something unintended, and
  it is accepted because a coding agent that cannot run the user's tests is not one.
- **Images are shown to a local model.** New this release. Anything visible in an
  attached picture is visible to the describer, and the description is shown back in the
  panel. It does not leave the machine. Since SAST-020 the description is redacted before
  it reaches any prompt, so a recognised credential does not propagate — but
  `secretsScanner` matches known patterns and known entropy, and a secret in a shape it
  does not recognise will pass through, exactly as it would if the user had pasted it.
  The panel is deliberately unredacted: it shows the user their own picture back.
