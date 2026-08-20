# Using HirayaCoder day to day

What the extension does once it is installed and you have a folder open: the three
modes, what the panel is showing you while a run happens, and the request habits that
make the difference between a small model finishing and a small model spinning.

New in 1.1.0: [attaching images](IMAGE-RECOGNITION.md).

---


## Watching a run happen

<p align="center">
  <img src="https://raw.githubusercontent.com/jaymar921/HirayaCoder/main/docs/images/live-session.png" width="900" alt="The live Steps panel in HirayaCoder v0.8.0. Six steps of a TODO app build, each showing the action, the file it touched, and the model's own stated reason — reading README.md to extract the project structure, scaffolding the React project, writing the useTodos hook, and running npm run build." />
</p>

A local model can take the better part of a minute per step, so the panel shows you each
one as it happens: what it is doing, which file, and the reason the model gave for it.
It opens when the first step arrives and folds away when the turn ends — and if you open
or close it yourself, it stays how you left it.

That matters most when a run is going wrong. Six steps in, you can see it re-reading the
same file or editing something you never asked about, and stop it — rather than finding
out from the summary ten minutes later.

## Small models that finish

<p align="center">
  <img src="https://raw.githubusercontent.com/jaymar921/HirayaCoder/main/docs/images/knows-what-it-has.png" width="900" alt="Before and after, measured on qwen3.5:0.8b. Before v0.8.0: three identical list_files calls and the run ended, 5 of 7 sessions this way and zero files written. After: the second repeat is answered with a WHAT YOU ALREADY HAVE block listing the folders already listed, and the third step writes a file." />
</p>

The classic failure of a very small model is not bad code — it is the same correct-looking
action forever. HirayaCoder keeps its own record of every file the agent has read, written
and deleted, every folder it has listed and every command it has run, and puts that record
in front of the model on each turn.

A repeated read is no longer fatal either. Asking twice for a directory listing used to end
the run; now the agent is handed back what it already had, told what to do next, and only
stopped if it asks a third time.

## Long requests, one step at a time

<p align="center">
  <img src="https://raw.githubusercontent.com/jaymar921/HirayaCoder/main/docs/images/your-structure-is-the-plan.png" width="900" alt="The structure you drew is the plan. On the left, a folder tree from a request with comments beside each file. On the right, the six steps HirayaCoder read out of the request's headings and the full paths it joined the tree back together into." />
</p>

If you paste in a long, structured request — headings, numbered steps, a folder tree —
HirayaCoder works through it **one section at a time**, in your order, using your words.
It does not ask the model to summarise your request first: your headings already are the
plan, and reading them takes no guesswork, so this works the same on a 0.8B model as on a
large one.

Two details worth knowing, because they let you steer it:

- **Draw the folder structure you want** and it will be read as real paths. `src/` plus
  `components/` plus `TodoItem.jsx` becomes `src/components/TodoItem.jsx`.
- **Put a comment next to a file** — `TodoItem.jsx  # one todo row, with edit and
  delete` — and that comment becomes the instruction for writing it. A file with a
  comment beside it may be rewritten if it already exists; a file without one is left
  alone. That is how you say "this one is yours to write" and "this one came from the
  scaffolding tool, don't touch it".

A section that only states rules — "React functional components only, no UI libraries" —
is not treated as a step. It is carried underneath every step instead.

Short requests are unaffected. "Fix the typo in the heading" runs exactly as it always
did.

## Asked the wrong way

<p align="center">
  <img src="https://raw.githubusercontent.com/jaymar921/HirayaCoder/main/docs/images/asked-the-wrong-way.png" width="900" alt="The same request put to llama3.2:1b three ways. Constrained to the action schema it replies with a done action; asked for JSON it replies with an empty object; asked in plain words it returns a complete React component." />
</p>

The smallest models have a problem that looks like incompetence and is not. Asked to
choose a tool and fill in its arguments as JSON, a 1B model will reliably answer with the
simplest thing that satisfies the format — often just "done". Asked in plain English to
write a file, the same model writes it correctly.

So for a file **your request named**, HirayaCoder stops asking the model what to do. The
decision is already made: the action is a file write, the path came from your own
request, and the only question left is what goes in the file.

It is worth being precise about what that does and does not allow, because it is the one
place the model is not choosing:

- It can only ever write a file **you named** in your request.
- It never touches `package.json`, lockfiles, `.env`, or anything inside `node_modules`,
  `dist` or `.git`.
- It never replaces a file that already exists unless you put a comment next to it.
- Every write still shows you the diff and waits for approval, exactly as before, and
  still goes in the audit log.

When it writes a file, it first reads what the files around it actually export, so the
imports line up rather than being guessed at.

## The three modes

There is a row of buttons at the top of the chat. You can ignore them at first —
**Agent** is the default and is what you want most of the time.

| Mode | Use it when |
|---|---|
| **Agent** | You want it to actually write or change files. The normal choice. |
| **Plan** | You want to see what it *would* do first, without it touching anything. |
| **Ask** | You just have a question. It will not change any files. |

You do not have to switch to Ask to ask a question — if you say "hello" or "what does
this file do", Agent mode notices and just answers you.

## Attaching a picture

Click the image button beside the message box and pick a PNG, JPEG, WEBP, or GIF. In Ask
mode you get an answer about the picture; in Agent mode the picture becomes part of the
job, so "build the screen in this mockup" works.

This is available even if the model you selected cannot see images. In that case
HirayaCoder passes the picture to whichever installed model can, gets a written
description back, and gives that to your coding model. Under your message, a panel
labelled *What … saw* shows exactly what was read, which is how you tell a misread
picture from a bad answer.

If nothing installed can read images, `ollama pull minicpm-v4.6` is the smallest fix.

Full detail, including what it gets wrong: [IMAGE-RECOGNITION.md](IMAGE-RECOGNITION.md).

## Nothing changes without your say-so

By default, every time it wants to write to a file, you get a prompt with a **Review
diff** button showing exactly what changes. Nothing is saved until you approve.

Once you trust it, you can turn on **Auto Edit** to skip those prompts. Deleting a file
always asks, even then.

## Tips that make a real difference

- **Ask for one thing at a time — or structure the big ask.** "Add a delete button" works
  far better than "add delete, edit, sorting, and dark mode" thrown in as one sentence.
  If you do want the big one, give it headings, numbered steps or a folder tree, and it
  will work through them one at a time — see
  [Long requests, one step at a time](#long-requests-one-step-at-a-time).
- **Name the file** if you know it. "Change the title in index.html" beats "change the
  title".
- **It remembers this conversation**, so you can say "make it bigger" and it knows what
  "it" is.
- **Be specific about what is wrong.** "The button doesn't do anything when I click it"
  is much more useful than "it's broken".

---

---

## Next

- [Reading images](IMAGE-RECOGNITION.md) — attaching a screenshot or a photo to a message
- [What it cannot do](LIMITATIONS.md)
- [When something goes wrong](TROUBLESHOOTING.md)
- [Every setting, in detail](FEATURES.md)
