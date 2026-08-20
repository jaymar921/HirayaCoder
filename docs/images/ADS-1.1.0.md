# HirayaCoder 1.1.0 — image recognition ad set

Two square (1:1) ads for the 1.1.0 feature release, with the caption each one ships
with, plus a single caption for posting the pair together.

Rendered at **2160×2160** from the sources in `src/` (1080×1080 CSS pixels at
`--force-device-scale-factor=2`), same as the four 1.0.0 launch ads in
[`ADS-1.0.0.md`](ADS-1.0.0.md). 1:1 is the safe ratio everywhere: it is the native
LinkedIn/Instagram feed shape, and X and Facebook centre-crop it without losing content.

| # | Image | Source | The one thing it argues |
|---|---|---|---|
| 5 | `ad-5-vision.png` | `src/ad-5-vision.html` | A text-only model can now use your screenshot |
| 6 | `ad-6-what-it-read.png` | `src/ad-6-what-it-read.html` | You always see what the model actually read |

Order matters if you post them as a pair: 5 is the capability, 6 is the objection
("can I trust what a 750M model says it saw?"). Posting 6 alone works; posting 5 alone
oversells.

Regenerating them is the same command as the README images — see
[`src/README.md`](src/README.md).

---

## The numbers in ad 6 are real, and they expire

`ad-6-what-it-read.html` carries three measurements on its face. They come from
`tools/bench-vision.js` on machine B, and the raw runs are in
`benchmarks/results/B/vision__*.json`:

| On the ad | Where it comes from |
|---|---|
| **47/48** named the subject correctly | `minicpm-v4.6` 24/24 plus `qwen3.5:0.8b` 23/24, both prompts, two samples each |
| **0** described something not in the photo | the `confused` axis, zero on both models |
| **12/16** read the text printed in the picture | `minicpm-v4.6` 4/8 plus `qwen3.5:0.8b` 8/8 |

**Re-run the sweep before re-rendering this ad for any later release.** An ad quoting a
score the harness no longer produces is worse than one quoting none, and these are
small-sample numbers on models that get replaced.

The one that will move is the third. It is also the one the ad is built around, so if a
future sweep makes it flattering, the ad needs rewriting rather than renumbering: the
argument is "you cannot tell which model you have without looking", and it stops working
if both models read everything.

---

## Ad 5 — `ad-5-vision.png`

> Your AI model probably cannot see. That stopped mattering.
>
> HirayaCoder 1.1.0 reads images. Attach a screenshot, a photo, or a sketch of a screen
> you want built, and it uses what is in the picture.
>
> The part worth knowing: **this works even when the model you code with is text-only.**
> Most local models are. HirayaCoder hands the picture to whichever installed model has
> vision, gets back a written description, and passes that to your coding model. You do
> not switch models, and you do not give up the one you like.
>
> It also keeps working past the first turn. An agent run is eight or ten rounds and the
> picture only rides on the first one, so a written description is the only form of it
> that survives to the end.
>
> Both models run on your own machine. The image goes to 127.0.0.1 and nowhere else,
> like everything else this extension sends.
>
> `ollama pull minicpm-v4.6` is 1.6 GB and it is all you need.

## Ad 6 — `ad-6-what-it-read.png`

> A small model that misreads your screenshot does not tell you.
>
> That is the actual problem with image recognition on local hardware. It does not
> hedge, it does not say "I am not sure". It writes a fluent, confident paragraph about
> the wrong thing, and every answer after that is built on it.
>
> So HirayaCoder shows you the paragraph. Every image you attach comes with a panel
> holding the exact text the vision model produced. When an answer looks wrong you can
> tell, in one click, whether the picture was misread or the reasoning was. Those need
> opposite fixes and they are otherwise indistinguishable.
>
> Measured on six photographs across two models under 1B parameters: 47 of 48 named the
> subject correctly, and none of them described something that was not there.
>
> But only 12 of 16 read the text printed in the picture, and that number was not evenly
> split. One model read every word. The other, almost the same size, read half.
>
> We published the number we came off worst on, because it is the one that tells you to
> open the panel.

---

## The one caption for both

Use this when posting them together.

> **HirayaCoder 1.1.0 can look at pictures, and it shows you what it saw.**
>
> HirayaCoder is a free, fully offline AI coding agent for VS Code. It runs on your own
> machine through Ollama, and nothing you write ever leaves your laptop. This release
> teaches it to read images.
>
> **1. It works on a model that cannot see.** Most local models are text-only. Attach a
> screenshot anyway: the picture goes to whichever installed model has vision, comes
> back as a written description, and that goes to your coding model. No switching, no
> giving up the model you like. `ollama pull minicpm-v4.6` is 1.6 GB.
>
> **2. It survives the whole run.** An agent turn is eight or ten rounds, and the image
> only rides on the first one. The description is small enough to carry on every round,
> which is why it is produced even for a model that can see perfectly well.
>
> **3. You always see what it read.** A vision model that misreads your screenshot does
> not hedge, it writes a confident paragraph about the wrong thing. Every attachment
> comes with a panel showing the exact description, so you can tell a misread picture
> from a bad answer.
>
> **4. The numbers, including the bad one.** Six photographs, two models under 1B: 47 of
> 48 named the subject, 0 invented something that was not there, and 12 of 16 read the
> printed text. That last one split unevenly. One model read every word and the other
> read half, which is precisely why the panel exists.
>
> Still free, still MIT, still zero production dependencies, still refuses any address
> that is not 127.0.0.1. github.com/jaymar921/HirayaCoder
>
> #OfflineAI #LocalLLM #VSCode #PrivacyFirst #OpenSource #VisionModels
