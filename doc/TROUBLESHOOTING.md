# When something goes wrong

Small AI models make mistakes. HirayaCoder has built-in checks that catch the common
ones, so several of the messages below are the system **working**, not breaking.

---


Small AI models make mistakes. HirayaCoder has built-in checks that catch the common
ones, so a few of the messages below are the system **working**, not breaking.

## "It refused to write the file"

**This is usually a good thing.** HirayaCoder checks the AI's work before saving and
blocks writes that would damage your files — a half-written file, code with a missing
bracket, or a rewrite that quietly deletes something other files depend on.

Just ask again. It usually gets it right the second time.

## "It said it was done but nothing changed"

A known habit of small models: reporting success without doing the work. HirayaCoder
checks and will tell you plainly when this happens. Ask again, and include the exact
file name this time.

## "It's taking forever"

Normal on a laptop with no graphics card — a few minutes per task is expected. If it is
much worse than that, the model is probably too big for your RAM. Try `llama3.2:1b`.

## "The code it wrote doesn't work"

Try, in order:

1. Paste the error message into the chat. It is quite good at fixing errors it can see.
2. Ask for a smaller piece of the problem.
3. Switch to a bigger model if your RAM allows it.

## "It can't run my program"

HirayaCoder can only run programs already installed on your computer. If you ask it to
run a Python script, you need Python installed. It will still *write* the code — it just
cannot run it for you.

It also only runs a fixed list of well-known commands. **This is the whole list** —
anything else is refused on purpose, so a mistake by the AI cannot damage your system:

| For | It may run |
|---|---|
| JavaScript / Node | `node`, `npm`, `npx`, `yarn`, `pnpm` |
| Python | `python`, `python3`, `pip`, `pip3`, `pytest` |
| Java | `java`, `javac`, `mvn`, `gradle` |
| Go, Rust, .NET | `go`, `cargo`, `dotnet` |
| Testing and formatting | `jest`, `mocha`, `vitest`, `ava`, `tsc`, `eslint`, `prettier` |
| Other | `git`, `make`, `ollama` |

Two things worth knowing before they surprise you:

- **Everyday shell commands are not on the list** — `rm`, `ls`, `mkdir`, `curl` are all
  refused. Creating files and folders happens through the safe file tools instead, so
  `mkdir` is never needed: writing a file creates the folders above it.
- **No shell is involved.** Commands run directly, so `&&`, `|`, and `>` are refused
  rather than interpreted. One command at a time.

You can add to the list in HirayaCoder's settings. The AI cannot add to it itself.

---

---

## It cannot read my image

Two different causes, and the message tells you which:

- **"None of your installed models can read images"** — nothing you have installed has
  vision. Pull one: `ollama pull minicpm-v4.6`. It is 1.6 GB and it is the smallest
  thing that does the job.
- **The description is wrong** — the vision model misread the picture. Open the
  *What … saw* panel under your message to see exactly what it read, then say what it
  got wrong in your next message. Full detail in
  [IMAGE-RECOGNITION.md](IMAGE-RECOGNITION.md).

---

## Next

- [What it cannot do, on purpose and otherwise](LIMITATIONS.md)
- [Choosing a model](CHOOSING-A-MODEL.md)
- [The security model, if a refusal surprised you](SECURITY.md)
