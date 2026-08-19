# Marketing image sources

The PNGs one folder up are rendered from the HTML beside this file. They are the
source of truth — regenerate rather than editing the PNGs, so the next version bump is a
one-line change instead of a redesign.

| Source | Output | Used in |
|---|---|---|
| `hero-offline-agent.html` | `../hero-offline-agent.png` | README hero, and the Marketplace listing once published |
| `capabilities.html` | `../capabilities.png` | README feature section |
| `live-session.html` | `../live-session.png` | README, "Watching a run happen" |
| `knows-what-it-has.html` | `../knows-what-it-has.png` | README, "Small models that finish" |
| `asked-the-wrong-way.html` | `../asked-the-wrong-way.png` | README, "Asked the wrong way" |
| `your-structure-is-the-plan.html` | `../your-structure-is-the-plan.png` | README, "Your structure is the plan" |

All of them are self-contained: no fonts, scripts, or images are fetched, and the app icon is
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

Two more Windows details, both of which fail *silently* — Chromium reports success and
writes nothing, so check the file timestamps rather than the exit code:

- **The page must be a `file:///` URL, not a relative path.** Percent-encode the spaces:
  `file:///F:/important%20stuff/.../src/hero-offline-agent.html`.
- **`--screenshot` will not write to a path containing a space.** Render to a scratch
  folder and copy the PNG into `docs/images/` afterwards.

## When these need updating

- **The version badge**, on every release. It appears once per file, as `v0.9.0`.
- **The "New in …" line**, whenever a release changes what a card is claiming. It moves
  to whichever card the release actually changed rather than staying put — it sat on
  *Knows your machine* for 0.6.1, moved to *Big requests become a checklist* for 0.7.0,
  and to *Agentic on every model* for 0.8.0, which is the card that release actually
  changed. Only ever one card carries it; two "New in" tags read as a changelog rather
  than as a highlight.
- **The mock chat transcript** in the hero, if the panel's real layout changes enough that
  the picture stops being an honest one. It is a mock, not a screenshot — but it should
  never show something the extension does not do.
- **The install route, on the day it reaches the Marketplace.** Both images currently say
  this is a pre-release fetched from GitHub Releases, because it is:
  `hero-offline-agent.html` in the CTA button and its note, `capabilities.html` in the
  footer. Until that day the Marketplace must not be mentioned as a way to get it —
  `capabilities.html` shipped a footer reading *Search "HirayaCoder" in the Extensions
  view* through 0.7.0, which was an instruction that could not work.
