# Reading images

*New in 1.1.0.*

You can attach a picture to a message. HirayaCoder looks at it, writes down what is in
it, and then uses that as part of the conversation. It works for photos, screenshots,
error messages, and rough sketches of a screen you want built.

This page explains how it works, what it is good at, and where it falls over.

---

## The short version

1. Click the image button next to the message box.
2. Pick a PNG, JPEG, WEBP, or GIF file.
3. Type your message and send it.

In **Ask** mode you get an answer about the picture. In **Agent** mode the picture
becomes part of the job, so "build this screen" works with a mockup attached.

---

## What is actually happening

This is worth understanding, because it explains most of the behaviour you will notice.

An AI model is a program that predicts text. Most of them only handle text, in and out.
A few of them, called **vision models**, can also take an image as input. The ones you
have installed are listed by `ollama list`, and whether a given one can see is something
Ollama reports about it.

So there are two situations.

**Your model can see.** The picture goes to it directly, along with your message. This
is the simple case and costs nothing extra.

**Your model cannot see.** This used to mean the image button was greyed out. Since
1.1.0 it does not. Instead HirayaCoder sends the picture to a different model, one that
*can* see, and asks it a single question: what is in this image? That answer comes back
as a paragraph of ordinary text, and the paragraph is what your coding model receives.

The second case is the interesting one. It means you can run `llama3.2` for the coding,
which has no vision at all, and still hand it a screenshot. You do not have to switch
models, and you do not have to give up the model you like.

### Why a written description, even when the model can see

There is a second reason this exists, and it applies even to a model that has vision.

In **Agent** mode the model works in a loop. It reads a file, then decides what to do
next, then writes a file, then decides again. That can be eight or ten rounds. The
picture is only attached to the first one, because attaching it to all of them would
mean uploading several megabytes over and over, and on a normal laptop that is slower
than the actual thinking.

So by round four, the model is working on your screenshot without being able to see it
any more. The written description is small enough to carry on every single round, so it
does not disappear. That is why Agent mode always produces one, even on a vision model.

---

## Which model does the looking

By default HirayaCoder picks for you:

1. If the model you selected can see, it does the looking itself. Nothing else loads.
2. Otherwise, the **smallest** installed model that can see does it.

Smallest, not best, and there is a good reason. Ollama keeps one model in memory at a
time. Using a second model means unloading the first one, loading the second, then
loading the first one back. On a 16 GB laptop with no graphics card that is thirty to
sixty seconds of nothing visibly happening. Describing a picture is a simple job, so the
smallest model that can do it is the one that gets you back to work soonest.

If you want to choose yourself, set `hirayacoder.vision.describeModel` to a model name.
It is honoured only if that model is installed and actually reports vision. If it does
not, HirayaCoder picks automatically instead and writes the reason to the log, rather
than silently turning images off on you.

You can turn the whole thing off with `hirayacoder.vision.enabled`. A model that can see
for itself still receives images; only the extra description step stops.

### Getting a model that can see

If nothing you have installed can read images, the button tells you so. One command
fixes it:

```bash
ollama pull minicpm-v4.6
```

It is 1.6 GB, which is small, and it is built for exactly this. It sits alongside
whatever you already use for coding.

---

## Seeing what it read

Under your message there is a collapsed panel labelled **What *model* saw in *file***.
Open it and you get the exact text the vision model produced.

Please use it. It is the difference between two problems that look identical:

- The vision model misread your picture, and everything after that was doomed.
- The vision model read it correctly and the coding model went wrong afterwards.

Those need opposite fixes, and without the panel you cannot tell them apart. If the
description is wrong, the fastest repair is usually to say so in your next message:
"that is a delete button, not a save button".

---

## What it is good at

Measured against six photographs, on the two smallest vision models that exist. The
numbers are in [MODELS.md](MODELS.md#image-recognition-110) and the raw runs are in
[benchmarks/](../benchmarks/README.md).

- **Naming the main thing.** Cat, dog, car, tree, aeroplane. This is reliable, including
  on a 752M model, which is very small.
- **Colour, setting, and count.** "Two puppies in grass", "a yellow car on a road".
  Mostly right.
- **Reading large text.** Signs, headings, big labels. Works more often than not.

Applied to actual work, that translates to:

- A screenshot of an error, so you do not have to retype it.
- A mockup or a sketch of a screen, as the basis for building it.
- A photo of a whiteboard, for the shape of a data model.
- A screenshot of a UI you want changed, so you can point rather than describe.

---

## What it is not good at

Be honest with yourself about this before you rely on it.

- **Small text.** A 752M model reading a stack trace at normal screenshot resolution
  will get some of it wrong, and it will not tell you which parts. Crop and zoom first,
  or paste the text.
- **Exact numbers.** Line numbers, hex colours, version strings, anything where being
  one character off matters. Check them.
- **Precise layout.** It knows a button is near the top. It does not know it is 24
  pixels from the edge.
- **Anything it has not seen.** It describes what is in front of it. It does not know
  your design system or what your icons mean.

The failure that costs you most is the quiet one. A model that misreads a picture does
not say "I am unsure". It writes a confident, well formed paragraph about the wrong
thing. This is why the description is shown to you rather than hidden.

---

## Limits and rules

- **Formats:** PNG, JPEG, WEBP, GIF.
- **Size:** 4 MB per image. The file is checked before it is read, so a huge one is
  rejected rather than loaded into memory. Images get about a third larger when they are
  encoded for sending, and a big one can take minutes on a CPU.
- **The file type is verified.** A `.png` that is really something else is spotted by
  looking at the actual bytes, not by trusting the name.
- **Images belong to one message.** They are sent with the message you attached them to
  and are not carried into the next one. Attached files, which are different, do stay.
- **It is still completely offline.** The picture goes to Ollama on `127.0.0.1` and
  nowhere else, exactly like every other thing this extension sends. Nothing about
  images changes the privacy story.

---

## Speed

Reading a picture is a full model call, so it takes about as long as an ordinary reply.
On a CPU-only laptop that is roughly five to twenty seconds for a small vision model.
The status line tells you which model is reading which file while it happens.

If your coding model cannot see, add the time to load the second model on top. That is
the one part of this that feels slow, and it is why the automatic choice prefers a model
that is already loaded.

Attaching the same picture twice in a row costs nothing the second time. The description
is kept for the session.

---

## Settings

| Setting | Default | What it does |
|---|---|---|
| `hirayacoder.vision.enabled` | `true` | Turn the description step off entirely |
| `hirayacoder.vision.describeModel` | `""` | Name a model to do the looking. Empty means pick automatically |

---

## Next

- [Using it day to day](USING-IT.md)
- [Choosing a model](CHOOSING-A-MODEL.md)
- [What HirayaCoder cannot do](LIMITATIONS.md)
- [The measurements](MODELS.md#image-recognition-110)
