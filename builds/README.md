# /builds

Packaged `.vsix` output goes here, one subfolder per released version:

```
builds/
├── v0.1.0/
│   └── hirayacoder-0.1.0.vsix
├── v0.2.0/
│   └── hirayacoder-0.2.0.vsix
└── v1.0.0/
    └── hirayacoder-1.0.0.vsix
```

- This folder is **build output, not source** — its contents are excluded via the repo's `.gitignore`. Do not commit `.vsix` files here.
- Instead, attach the relevant `.vsix` to a **GitHub Release** for that version tag when you publish (see `/doc/PUBLISHING.md`, step 8). That keeps every released binary easy to find without bloating the git history with binaries.
- The packaging script (`npm run package`) reads the version from `package.json`, runs `vsce package`, and moves the output into the matching `v<version>/` folder here automatically — you shouldn't need to move files by hand.
- Never overwrite an existing version's folder; each release gets its own immutable folder.
