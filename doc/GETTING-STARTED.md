# Getting started with HirayaCoder

The complete first-run walkthrough: what the extension is, whether your computer can
run it, and the four steps to a working install. The
[README](../README.md#quick-start) has the short version of the same four steps.

---

## New here? Start with this

**You do not need to know how to code to try it.** You do need about twenty minutes and
a computer with a bit of room to spare. Here is the honest version of what you are
signing up for.

### What it actually does

You open a folder on your computer, type something like *"make me a webpage with a
to-do list"*, and HirayaCoder creates the files, writes the code, and shows you what it
changed before saving anything. You can then ask it to change things: *"make the buttons
blue"*, *"add a delete button"*.

### What makes it different from ChatGPT or Copilot

| | HirayaCoder | ChatGPT / Copilot |
|---|---|---|
| Cost | Free, forever | Usually a monthly fee |
| Internet | Not needed after setup | Required |
| Your code | Never leaves your computer | Sent to a company's servers |
| Quality | Good, not great — see below | Better |
| Speed | Seconds to minutes, depends on your PC | Fast |

**The trade is real and you should know it before you start.** HirayaCoder runs a small
AI model on your own hardware, and small models are not as clever as the big paid ones.
It handles ordinary tasks well. It struggles with big, vague requests. If you ask for
"a full social media app" you will be disappointed; if you ask for one page, one feature,
or one fix at a time, it does a decent job.

### Will it run on my computer?

The main question is **how much RAM (memory) you have**. Here's a quick guide — you do
not need a fancy graphics card.

| Your computer | Will it work? | What to expect |
|---|---|---|
| 8 GB RAM | Yes, just barely | Slow, and only simple single-file tasks |
| 16 GB RAM, no graphics card | **Yes — this is what it was built for** | A task takes 1–5 minutes. Very usable |
| 16 GB+ with a gaming graphics card | Yes, comfortably | A task takes 20–60 seconds |
| Mac with Apple Silicon (M1–M4) | Yes, very well | A task takes 10–30 seconds |

To check on Windows: press `Ctrl+Shift+Esc`, click **Performance**, then **Memory**.
On a Mac: Apple menu → **About This Mac**.

---

## Getting started

Four steps. Copy and paste the commands exactly.

### Step 1 — Install VS Code

If you do not already have it, download it free from
[code.visualstudio.com](https://code.visualstudio.com). This is the program you will
actually be working in. You need **version 1.85 or newer** — any download from this year
is fine.

### Step 2 — Install Ollama

[Ollama](https://ollama.com) is the free program that runs the AI on your computer.
Download it, install it, and leave it running in the background. It has no window — it
just sits in your system tray or menu bar, and that is normal.

### Step 3 — Download an AI model

Open a terminal and paste one line. (On Windows press the Start button, type
`PowerShell`, and hit Enter. On a Mac press `Cmd+Space`, type `Terminal`, and hit Enter.)

**Pick the line that matches your computer:**

```bash
# 16 GB RAM or more — the best all-round choice, start here
ollama pull gemma4:e2b

# 8 GB RAM, or if the one above is too slow — smaller and faster, but more limited
ollama pull llama3.2:1b
```

This downloads a few gigabytes, so it takes a while on a slow connection. You only ever
do it once.

### Step 4 — Install HirayaCoder

Download the `.vsix` file from the
[Releases page](https://github.com/jaymar921/HirayaCoder/releases), then run:

```bash
code --install-extension hirayacoder-<version>.vsix
```

Replace `<version>` with the number in the filename you downloaded.

### You're ready

1. Open VS Code.
2. Go to **File → Open Folder** and pick a folder — an empty new one is perfect for a
   first try. **This step is required**: HirayaCoder refuses to do anything without a
   folder open, so that it can never touch files outside it.
3. Press `Ctrl+Shift+H` (`Cmd+Shift+H` on a Mac).
4. Type something and press Enter.

Good first things to type:

- `make a webpage that says hello with a big blue button`
- `create a simple to-do list app in one HTML file`
- `explain what this project does` *(in a folder that already has code)*

**If anything above is unclear once you are in there, press *Guide* in the chat header.**
It opens the same four setup steps and — more usefully — what to expect: how long a task
takes, why a refusal is usually the checks working, and what a small model is and is not
good at.

There is a longer, friendlier walkthrough in
[TUTORIAL.md](https://github.com/jaymar921/HirayaCoder/blob/main/doc/TUTORIAL.md).

---

---

## Next

- [Using it day to day](USING-IT.md) — the three modes, watching a run, and the habits that make small models work
- [What it cannot do](LIMITATIONS.md) — read this before you decide whether it fits your work
- [When something goes wrong](TROUBLESHOOTING.md)
- [Choosing a model](CHOOSING-A-MODEL.md)
- [A longer, friendlier walkthrough](TUTORIAL.md)
