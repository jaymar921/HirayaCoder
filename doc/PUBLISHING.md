# Publishing HirayaCoder to the VS Code Marketplace

*A clear, step-by-step guide for `jaymar921` to follow once HirayaCoder is fully built, tested, and ready to ship. No prior Marketplace-publishing experience assumed.*

Follow these steps **in order**. Steps 1–3 are one-time setup you only do once per publisher account. Steps 4 onward repeat for every new version you release.

---

## Before you start: Pre-Publish Checklist

Don't proceed to packaging until every box here is checked — publishing a broken or incomplete listing is much more annoying to fix than to prevent.

- [ ] All features in `/setup/PROMPT.md` that are in scope for this version are implemented and working.
- [ ] `npm run test:all` passes locally (lint + unit + integration), and **CI is green on
      all three platforms** — the Actions run for the commit you are about to tag.
- [ ] SAST suite has been run and a filled-out report exists in `/security/` (see
      `sast-report-2026-08-12.md`) with no unresolved Critical/High findings.
- [ ] Smoke-tested manually on Windows, macOS, and Linux. CI covers the automated suites
      on all three; this box is about a human using the packaged `.vsix` — see Step 7b
      for the short list of things that actually differ per platform.
- [ ] Smoke-tested with `llama3.2:1b` end to end: open chat, attach a context file, run an Agent-mode task that edits a file, and confirm the diff/approval flow works.
- [ ] `README.md` is accurate and has the icon, feature list, and correct `License` section.
- [ ] `CHANGELOG.md` has an entry for this version.
- [ ] `LICENSE` file exists and its content matches what `README.md` links to.
- [ ] `docs/assets/icon-128.png` exists and looks correct at both small and large sizes.

---

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

## Step 4 — Make Sure `package.json` Is Marketplace-Ready

Before every release, confirm these fields are correct in `package.json`:

```json
{
  "name": "hirayacoder",
  "displayName": "HirayaCoder",
  "description": "A local Filipino-inspired AI programmer that generates, refactors, and understands code directly inside VS Code — fully offline, powered by Ollama.",
  "version": "1.0.0",
  "publisher": "jaymar921",
  "author": "jaymar921",
  "license": "SEE LICENSE IN LICENSE",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Machine Learning", "Programming Languages", "Other"],
  "keywords": ["ai", "ollama", "offline", "agent", "coding assistant", "local llm"],
  "icon": "docs/assets/icon-128.png",
  "repository": {
    "type": "git",
    "url": "https://github.com/jaymar921/HirayaCoder"
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

This updates `package.json`'s `version` field and creates a git commit + tag automatically. Update `CHANGELOG.md` with a short entry for this version before or right after this step.

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

---

## Step 10 — Tag the Release in Git & Publish on GitHub

**This is automated.** `.github/workflows/release.yml` runs on any `v*.*.*` tag:

```bash
git push origin main --tags
```

That one push triggers, in order:

1. **Verify** — lint, 573 unit tests, and the 12 integration tests against a real VS
   Code, on **Ubuntu, macOS, and Windows** in parallel, plus a production dependency
   audit. Packaging does not start unless all three platforms pass.
2. **Guard** — the tag is compared against `package.json`. A `v0.2.0` tag on a manifest
   still saying `0.1.0` fails here, rather than producing a `.vsix` whose filename
   disagrees with the release it hangs from.
3. **Package** — `npm run package`, into `builds/v<version>/`.
4. **Publish** — a GitHub Release for the tag, with the `.vsix` attached, its SHA-256
   recorded, install instructions, and auto-generated commit notes.

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
npm version patch                      # bump version + tag
npm test                               # confirm green
vsce package                           # produces hirayacoder-<version>.vsix
mkdir -p builds/v<version>
mv hirayacoder-<version>.vsix builds/v<version>/
code --install-extension builds/v<version>/hirayacoder-<version>.vsix   # smoke test
vsce publish --packagePath builds/v<version>/hirayacoder-<version>.vsix
git push origin main --tags
# then create a GitHub Release for the pushed tag and attach the .vsix
```

---

## Optional: Also Publishing to Open VSX

VS Code forks like VSCodium don't use the official Marketplace — they use [Open VSX](https://open-vsx.org/) instead. If you want HirayaCoder available there too:

```bash
npm install -g ovsx
npx ovsx create-namespace jaymar921   # one-time
npx ovsx publish builds/v<version>/hirayacoder-<version>.vsix -p <open-vsx-token>
```

Open VSX tokens are generated separately from your `eclipse.org` account at `https://open-vsx.org` — this is entirely optional and not required for a standard VS Code Marketplace release.
