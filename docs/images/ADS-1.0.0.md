# HirayaCoder 1.0.0 — launch ad set

Four square (1:1) ads for the 1.0.0 launch, with the caption each one ships with, plus a
single caption for posting all four together as a carousel.

Rendered at **2160×2160** from the sources in `src/` (1080×1080 CSS pixels at
`--force-device-scale-factor=2`). 1:1 is the safe ratio everywhere — it is the native
LinkedIn/Instagram feed shape, and X and Facebook centre-crop it without losing content.

| # | Image | Source | The one thing it argues |
|---|---|---|---|
| 1 | `ad-1-offline.png` | `src/ad-1-offline.html` | Your code never leaves your machine |
| 2 | `ad-2-agentic.png` | `src/ad-2-agentic.html` | Fully agentic even on a 1B model |
| 3 | `ad-3-approval.png` | `src/ad-3-approval.html` | Nothing is written without your approval |
| 4 | `ad-4-launch.png` | `src/ad-4-launch.html` | 1.0 is out, and here is how to start |

Order matters if you post them as a carousel: 1 is the hook, 2 is the proof it actually
works, 3 is the objection ("will an AI wreck my project?"), 4 is the ask.

Regenerating them is the same command as the README images — see
[`src/README.md`](src/README.md).

---

## Ad 1 — `ad-1-offline.png`

> Your AI coding assistant is reading your code on someone else's servers right now.
>
> HirayaCoder does not. It runs entirely on your own machine through Ollama — no
> account, no subscription, no internet connection. Turn your Wi-Fi off and it keeps
> working. That is not a privacy policy, it is the architecture: a non-loopback address
> is refused in the code itself, before any connection is opened.
>
> Free, MIT-licensed, and zero production dependencies. Nothing third-party ships inside
> it.
>
> HirayaCoder 1.0 for VS Code is out now.

## Ad 2 — `ad-2-agentic.png`

> Most "local AI" extensions give a small model autocomplete and call it a day.
>
> HirayaCoder gives a 1B model the whole job: it reads your files, writes them, deletes
> them, and runs your build — across multiple files, on its own. Two loop strategies sit
> behind one driver, so native tool-calling runs on capable models and a constrained
> one-action-per-turn loop runs on the small ones. The mechanism changes with the model.
> The reach never does.
>
> Which matters because the model that fits on your laptop is the small one.
>
> 16 GB and no graphics card is the machine it was built for.

## Ad 3 — `ad-3-approval.png`

> "I am not letting an AI loose on my project."
>
> Correct — and neither are we. Every write shows you the diff first and waits. Nothing
> reaches disk until you approve it. Deleting a file asks even when you have turned
> automatic edits on, because a wrong write is visible in the diff and a wrong delete of
> an uncommitted file is gone.
>
> Underneath that: the agent cannot leave the folder you opened, commands come from a
> fixed allow-list with no shell, and the write guards refuse a truncated file, a
> dropped export, or a function replaced by a stub.
>
> Those guards exist because four different models produced six damaged files in one
> seventeen-run sweep. Every one of them parsed cleanly.

## Ad 4 — `ad-4-launch.png`

> HirayaCoder 1.0 is out.
>
> A free, fully offline AI coding agent for VS Code, built for 16 GB laptops with no
> graphics card rather than for top-spec dev machines.
>
> Three steps to running:
> 1. Install Ollama and leave it running
> 2. `ollama pull gemma4:e2b`
> 3. Install HirayaCoder, open a folder, press Ctrl+Shift+H
>
> Three modes when you get there: Agent writes, Plan looks without touching anything and
> hands back a checklist you can edit and run, Ask just answers.
>
> *Hiraya* (Filipino) — imagination, aspiration, the spark of an idea before it becomes
> real.

**Once the Marketplace listing is live**, swap the install line in the ad-4 caption and
in the carousel caption for *"Search HirayaCoder in the VS Code Extensions view"*, and
re-render `ad-4-launch.png`, whose footer carries the same route. Until then every caption
here points at GitHub, which works today — the 0.7.0 images shipped a "search the
Extensions view" line months before there was anything to find, and that is the mistake
this note exists to prevent.

---

## The one caption for all four

Use this when posting the set together — a carousel, an album, or a single launch post
with all four attached.

> **HirayaCoder 1.0 is out — a free AI coding agent that never sends your code anywhere.**
>
> Four things worth knowing about it, one per image:
>
> **1. It is genuinely offline.** It talks to Ollama on 127.0.0.1 and nothing else. A
> non-loopback address is refused in the code, so "your code stays local" is a property
> of the architecture rather than a promise in a policy. No account, no telemetry, no
> production dependencies.
>
> **2. It is fully agentic on small models.** Not autocomplete — it reads, writes,
> deletes and runs your build across multiple files on its own, down to 1B parameters.
> Capable models get native tool-calling; small ones get a constrained one-action-per-turn
> loop. Same reach, different mechanism.
>
> **3. You approve everything.** Every write shows a diff and waits. Deletes ask even
> with auto-edit on. The agent cannot leave your folder, and commands run from a fixed
> allow-list with no shell.
>
> **4. It was built for the machine you actually have.** 16 GB, no graphics card, a task
> in one to five minutes. Honest about the trade too: small models handle one file, one
> feature, one fix at a time well, and a whole application badly.
>
> Free and MIT-licensed. Install Ollama, `ollama pull gemma4:e2b`, then grab the
> extension from github.com/jaymar921/HirayaCoder.
>
> #OfflineAI #LocalLLM #VSCode #PrivacyFirst #OpenSource
