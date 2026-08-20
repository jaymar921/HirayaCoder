'use strict';

/**
 * Image recognition — turning a picture into words the rest of the agent can use.
 *
 * `features/imageContext` reads an image off disk and hands back base64. This module is
 * the step after: it asks a vision model what the picture actually contains and returns
 * that as plain text. Everything downstream — the ReAct loop, the native tool loop, Ask
 * mode's single call, the summary — consumes text and nothing else, so a description is
 * the only form in which an image can reach them.
 *
 * ## Why a description exists at all, when Ollama accepts images directly
 *
 * Three separate reasons, and each one on its own would be enough.
 *
 * **The picture does not survive the loop.** Images ride on the first message only —
 * see `AgentSession.images` for why re-uploading 5 MB of base64 every turn is not an
 * option. So on turn four of an eight-step run the model is working from a conversation
 * about an image it can no longer see. A description is a hundred tokens and can be
 * carried on every turn.
 *
 * **Most models cannot see.** `llama3.2` is the model a lot of people are actually
 * running, and it has no vision capability at all. Before this, attaching an image to
 * it was simply refused. Now the picture goes to whichever vision model is installed,
 * the description comes back, and the coding model works from that. The user does not
 * have to switch models to use a screenshot.
 *
 * **A description can be checked.** A model that hallucinates an image is invisible when
 * the image is a blob on a message; when it is a paragraph of text in the transcript,
 * the user reads "a red error dialog" over their green one and knows immediately.
 *
 * ## Why the active model is preferred even when it is the worse describer
 *
 * Ollama holds one model resident at a time. Describing with a different model evicts
 * the coding model and pays its load time twice — on a 16 GB laptop with no GPU that is
 * thirty to sixty seconds of nothing happening, before the actual request has started.
 * When the selected model can see, using it is free; when it cannot, the smallest
 * installed vision model is chosen, because a description is a read rather than a piece
 * of reasoning and the smallest model that can do it is the one that finishes soonest.
 *
 * @module core/imageRecognition
 */

const crypto = require('crypto');

const logger = require('../utils/logger');

/**
 * What the describer is asked for, per purpose.
 *
 * ## Why there are two of these and not one
 *
 * The two callers want genuinely different things out of the same picture, and a single
 * prompt serves neither well.
 *
 * Ask mode is a person holding up a photograph. What matters is the subject, what it is
 * doing, and how it looks — the answer to "what is this?" is a sentence about a dog, not
 * an inventory of pixel regions.
 *
 * Agent and Plan mode are a coding agent that will act on what it is told. There the
 * priority inverts: every character of text in the image outranks every adjective,
 * because a misread identifier sends the agent to edit a file that does not exist, and
 * a wrong colour costs nothing. So the task prompt puts transcription first and says
 * plainly that guessing is worse than admitting the text is unreadable.
 *
 * Both are short and numbered on purpose. A 0.8B model given a paragraph of nuanced
 * instruction answers the paragraph; given four numbered points it answers the points.
 */
const PROMPTS = {
  answer: [
    'Look at this image and describe what is in it.',
    '',
    'Cover these, in order:',
    '1. The main subject, in a few words.',
    '2. What it is doing, or how it is arranged.',
    '3. The setting, the colours, and anything else that stands out.',
    '4. Any text, numbers, or labels you can read, copied exactly.',
    '',
    'Rules:',
    '- Describe only what you can actually see. Do not guess at anything outside the frame.',
    '- If you are unsure what something is, say so. A wrong confident answer is worse than an unsure one.',
    '- Write plain prose, under 150 words. No headings and no bullet points.',
  ].join('\n'),

  task: [
    'You are the eyes of a coding agent. It cannot see this image. Your description is',
    'the only thing it will ever get, so write down what it needs in order to do the work.',
    '',
    'Cover these, in order:',
    '1. What kind of image this is — a screenshot, a diagram, a photo, a UI mockup, an error message.',
    '2. Every piece of text, code, number, or label in it, copied exactly as written.',
    '3. The layout: what is where, what is grouped with what, what is a button, a field, or a panel.',
    '4. Colours, sizes, and spacing, where they look deliberate rather than incidental.',
    '',
    'Rules:',
    '- Point 2 matters more than the rest put together. A misread filename sends the agent to the wrong file.',
    '- If text is too small or too blurred to read, write "unreadable" rather than guessing at it.',
    '- Never invent a filename, an error code, or a line of code that is not visibly there.',
    '- Describe only. Do not suggest what should be done about any of it.',
    '- Under 250 words.',
  ].join('\n'),
};

