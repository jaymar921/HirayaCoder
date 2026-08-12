# HirayaCoder — Context Translator Prompt

Drives `core/contextTranslator.js`. This is a small, cheap, separate call to the **same local model** (no extra download needed) that runs after an agent turn (or after every step, on High thinking capacity for Tier B — see `PROMPT.md` section 5) to distill what just happened into short, durable, plain-text memory entries.

This is the mechanism that compensates for a 1B model having no real long-term memory: instead of relying on the model to "remember" across turns, HirayaCoder externally remembers *for* it, and hands the summary back in on the next request.

```
Here is one step from a coding session:

{step_summary}

Describe what changed in that step, in one short phrase of at most 12 words.

Use only information from the step above. Describe the substance of the change, not the
mechanics — say what the code now does, not that a file was edited or how many lines were
written. Do not mention file names, line counts, or the assistant itself.

Reply with the phrase only. No bullet points, no quotes, no explanation.
```

**Why this prompt asks for one phrase instead of formatted notes**

An earlier version asked the model for "0-3 notes, one per line, starting with `- `, or exactly NONE". Against a real `llama3.2:1b` that contract failed in four distinct ways, each observed live:

1. **It summarized the wrong thing.** With the existing-memory block placed before the step, the model summarized the *old notes* — storing "Email validation added" for a step that actually fixed an N+1 query.
2. **It would not answer NONE.** Handed a plain `read_file`, it produced three notes narrating the read, which then occupied three of the five recall slots at Medium capacity and pushed the session's real work out of the window.
3. **It echoed the step format.** When the step summary used `Label: value` lines, the notes came back as `- File: src/x.js`, `- Action: write_file`.
4. **It drifted.** "Edited by: Offline Coding Assistant."
5. **It copied the few-shot examples.** An earlier version of *this* one-phrase prompt carried three "Good answers" samples. `llama3.2:1b` returned the first sample verbatim — "added email validation with a regex and a server-side check" — for a step that fixed an N+1 query. It happened to look correct on a step that really was about email validation, which is what made it dangerous. Concrete examples are a liability at this size: the model reaches for them instead of for the input. Hence no examples here, and a code-side check (`sharesContentWith`) that rejects any phrase with no significant word in common with the step it claims to describe.

The through-line is that a 1B model is unreliable at *formatting contracts and self-assessment*, but reasonably good at *one short completion*. So the division of labor changed: the extension supplies everything it already knows for certain — which action ran, which file it touched, whether it succeeded — and the model is asked only for the part that genuinely needs language, in the simplest form it can be asked.

`contextTranslator.js` then composes the stored note, e.g. `- Edited src/signup.js: added email validation with a regex and a server-side check.` The file path is always correct because the extension wrote it, not the model.

**Notes for implementers:**
- `{step_summary}` — a short, extension-generated prose summary of the step, not the raw model output, to keep this call cheap and fast. Keep it as prose: a structured block invites the model to echo its labels.
- Whether a step is worth remembering at all is decided in code (`UNMEMORABLE_ACTIONS`), never by asking the model. Reads, listings, and searches skip the call entirely.
- An unusable phrase (empty, narration, a field label, or too short) falls back to the step's own `thought` from the agent loop, which is already a one-line statement of intent and costs nothing extra.
- Notes are appended via `memoryStore.append()`, which suppresses near-duplicates as well as exact ones.
- `agent/nativeToolLoop.js`/`agent/reactLoop.js` are only invoked at all when the chat tab's mode button is set to **Agent** (see `PROMPT.md` section 6). In **Plan** mode, the same driver runs with `write_file`/`delete_file`/`run_script` omitted from the schema entirely (not just gated), and its final output is rendered as a plan checklist instead of applied. In **Ask** mode, neither loop runs at all — the extension answers directly with the model, no tools offered.
