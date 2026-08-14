# Marketing image sources

The two PNGs one folder up are rendered from the HTML beside this file. They are the
source of truth — regenerate rather than editing the PNGs, so the next version bump is a
one-line change instead of a redesign.

| Source | Output | Used in |
|---|---|---|
| `hero-offline-agent.html` | `../hero-offline-agent.png` | README hero, Marketplace listing |
| `capabilities.html` | `../capabilities.png` | README feature section |

Both are self-contained: no fonts, scripts, or images are fetched, and the app icon is
inlined as SVG. Everything renders from system fonts, so they look the same on any
machine with a Chromium build on it.

## Regenerating

Any Chromium works — Chrome or Edge, whichever is installed. `--force-device-scale-factor=2`
is what makes the output 2560×1440, which is what keeps the text sharp on a HiDPI screen:

```bash
chrome --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1280,720 --force-device-scale-factor=2 \
  --virtual-time-budget=6000 \
  --screenshot=docs/images/hero-offline-agent.png \
  docs/images/src/hero-offline-agent.html
```

On Windows, `msedge.exe` takes the same flags and needs `--user-data-dir` pointed at a
scratch folder — without it the launch is handed to the browser the user already has open
and no screenshot is written.

## When these need updating

- **The version badge**, on every release. It appears once per file, as `v0.7.0`.
- **The "New in …" line**, whenever a release changes what a card is claiming. It moves
  to whichever card the release actually changed rather than staying put — it sat on
  *Knows your machine* for 0.6.1 and moved to *Big requests become a checklist* for
  0.7.0, which is the card that stopped being true as written. Only ever one card
  carries it; two "New in" tags read as a changelog rather than as a highlight.
- **The mock chat transcript** in the hero, if the panel's real layout changes enough that
  the picture stops being an honest one. It is a mock, not a screenshot — but it should
  never show something the extension does not do.
