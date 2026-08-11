# Publishing HirayaCoder to the VS Code Marketplace

*A clear, step-by-step guide for `jaymar921` to follow once HirayaCoder is fully built, tested, and ready to ship. No prior Marketplace-publishing experience assumed.*

Follow these steps **in order**. Steps 1–3 are one-time setup you only do once per publisher account. Steps 4 onward repeat for every new version you release.

---

## Before you start: Pre-Publish Checklist

Don't proceed to packaging until every box here is checked — publishing a broken or incomplete listing is much more annoying to fix than to prevent.

- [ ] All features in `/setup/PROMPT.md` that are in scope for this version are implemented and working.
- [ ] `npm test` passes (unit + integration).
- [ ] SAST suite has been run and `/security/sast-report-template.md` is filled out with no unresolved Critical/High findings.
- [ ] Smoke-tested manually on Windows, macOS, and Linux (or at minimum on the OS you're on plus one other, if you can borrow a machine/VM).
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

`npm version` in Step 5 already created a local git tag. Push it, and attach the `.vsix` as a release asset:

```bash
git push origin main --tags
```

Then on GitHub:
1. Go to your repo → **Releases** → **Draft a new release**.
2. Choose the tag you just pushed (e.g. `v1.0.1`).
3. Title it (e.g. `HirayaCoder v1.0.1`), paste the relevant `CHANGELOG.md` entry as the description.
4. Attach `builds/v1.0.1/hirayacoder-1.0.1.vsix` as a binary asset (drag and drop it into the release).
5. Publish the release.

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