/**
 * A describer denying that it can see.
 *
 * ## Why this is checked rather than trusted
 *
 * Found by `tools/bench-vision.js`, once in twenty-four runs of `qwen3.5:0.8b` — a
 * model that reports the vision capability, that was sent the image, and that had
 * described the same photograph correctly on the previous sample. The reply was:
 *
 *   "I cannot see this image. I am an AI model designed to process text and provide
 *    information, but I do not have the ability to view or interpret visual content…"
 *
 * A small model's text-only training reasserting itself over what it was actually
 * handed. Left alone, that paragraph becomes the description: it is stored, put in
 * front of the coding model as "what is in this picture", and shown to the user in the
 * panel. The coding model then works from a statement that no image exists, which is
 * strictly worse than being told the read failed.
 *
 * So it is treated as a failed call, not as a description. `describe` already has an
 * honest failure path, and this is one.
 *
 * The pattern is deliberately narrow. It requires a first-person inability *plus* a
 * visual object, so an ordinary description containing "I cannot see the licence plate
 * clearly" — which is exactly the hedging the prompt asks for — is not caught by it.
 */
const REFUSAL =
  /\b(?:i (?:cannot|can't|can not|am unable to|don't have the ability to|do not have the ability to)|as an ai(?: model| language model)?,? i (?:cannot|can't))\b[^.]{0,80}\b(?:see|view|interpret|process|analyz|analys|look at|access)\w*\b[^.]{0,60}\b(?:image|images|picture|photo|photograph|visual|screenshot)/i;

/**
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeRefusal(text) {
  // Only the opening matters. A model that produces a real description and then
  // volunteers a disclaimer at the end has still described the picture, and discarding
  // that would throw away a good answer over its last sentence.
  return REFUSAL.test(text.slice(0, 400));
}

/**
 * Hard ceiling on a stored description, in characters.
 *
 * A describer that ignores the word limit and free-associates for two thousand words
 * would otherwise spend the whole Tier B prompt budget on one picture, evicting the
 * task itself. Truncation is from the head, which is where the subject is.
 */
const MAX_DESCRIPTION_CHARS = 1600;

/**
 * Token ceiling for one description call.
 *
 * Roughly twice what the 250-word limit needs. Generous enough that a model that
 * numbers its points is not cut off mid-sentence, tight enough that a model stuck in a
 * loop stops rather than running to the request timeout.
 */
const DESCRIBE_NUM_PREDICT = 640;

/**
 * Descriptions already produced, keyed by image content plus purpose plus model.
 *
 * Attaching the same screenshot to three consecutive messages is completely ordinary,
 * and each description is a full model call — thirty seconds or more on CPU. The key
 * includes the model and the purpose because a different model or a different prompt is
 * a different answer, not a cache hit.
 *
 * Bounded rather than unbounded: this lives for the lifetime of the extension host, and
 * a base64 fingerprint is small but a description is not free.
 *
 * @type {Map<string, string>}
 */
const cache = new Map();

/** Descriptions kept before the oldest is evicted. */
const CACHE_LIMIT = 32;

/**
 * @param {string} base64
 * @param {string} purpose
 * @param {string} model
 * @returns {string}
 */
function fingerprint(base64, purpose, model) {
  // sha256 of the bytes, not the whole base64 string as a key: the string is megabytes
  // and would be held in the Map forever.
  const digest = crypto.createHash('sha256').update(base64).digest('hex').slice(0, 32);
  return `${model} ${purpose} ${digest}`;
}

/**
 * @param {string} key
 * @param {string} description
 */
function remember(key, description) {
  // Re-inserting moves the entry to the end of the Map's insertion order, so a
  // repeatedly used image is not the one evicted.
  if (cache.has(key)) cache.delete(key);
  cache.set(key, description);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Choose which model does the looking.
 *
 * @param {import('./modelDiscovery').DiscoveredModel[]} models  Everything installed.
 * @param {object} [opts]
 * @param {string} [opts.activeModel]  The model the user selected for coding.
 * @param {string} [opts.preferred]    From settings. Honoured only if it is installed
 *   and can actually see — a stale name in settings must not silently disable images.
 * @returns {{name: string, reason: string, isActive: boolean} | null}
 *   Null when nothing installed can see, which is a real state and not an error.
 */
function pickDescriber(models, opts = {}) {
  const installed = Array.isArray(models) ? models.filter((m) => m && m.name) : [];
  const capable = installed.filter((m) => m.supportsVision);
  if (capable.length === 0) return null;

  const preferred = String(opts.preferred || '').trim();
  if (preferred) {
    const match = capable.find((m) => m.name === preferred);
    if (match) {
      return { name: match.name, reason: 'chosen in settings', isActive: match.name === opts.activeModel };
    }
    // Named but unusable. Worth a log line rather than silence: the user set this
    // deliberately and is entitled to know it is not being honoured.
    const installedButBlind = installed.find((m) => m.name === preferred);
    logger.warn(
      installedButBlind
        ? `hirayacoder.vision.describeModel is set to ${preferred}, which is installed but cannot read images. Picking another.`
        : `hirayacoder.vision.describeModel is set to ${preferred}, which is not installed. Picking another.`
    );
  }

  const active = capable.find((m) => m.name === opts.activeModel);
  if (active) {
    return {
      name: active.name,
      reason: 'the selected model can read images itself',
      isActive: true,
    };
  }

  // Smallest first. A description is a read, not a piece of reasoning, and the whole
  // cost of using a second model here is the time it takes to load and answer.
  // `params` is null when Ollama did not report a size; those sort last rather than
  // first, so an unknown quantity is never chosen over a known small one.
  const smallest = capable
    .slice()
    .sort((a, b) => {
      const left = typeof a.params === 'number' ? a.params : Number.POSITIVE_INFINITY;
      const right = typeof b.params === 'number' ? b.params : Number.POSITIVE_INFINITY;
      if (left !== right) return left - right;
      return a.name.localeCompare(b.name);
    })[0];

  return {
    name: smallest.name,
    reason: `${opts.activeModel || 'the selected model'} cannot read images, so the smallest installed vision model does the looking`,
    isActive: false,
  };
}

/**
 * @typedef {object} ImageDescription
 * @property {string} name         The file's basename, so the user can tell two apart.
 * @property {string} description  What the model saw, or the reason there is nothing.
 * @property {string} model        Which model produced it.
 * @property {number} ms           How long it took, for the status line and the benchmark.
 * @property {boolean} ok          False when the call failed; `description` is then the error.
 */

/**
 * Describe one image.
 *
 * @param {object} options
 * @param {import('./ollamaClient').OllamaClient} options.client
 * @param {string} options.model
 * @param {{name?: string, base64: string}} options.image
 * @param {'answer' | 'task'} [options.purpose]
 * @param {string} [options.question]  What the user typed. Included for the `answer`
 *   purpose so a describer asked "what breed is this?" volunteers the breed rather
 *   than a generic caption that the answering model then cannot use.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<ImageDescription>}
 */
async function describe(options) {
  const purpose = options.purpose === 'task' ? 'task' : 'answer';
  const image = options.image || { base64: '' };
  const name = image.name || 'the attached image';
  const started = Date.now();

  if (!image.base64) {
    return { name, description: 'The image could not be read.', model: options.model, ms: 0, ok: false };
  }

  const key = fingerprint(image.base64, purpose, options.model);
  const cached = cache.get(key);
  if (cached !== undefined) {
    logger.debug(`Reusing the description already produced for ${name}.`);
    return { name, description: cached, model: options.model, ms: 0, ok: true };
  }

  // Appended rather than replacing the prompt: the four numbered points are what keeps
  // a small model on task, and a question alone gets a one-word answer that is useless
  // to anything downstream.
  const question = String(options.question || '').trim();
  // `purpose` is narrowed to one of two string literals at the top of this function,
  // so this is a lookup of a constant key on a module constant.
  // eslint-disable-next-line security/detect-object-injection
  const basePrompt = PROMPTS[purpose];
  const prompt =
    purpose === 'answer' && question
      ? `${basePrompt}\n\nThe user asked: "${question.slice(0, 300)}". Make sure your description covers whatever that question is about.`
      : basePrompt;

  try {
    const response = await options.client.chat(
      {
        model: options.model,
        messages: [{ role: 'user', content: prompt, images: [image.base64] }],
        // A description is not a reasoning task, and on a hybrid model the thinking
        // trace is pure cost here — it is not shown, not stored, and eats the token
        // budget the description itself needs.
        think: false,
        options: {
          // Low but not zero. At zero a small vision model repeats one clause until it
          // hits the token ceiling, which is the single most common way these calls
          // waste a minute.
          temperature: 0.2,
          num_predict: DESCRIBE_NUM_PREDICT,
        },
      },
      { signal: options.signal }
    );

    let text = String((response && response.message && response.message.content) || '').trim();
    if (!text) {
      return {
        name,
        description: 'The model returned nothing for this image.',
        model: options.model,
        ms: Date.now() - started,
        ok: false,
      };
    }

    if (looksLikeRefusal(text)) {
      logger.warn(`${options.model} replied that it cannot see images, having been sent one. Treating as a failed read.`);
      return {
        name,
        description:
          `${options.model} replied that it cannot read images, although it was sent one and reports ` +
          'that it can. Sending the message again usually works; a different vision model always does.',
        model: options.model,
        ms: Date.now() - started,
        ok: false,
      };
    }

    if (text.length > MAX_DESCRIPTION_CHARS) {
      text = `${text.slice(0, MAX_DESCRIPTION_CHARS)}…`;
    }

    remember(key, text);
    return { name, description: text, model: options.model, ms: Date.now() - started, ok: true };
  } catch (err) {
    const message = /** @type {Error} */ (err).message;
    logger.warn(`Could not describe ${name}: ${message}`);
    return {
      name,
      description: `This image could not be read (${message}).`,
      model: options.model,
      ms: Date.now() - started,
      ok: false,
    };
  }
}

/**
 * Describe several images, one after another.
 *
 * Sequential rather than parallel, and not as an oversight: Ollama serialises requests
 * to one model anyway, so firing three at once produces three queued requests and one
 * progress indicator that jumps from nothing to everything. In sequence the caller can
 * say "reading screenshot 2 of 3", which on a minute-per-image machine is the
 * difference between a slow feature and a broken one.
 *
 * @param {object} options
 * @param {import('./ollamaClient').OllamaClient} options.client
 * @param {string} options.model
 * @param {Array<{name?: string, base64: string}>} options.images
 * @param {'answer' | 'task'} [options.purpose]
 * @param {string} [options.question]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: {index: number, total: number, name: string}) => void} [options.onProgress]
 * @returns {Promise<ImageDescription[]>}
 */
async function describeAll(options) {
  const images = Array.isArray(options.images) ? options.images : [];
  /** @type {ImageDescription[]} */
  const out = [];

  for (let index = 0; index < images.length; index += 1) {
    // `index` is this loop's own counter over a local array.
    // eslint-disable-next-line security/detect-object-injection
    const image = images[index];
    if (options.onProgress) {
      options.onProgress({ index: index + 1, total: images.length, name: (image && image.name) || 'image' });
    }
    // Sequential on purpose; see the note above this function.
    out.push(
      await describe({
        client: options.client,
        model: options.model,
        image,
        purpose: options.purpose,
        question: options.question,
        signal: options.signal,
      })
    );
  }

  return out;
}

/**
 * Render descriptions as the prompt block the context builder carries.
 *
 * ## Why the block says the agent cannot see the picture
 *
 * Without that sentence, a model handed "A screenshot of a login form with a red error
 * reading 'Invalid credentials'" replies "I can see the error in your screenshot" — and
 * then, one turn later, offers to look more closely at a part of it, which it cannot do.
 * Naming the description as second-hand is what stops both.
 *
 * @param {ImageDescription[]} descriptions
 * @returns {string} Empty when there is nothing to say, so the caller can skip the section.
 */
function renderForPrompt(descriptions) {
  const usable = (descriptions || []).filter((entry) => entry && entry.description);
  if (usable.length === 0) return '';

  const plural = usable.length === 1 ? 'an image' : `${usable.length} images`;
  const lines = usable.map((entry) => `${entry.name}:\n${entry.description}`);

  return (
    `The user attached ${plural}. You are not looking at ${usable.length === 1 ? 'it' : 'them'} — ` +
    `what follows is a written description produced by a vision model, and it is everything you have. ` +
    `Work from it, and do not offer to look at the ${usable.length === 1 ? 'image' : 'images'} more closely.\n\n` +
    lines.join('\n\n')
  );
}

/** Test seam. Nothing in the extension calls this. */
function _clearCache() {
  cache.clear();
}

module.exports = {
  pickDescriber,
  looksLikeRefusal,
  describe,
  describeAll,
  renderForPrompt,
  PROMPTS,
  MAX_DESCRIPTION_CHARS,
  _clearCache,
};
