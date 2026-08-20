# Publishing HirayaCoder to the VS Code Marketplace

*A clear, step-by-step guide for `jaymar921`. No prior Marketplace-publishing experience assumed.*

## Which half of this do I need?

There are two jobs in this document and they are not the same size.

| | What it covers | Read |
|---|---|---|
| **Publishing 1.0.0 for the first time** | Creating the publisher, getting a token, and getting the listing to exist at all. Done once, ever. | Steps 1–3, then 4–11 |
| **Shipping an update** | Bump, package, test, publish, tag. Twenty minutes once you have done it once. | [Part B](#part-b--shipping-an-update) — Steps 4–11 only |

Steps 1–3 are **one-time setup per publisher account**. If `vsce login jaymar921`
already works on this machine, skip straight to Part B.

> **First time?** The order that matters most: **do not tag before the version is right.**
> Step 5 bumps `package.json`, and the tag push in Step 10 is compared against it. A tag
> that disagrees fails the release job rather than shipping something mislabelled — which
> is the design working, but it is easier to get right the first time.

---

## What "publishing" actually means here

Three things happen at a release and they are independent. Confusing them is the main
way this goes wrong.

| | Who does it | When | Reversible? |
|---|---|---|---|
| **GitHub Release** — the `.vsix` attached to a tag | **CI, automatically** on any `v*.*.*` tag | Step 10 | Yes, delete the release |
| **Marketplace listing** — the one-click install | **You, by hand** (`vsce publish`) | Step 8 | **No** — see Step 11 |
| **Version number** in `package.json` | You | Step 5 | Yes, until it is published |

The GitHub Release is automated because it is safe to repeat. Marketplace publishing is
deliberately manual and **no Marketplace token is stored in this repository**: pushing a
tag should not be able to ship to every installed user.

---

## Before you start: Pre-Publish Checklist

Don't proceed to packaging until every box here is checked — publishing a broken or incomplete listing is much more annoying to fix than to prevent.

- [ ] All features in `/setup/PROMPT.md` that are in scope for this version are implemented and working.
- [ ] `npm run test:all` passes locally (lint + unit + integration), and **CI is green on
      all three platforms** — the Actions run for the commit you are about to tag.
- [ ] SAST suite has been run and a filled-out report exists in `/security/` — the most
      recent is `sast-report-2026-08-20-1.0.0.md` — with no unresolved Critical/High
      findings. Copy `sast-report-template.md` rather than editing the previous report.
- [ ] Smoke-tested manually on Windows, macOS, and Linux. CI covers the automated suites
      on all three; this box is about a human using the packaged `.vsix` — see Step 7b
      for the short list of things that actually differ per platform.
- [ ] Smoke-tested with `llama3.2:1b` end to end: open chat, attach a context file, run an Agent-mode task that edits a file, and confirm the diff/approval flow works.
- [ ] `README.md` is accurate and has the icon, feature list, and correct `License` section.
- [ ] `CHANGELOG.md` has an entry for this version.
- [ ] `LICENSE` file exists and its content matches what `README.md` links to.
- [ ] `docs/assets/icon-128.png` exists and looks correct at both small and large sizes.
- [ ] **The version badge in the marketing images matches this release.** They are
      rendered from `docs/images/src/*.html` and every one carries the version — see that
      folder's `README.md` for what to bump and, just as importantly, what not to.
- [ ] **Nothing in the repo claims a Marketplace listing that does not exist yet.** The
      hero image's CTA, `capabilities.html`'s footer, `ad-4-launch.html`'s footer, and
      the README's banner all describe how to install. Through 0.7.0 one of them said
      *Search "HirayaCoder" in the Extensions view*, months before that could work.
- [ ] **The release will not be published as a pre-release.** CI derives this from the
      version: `0.x` and any `-rc`/`-beta` suffix are flagged, everything else is not.
      `test/unit/releaseWorkflow.test.js` asserts it for the current `package.json`, so a
      green suite is the check — there is no checkbox to get wrong.

---

# Part A — First Publish (one-time setup)

*Steps 1–3. Done once per publisher account, ever. If `vsce login jaymar921` already
works on this machine, skip to [Part B](#part-b--shipping-an-update).*

## Step 1 — Create a Publisher (one-time)

The Marketplace groups extensions under a **publisher ID**. You'll use `jaymar921`.

1. Go to the [Visual Studio Marketplace publisher management page](https://marketplace.visualstudio.com/manage) and sign in with a Microsoft account.
2. Click **Create publisher**.
3. Fill in:
   - **Publisher ID**: `jaymar921` (this becomes part of your extension's unique identifier and generally can't be changed later — get it right).
   - **Display name**: e.g. `Jaymar` or `jaymar921`.
4. Save. You now have a publisher, but no extensions under it yet — that's fine, you'll publish HirayaCoder to it in the steps below.

---

## Step 2 — Get a Personal Access Token (PAT) (one-time, renew when it expires)

Publishing from the command line requires an Azure DevOps Personal Access Token scoped to the Marketplace.

1. Go to [https://dev.azure.com](https://dev.azure.com) and sign in with the **same Microsoft account** you used for the publisher.
2. If prompted, create an organization (any name is fine — it's just required to reach the token settings, it's not otherwise used).
3. Click your profile icon (top right) → **Personal access tokens**.
4. Click **+ New Token**:
   - **Name**: `hirayacoder-publish` (anything memorable).
   - **Organization**: select **All accessible organizations**.
   - **Expiration**: choose a duration you're comfortable with (e.g. 90 days or 1 year) — you'll need to generate a new one when it expires.
   - **Scopes**: click **Custom defined**, then find **Marketplace** and check **Manage**.
5. Click **Create**, then **copy the token immediately** — Azure DevOps only shows it once. Store it somewhere safe (a password manager, not a plaintext file in this repo).

---

## Step 3 — Install the Publishing Tool (one-time)

```bash
npm install -g @vscode/vsce
```

Verify it installed:

```bash
vsce --version
```

Then log in with your publisher and the PAT from Step 2:

```bash
vsce login jaymar921
```

Paste the PAT when prompted. You only need to do this once per machine (or again if the token expires/is revoked).

---

# Part B — Shipping an Update

*Everything from here repeats for every release. Steps 1–3 above are done.*

## Step 4 — Make Sure `package.json` Is Marketplace-Ready

Before every release, confirm these fields are correct in `package.json`. This is the
current manifest, copied verbatim — if yours differs, yours is the one that ships:

```json
{
  "name": "hirayacoder",
  "displayName": "HirayaCoder",
  "description": "A fully offline, privacy-first AI coding agent powered by your local Ollama instance. Agentic on every model — even 1B.",
  "version": "1.0.0",
  "publisher": "jaymar921",
  "author": {
    "name": "jaymar921",
    "url": "https://github.com/jaymar921"
  },
  "license": "MIT",
  "icon": "docs/assets/icon-128.png",
  "engines": {
    "vscode": "^1.85.0",
    "node": ">=18"
  },
  "categories": [
    "AI",
    "Programming Languages",
    "Machine Learning",
    "Other"
  ],
  "keywords": [
    "ollama",
    "offline",
    "local llm",
    "ai agent",
    "privacy",
    "copilot alternative",
    "code assistant"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/jaymar921/HirayaCoder.git"
  }
}
```

- `version` must follow [semantic versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`) and must be **higher** than whatever's currently published.
- `icon` must point to a real PNG file (not SVG) that exists in the package.
- `repository.url` should be a real, public (or at least accessible) URL — the Marketplace links to it.

---

## Step 5 — Bump the Version

Pick the right bump based on what changed since the last release:

- **Patch** (`1.0.0` → `1.0.1`) — bug fixes only, no new features.
- **Minor** (`1.0.0` → `1.1.0`) — new features, backward compatible.
- **Major** (`1.0.0` → `2.0.0`) — breaking changes (e.g. settings renamed, memory file format changed incompatibly).

```bash
npm version patch   # or: minor / major
```

This updates `package.json`'s `version` field and creates a git commit + tag automatically.

> **Careful with `npm version` here.** It tags immediately, and the release workflow
> compares that tag against `package.json`. That is fine when the bump is the last thing
> you do — but if you still have documentation or images to update, use
> `npm version <type> --no-git-tag-version` and tag by hand in Step 10, once everything
> that mentions the version agrees.

### The rest of the bump — everything else that names the version

`package.json` is one of several places the version appears, and the others do not fail
loudly when they go stale; they just quietly ship a picture saying `v0.9.0` on a 1.2.0
release. Work down this list:

| What | Where | Notes |
|---|---|---|
| Version | `package.json` | The one CI enforces against the tag |
| Changelog entry | `CHANGELOG.md` | Dated, with a real summary — see below |
| Version badge, ×6 | `docs/images/src/*.html` | Then **re-render** — `docs/images/src/README.md` has the command |
| Version badge, ×4 | `docs/images/src/ad-*.html` | The social ads. Same re-render, different window size |
| Hero alt text | `README.md` | Names the version in the `alt` attribute, where nobody looks |
| SAST report | `security/sast-report-<date>-<version>.md` | New file from the template, not an edit of the last one |
| CI test counts | this file, Step 10 | Only when they have moved enough to mislead |

Two rules that have already caught mistakes here:

- **Not every version string is the current version.** `knows-what-it-has.html` contains
  a badge labelling the release a *measurement* was taken on. Bumping that makes the
  image claim a number it never measured. When in doubt, read the surrounding text.
- **The "New in …" tag moves to the card the release actually changed, or comes off.**
  Only ever one card carries it. For 1.0.0 it came off, because 1.0.0 rewrote none of
  them.

### Writing the changelog entry

Keep-a-Changelog format, and **date it** — several older entries in this file are marked
`unreleased` despite having been tagged and shipped, which makes the history harder to
read than it needs to be. The heading should be `## [1.2.0] — 2026-08-20`.

---

## Step 6 — Package the Extension

```bash
vsce package
```

This produces a file like `hirayacoder-1.0.1.vsix` in the repo root.

Move it into the versioned builds folder (or let your `npm run package` script, if you've set one up per `PROMPT.md` section 14, do this automatically):

```bash
mkdir -p builds/v1.0.1
mv hirayacoder-1.0.1.vsix builds/v1.0.1/
```

---

## Step 7 — Test the Packaged `.vsix` Locally

Always install the actual packaged file and try it — don't just trust the dev-host (`F5`) run, since packaging can exclude files you needed (check `.vscodeignore` if something's missing).

```bash
code --install-extension builds/v1.0.1/hirayacoder-1.0.1.vsix
```

Open a fresh workspace, run `HirayaCoder: Open Chat`, and walk through: welcome screen renders correctly → model dropdown lists your Ollama models → send a simple Ask-mode question → run a small Agent-mode task → confirm the diff/approval flow works. Then uninstall it before publishing (`code --uninstall-extension jaymar921.hirayacoder`) so you're not confusingly running a stale local build afterward.

### Step 7b — The cross-platform pass (`PROMPT.md` §11)

The packaged payload is pure JavaScript and assets — no `.node`, `.exe`, `.dll`,
`.dylib`, or `.so` — so there is nothing architecture-specific to rebuild. What differs
per platform is *behaviour*, in a small number of known places, and those are what this
pass is for.

**What is already verified by the automated suites, on any platform they run on:**

| Requirement | Evidence |
|---|---|
| Paths via `path.join`/`resolve`/`sep`, never `/`-concatenation | No manual concatenation anywhere in `app/`; verified by inspection |
| Per-platform shell resolution, argument-array based | `utils/platform.resolveShell` is unit-tested for `win32`, `darwin`, and `linux` |
| Case-sensitivity | `pathGuard` case-folds on `win32` and `darwin` only, not `linux`; unit-tested per platform |
| Line endings | `detectEol`/`applyEol`/`toLf` unit-tested; a CRLF file stays CRLF after an edit |
| Ollama access identical everywhere | One HTTP API; no CLI assumptions beyond the binary being on `PATH` |

The platform-dependent modules all take an injectable `platform` argument, so all three
branches are exercised from one machine. That is not the same as running there.

**What genuinely needs each machine.** Install the `.vsix` and confirm:

1. **The extension activates** and the status bar shows a connection.
2. **`npm test` through the agent works** — this is the one that has actually broken.
   On Windows, `npm`/`npx`/`yarn` are `.cmd` shims routed through `cmd.exe`, and a bad
   flag there once broke every command when Node was installed under a path containing a
   space. macOS and Linux take the `/bin/sh -c` path instead, which is separate code.
3. **A file with CRLF endings survives an edit** without turning into a whole-file diff.
4. **A path with a space in it works** — `~/My Projects/thing`. Cheap to test, and the
   failure mode above was exactly this.
5. **The webview renders** with the host theme, and **Review diff** opens the editor's
   diff viewer.
6. **`npm run test:integration` passes**, if the machine has a checkout. It launches a
   real VS Code and covers activation, the webview protocol, and a full turn to disk.

Record the result for each OS in the release notes for the tag. An untested platform is
better stated than assumed.

---

## Step 8 — Publish to the Marketplace

Once you're confident in the packaged build:

```bash
vsce publish
```

This uploads the current version (rebuilding the package internally) directly to the Marketplace using your logged-in publisher credentials from Step 3.

Alternatively, to publish the **exact** `.vsix` you already tested in Step 7 (recommended, since it guarantees what you tested is what ships):

```bash
vsce publish --packagePath builds/v1.0.1/hirayacoder-1.0.1.vsix
```

Publishing typically shows up on the Marketplace within a few minutes.

---

## Step 9 — Verify the Live Listing

1. Go to `https://marketplace.visualstudio.com/items?itemName=jaymar921.hirayacoder`.
2. Check: the icon renders correctly, the README renders correctly (headings, images, badges), the description and categories look right, and the version number matches what you just published.
3. Install it fresh from within VS Code (`Extensions` → search "HirayaCoder") on a clean profile if possible, to see exactly what a new user sees.

### Step 9b — Flip the install route (the very first publish only)

**Do this only once the listing above is actually live and installable.** Until 1.0.0 the
repo deliberately told everyone to download a `.vsix` from GitHub Releases, because that
was the only thing that worked. Once "search the Extensions view" is true, four places
should say so:

| File | What to change |
|---|---|
| `README.md` | The banner near the top, and Step 4 of *Getting started* |
| `docs/images/src/hero-offline-agent.html` | The CTA button and the note beside it |
| `docs/images/src/capabilities.html` | The footer |
| `docs/images/src/ad-4-launch.html` | The footer, and the matching caption in `docs/images/ADS-1.0.0.md` |

Re-render the three images afterwards. Keep GitHub Releases mentioned as well rather than
replacing it — VSCodium users and anyone on a locked-down machine still need the `.vsix`.

**Do not do this ahead of time.** `capabilities.html` shipped a footer reading
*Search "HirayaCoder" in the Extensions view* through 0.7.0, when there was nothing to
find, and that is a worse first impression than a `.vsix` download.

---

## Step 10 — Tag the Release in Git & Publish on GitHub

**This is automated.** `.github/workflows/release.yml` runs on any `v*.*.*` tag:

```bash
git push origin main --tags
```

That one push triggers, in order:

1. **Verify** — lint, the full unit suite (1,545 tests at 1.0.0), and the 16 integration
   tests against a real VS Code, on **Ubuntu, macOS, and Windows** in parallel, plus a
   production dependency audit. Packaging does not start unless all three platforms pass.
2. **Guard** — the tag is compared against `package.json`. A `v0.2.0` tag on a manifest
   still saying `0.1.0` fails here, rather than producing a `.vsix` whose filename
   disagrees with the release it hangs from.
3. **Package** — `npm run package`, into `builds/v<version>/`.
4. **Publish** — a GitHub Release for the tag, with the `.vsix` attached, its SHA-256
   recorded, install instructions, and auto-generated commit notes.

**Release or pre-release is decided by the version, not by a checkbox.** A `0.x` version
or one with a `-rc`/`-beta` suffix is published as a GitHub pre-release and gets an extra
"offered to try, not to depend on" note appended. Anything else — 1.0.0 onward — is
published as a full release and marked `--latest`, which is what
`/releases/latest` resolves to and therefore what install instructions point at.

Nothing to set: `test/unit/releaseWorkflow.test.js` asserts the classification for
whatever is currently in `package.json`, so a green suite already tells you which one
this tag will produce.

It uses the runner's built-in `GITHUB_TOKEN`. **No Personal Access Token is stored in
this repository**, and the workflow is read-only except for the single job that creates
the release. Marketplace publishing (Step 8) stays deliberately manual — pushing a tag
should not be able to ship to every user.

To rehearse without publishing, run the workflow manually from the **Actions** tab with
`dry_run` left checked: it builds and verifies, uploads the `.vsix` as a build artifact
you can download and install, and creates no release.

If you ever need the manual path — the workflow is unavailable, or you are publishing
from a fork — it is: **Releases → Draft a new release**, choose the tag, title it
`HirayaCoder v<version>`, paste the `CHANGELOG.md` entry, and drag in
`builds/v<version>/hirayacoder-<version>.vsix`.

This gives users (and you) a durable, versioned home for every `.vsix` you've ever shipped, without bloating the git history — exactly why `/builds/` is `.gitignore`d but its contents live on as release assets instead.

---

## Step 11 — After Publishing

- Watch the Marketplace listing's **Q&A** tab and your GitHub **Issues** for early feedback — small-model / offline-agent extensions tend to surface hardware-specific quirks (RAM limits, unusual Ollama setups) quickly after release.
- Keep `CHANGELOG.md` open and start a new "Unreleased" section for the next round of work.
- If you find a release-blocking bug shortly after publishing, ship a patch version (Step 5 onward) rather than trying to unpublish — unpublishing breaks existing installs and is discouraged by the Marketplace.

---

## Quick Reference (once you've done Steps 1–3 once)

```bash
npm version patch --no-git-tag-version   # bump package.json only
# ...then update CHANGELOG.md, the 10 image sources, and the README alt text (Step 5)
npm run test:all                         # lint + unit + integration, all green
npm run package                          # builds/v<version>/hirayacoder-<version>.vsix

code --install-extension builds/v<version>/hirayacoder-<version>.vsix   # smoke test
code --uninstall-extension jaymar921.hirayacoder                        # then remove it

vsce publish --packagePath builds/v<version>/hirayacoder-<version>.vsix  # the manual bit

git commit -S -am "chore: v<version>"
git tag -s v<version> -m "HirayaCoder v<version>"
git push origin main --tags              # CI builds and creates the GitHub Release
```

The tag push is the last step, and it is the one that is hard to undo — everything above
it is reversible.

---

## Optional: Also Publishing to Open VSX

VS Code forks like VSCodium don't use the official Marketplace — they use [Open VSX](https://open-vsx.org/) instead. If you want HirayaCoder available there too:

```bash
npm install -g ovsx
npx ovsx create-namespace jaymar921   # one-time
npx ovsx publish builds/v<version>/hirayacoder-<version>.vsix -p <open-vsx-token>
```

Open VSX tokens are generated separately from your `eclipse.org` account at `https://open-vsx.org` — this is entirely optional and not required for a standard VS Code Marketplace release.
