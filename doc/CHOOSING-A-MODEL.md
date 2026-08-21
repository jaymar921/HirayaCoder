# Choosing a model


Model names are confusing. Here is a plain-language ranking, based on
[real measurements](https://github.com/jaymar921/HirayaCoder/blob/main/doc/MODELS.md)
rather than on the descriptions.

| Model | Download | Needs | Verdict |
|---|---|---|---|
| `gemma4:e2b` | 7.2 GB | 16 GB RAM | **Best starting point.** Fastest to a correct answer |
| `qwen3.5:4b` | 3.4 GB | 8–16 GB RAM | Good, smaller download |
| `llama3.2:1b` | 1.3 GB | 8 GB RAM | For low-spec machines. Simple single-file jobs only |
| `gemma4:e4b` | 9.6 GB | 32 GB RAM or a Mac | The strongest, if you have room |
| `qwen3.5:0.8b` | 1.0 GB | — | Last resort. Writes files correctly; does not finish an app |

## What a very small model will and will not do

Worth setting expectations, because the honest answer is more useful than the
encouraging one. Measured on a 98-line brief for a complete React app:

- **A 0.8B model now scaffolds the project, writes every file the request named, and
  installs the dependencies.** In the previous release the same model spent its whole
  session listing the directory and wrote nothing.
- **It does not get the app working.** The build still fails, and no model at this size
  finished the app in any of our runs.

So a very small model is genuinely useful for *"write me this file"* and for the parts of
a big request that are mechanical. Handing it a whole application and walking away is not
something we can recommend yet, and the numbers behind that are in
[the evaluation notes](https://github.com/jaymar921/HirayaCoder/blob/main/doc/SESSION-ANALYSIS-0.9.0.md).

Switch models any time from the dropdown at the top of the chat — no reinstall needed.

**One thing that surprises people:** a graphics card makes it *faster*, not *smarter*.
A bigger model gives better answers; a better GPU gives the same answer sooner.

---

---

## If you want to attach images

Reading a picture needs a model with the **vision** capability, and it does not have to
be the model you code with. See
[IMAGE-RECOGNITION.md](IMAGE-RECOGNITION.md#which-model-does-the-looking).

| Model | Download | Reads images | Notes |
|---|---|---|---|
| `minicpm-v4.6` | 1.6 GB | Yes | Built for this. The recommended second model |
| `qwen3.5:2b` | 2.7 GB | Yes | Codes and reads images |
| `qwen3.5:4b` | 3.4 GB | Yes | Same, larger |
| `gemma4:e2b` | 7.2 GB | Yes | The all-round recommendation already reads images |
| `llama3.2` | 2.0 GB | No | Pair it with `minicpm-v4.6` |

---

## Next

- [The measurements behind the ranking](MODELS.md)
- [What a small model cannot do](LIMITATIONS.md)
