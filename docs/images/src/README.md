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
| `ad-1-offline.html` | `../ad-1-offline.png` | Social ad — nothing leaves your machine |
| `ad-2-agentic.html` | `../ad-2-agentic.png` | Social ad — agentic down to 1B |
| `ad-3-approval.html` | `../ad-3-approval.png` | Social ad — you approve every write |
| `ad-4-launch.html` | `../ad-4-launch.png` | Social ad — the 1.0 launch card |
| `ad-5-vision.html` | `../ad-5-vision.png` | Social ad — a text-only model can use your screenshot |
| `ad-6-what-it-read.html` | `../ad-6-what-it-read.png` | Social ad — you see what the vision model read |

The six README images are **1280×720**; the six `ad-*` files are **1080×1080**, because
a social post gets cropped to a square on most of the places it lands. Their captions
live in [`../ADS-1.0.0.md`](../ADS-1.0.0.md) (ads 1–4) and
[`../ADS-1.1.0.md`](../ADS-1.1.0.md) (ads 5–6).

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

The `ad-*` files take `--window-size=1080,1080` instead, which gives 2160×2160.

On Windows, `msedge.exe` takes the same flags and needs `--user-data-dir` pointed at a
scratch folder — without it the launch is handed to the browser the user already has open
and no screenshot is written.

Two more Windows details, both of which fail *silently* — Chromium reports success and
writes nothing, so check the file timestamps rather than the exit code:

- **The page must be a `file:///` URL, not a relative path.** Percent-encode the spaces:
  `file:///F:/important%20stuff/.../src/hero-offline-agent.html`.
- **`--screenshot` will not write to a path containing a space.** Render to a scratch
  folder and copy the PNG into `docs/images/` afterwards.

## `ad-6-what-it-read.html` carries measurements, and they expire

It is the only source here with numbers on its face, and they come from
`benchmarks/results/B/vision__*.json` by way of `tools/bench-vision.js`. **Re-run that
sweep before re-rendering this file for a later release.** An ad quoting a score the
harness no longer produces is worse than one quoting none, and these are small-sample
numbers on models that get replaced every few months.

Renumbering is not always enough. The ad's argument is that you cannot tell how well
your model reads text without looking at what it read, and that argument depends on the
two models disagreeing. A future sweep where both read everything needs the ad rewritten,
not re-rendered. The derivation of each figure is in
[`../ADS-1.1.0.md`](../ADS-1.1.0.md).

The mock description inside the panel — the checkout form — is a mock, like the hero's
chat transcript, and is held to the same rule: it must never show something the
extension does not do. The disclosure triangle and the *What … saw in …* label are the
real ones.

## When these need updating

- **The version badge**, on every release. It appears once per file, as `v1.0.0`.
  All six README sources were bumped together for 1.0.0, and the four ads carry it too.
  **Not** the `badge a` inside `knows-what-it-has.html`: that one labels the release the
  measurement was taken on, and bumping it would make the picture claim a number it never
  measured.
- **The "New in …" line**, whenever a release changes what a card is claiming. It moves
  to whichever card the release actually changed rather than staying put — it sat on
  *Knows your machine* for 0.6.1, moved to *Big requests become a checklist* for 0.7.0,
  and to *Agentic on every model* for 0.8.0, which is the card that release actually
  changed. For 0.9.0 it moved again, to *Big requests become a checklist*, because that
  is the card 0.9.0 rewrote — the checklist now comes from your own headings rather than
  from a planning call. Only ever one card carries it; two "New in" tags read as a
  changelog rather than as a highlight.

  **For 1.0.0 it was removed rather than moved.** 1.0.0 rewrote none of these six cards —
  it is the release that stabilises them — so every card was equally "new", which is
  another way of saying none of them was. Leaving the 0.9.0 tag in place would have let
  this release take credit for the previous one's work.
- **The mock chat transcript** in the hero, if the panel's real layout changes enough that
  the picture stops being an honest one. It is a mock, not a screenshot — but it should
  never show something the extension does not do.
- **The install route, on the day it reaches the Marketplace.** Still unchanged at 1.0.0,
  and deliberately: the version number and the Marketplace listing are separate events,
  and the tag is cut before the listing exists. What 1.0.0 did change is the *wording* —
  "Pre-release" was about distribution rather than stability, and a 1.0.0 that calls
  itself a pre-release is confusing — so the footers now read **Free & MIT** and the
  hero's note reads **Free and MIT-licensed**. Neither asserts a Marketplace listing.

  The route itself — GitHub Releases — is true today and stays true afterwards, so it is
  the safe thing to ship. On the day the listing goes live, swap the CTA in
  `hero-offline-agent.html`, the footer in `capabilities.html`, and the footer in
  `ad-4-launch.html`, then re-render. Until that day the Marketplace must not be
  mentioned as a way to get it — `capabilities.html` shipped a footer reading
  *Search "HirayaCoder" in the Extensions view* through 0.7.0, which was an instruction
  that could not work. `ad-4-launch.html` was drafted with the same mistake in it and
  corrected before it was ever rendered.
