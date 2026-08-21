# What HirayaCoder cannot do

Every tool has a shape. This page is the honest description of this one's, so you can
decide whether it fits your work before you spend an evening finding out.

Two kinds of limit are listed here and it is worth keeping them apart:

- **Limits by design.** Things HirayaCoder refuses to do because doing them would make
  it a different and worse tool. These are not going to change.
- **Limits of the technology.** Things a small model running on your own laptop is not
  currently good at. Some of these will improve. Most of them will improve slowly.

---

## Limits by design

These are choices. They are the reason the tool is worth using, and they cost real
convenience.

### It never talks to the internet

The only address it will connect to is `127.0.0.1`, which is your own machine. A
non-loopback address is rejected in code before any connection opens. This means:

- No cloud models. No GPT, no Claude, no Gemini, whatever your subscription is.
- No looking up documentation, no fetching a package from the web, no searching.
- No sharing a session with a teammate.

If your workflow depends on a frontier model, this is not the tool. That is a real
answer, not a soft one.

### It cannot leave the folder you opened

Every read, write, and delete is confined to your open workspace folder. It cannot touch
your home directory, a sibling project, or anything outside. There is no setting that
turns this off.

It also refuses to run in an untrusted workspace, and it does nothing at all until you
have a folder open.

### It runs only a fixed list of commands

`node`, `npm`, `git`, `pytest`, `mvn`, and about twenty more. Everything else is
refused. Notably:

- **No shell.** Commands run directly, so `&&`, `|`, `>` and `$(...)` are refused
  rather than interpreted. One command at a time.
- **No `rm`, `ls`, `mkdir`, `curl`, `wget`.** File work goes through the safe file
  tools instead.
- **Anything that reaches the network or publishes code** (`git push`, `npm publish`)
  asks for confirmation regardless of your settings.

You can add binaries to the list in settings. The model cannot add to it.

### It asks before it writes

By default every file write shows you a diff and waits. You can turn that off with Auto
Edit, and deletes still ask even then. If you want an agent that works unattended for an
hour and shows you the result, that is not what this is.

### It cannot see your running program

There is no browser, no debugger attached, no screenshot of your app. It can run your
build and read the output. It cannot click a button and see what happened.

Since 1.1.0 you can [attach a screenshot yourself](IMAGE-RECOGNITION.md), which covers
some of the same ground manually.

### There is no telemetry, so there is no crash reporting

Nobody sees your errors but you. If something breaks, the log in the output channel is
the whole record, and an issue on GitHub is the only way we learn about it.

---

## Limits of small models

This is the part people underestimate. HirayaCoder runs whatever model your laptop can
hold, and that model is small. Small models are genuinely useful and genuinely limited,
and the limits are specific rather than general.

### It does not finish a whole application

Measured, not guessed. On a 98-line brief for a complete React app:

- A 0.8B model scaffolds the project, writes every file the request named, and installs
  the dependencies.
- It does not get the app working. The build fails, and **no model at this size finished
  the app in any of our runs.**

One model passed the scaffold, structure, install and build checks and shipped an app
whose only button incremented the demo counter it started with. Four green gates and
nothing that worked.

So: one file, one feature, one fix at a time is where this tool earns its keep. A whole
application handed over and walked away from is not something we can recommend yet. The
numbers are in [SESSION-ANALYSIS-0.9.0.md](SESSION-ANALYSIS-0.9.0.md) and
[MODELS.md](MODELS.md).

### It is slow

On a 16 GB laptop with no graphics card, expect one to five minutes for an ordinary
task. Each step in an agent run is a separate model call, and a run can be eight steps.

A graphics card makes it **faster, not smarter**. A bigger model makes it smarter, not
faster. These are separate knobs and people mix them up constantly.

### It repeats itself

The classic small-model failure is not bad code, it is the same correct-looking action
forever. HirayaCoder keeps a record of everything the agent has already done and puts it
back in front of the model each turn, which fixes most of it. It does not fix all of it.

### It reports success it did not achieve

Small models say "I have created and tested the app" having written nothing. This is
common enough that completion is checked against what actually changed on disk rather
than against what the model says. When the check fires you are told plainly. When it
does not fire, and the model was wrong anyway, you find out later.

### It writes damaged files

Four different models produced six damaged files in one seventeen-run sweep: deleted
exports, a CommonJS module silently rewritten as ESM, an implementation replaced by an
empty object. Every one of them parsed cleanly. There are guards for each of these
specific shapes, and a guard only catches the shape it knows.

### It does not know your codebase

It sees what fits in the context window, which on a 1B model at medium settings is about
1800 tokens for everything: the system prompt, your message, the file listing, and the
result of its last action. It is not holding your architecture in its head. Naming the
file you mean is worth more here than it would be with a large model.

### It forgets between sessions, mostly

There is memory, in three layers, and it is genuinely useful. It is not the same as a
model that has read your whole repository.

---

## Limits of image recognition

New in 1.1.0, and [documented in full](IMAGE-RECOGNITION.md). The short version:

- **Small text is unreliable.** A stack trace in a normal screenshot will be partly
  misread, and you will not be told which parts.
- **Exact values need checking.** Line numbers, hex colours, version strings.
- **Precise layout is out of reach.** It knows a button is near the top. It does not
  know it is 24 pixels from the edge.
- **A misread is silent.** The model does not hedge. It writes a confident paragraph
  about the wrong thing, which is why the description is shown to you rather than
  hidden.

Formats are PNG, JPEG, WEBP, and GIF, at up to 4 MB each.

---

## Things that are not limitations, though they look like one

Worth listing, because these get reported as bugs.

**"It refused to write the file."** Usually the write guards working. A half-written
file, unbalanced brackets, or a rewrite that deletes an export other files depend on.
Ask again.

**"It said the tool was not available."** Plan mode and read-only turns remove the
writing tools structurally. The model is not being difficult, the tool genuinely does
not exist for that turn.

**"It asked me before running the build."** That is the permission gate. Turn on
auto-approve for scripts if you want it not to.

---

## Where it does not compete

| | HirayaCoder | A cloud assistant |
|---|---|---|
| Cost | Free, forever | Usually a monthly fee |
| Internet | Not needed | Required |
| Your code | Never leaves your computer | Sent to a company's servers |
| Quality | Good on small tasks | Better on everything |
| Speed | Seconds to minutes | Fast |
| Whole applications | No | Sometimes |
| Works on a plane | Yes | No |

The trade is real. Nobody should choose this because they think it is secretly as good.
Choose it because the code not leaving your machine is worth something to you, or
because there is no budget, or because there is no connection.

---

## Next

- [Choosing a model](CHOOSING-A-MODEL.md) — the ranking, and what each size actually manages
- [The measurements](MODELS.md) — the full tables behind everything claimed here
- [When something goes wrong](TROUBLESHOOTING.md)
- [The security model](SECURITY.md)
