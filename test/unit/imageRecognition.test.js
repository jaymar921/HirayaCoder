'use strict';

/**
 * `core/imageRecognition` — choosing a describer, calling it, and rendering what it
 * said into a prompt block.
 *
 * The model call is mocked throughout. What matters here is the decision logic around
 * it: which model gets asked, what it is asked for, what happens when it fails, and
 * whether the answer is cached. Whether a real vision model can actually see a cat is a
 * different question, and it is measured by `tools/bench-vision.js` against real
 * photographs, because no mock can answer it.
 */

const assert = require('assert');

const imageRecognition = require('../../app/core/imageRecognition');

/** A one-pixel worth of base64. Content is irrelevant; identity is not. */
const IMAGE_A = Buffer.from('image-a').toString('base64');
const IMAGE_B = Buffer.from('image-b').toString('base64');

/**
 * @param {string | Error} reply Text to return, or an error to throw.
 */
function mockClient(reply) {
  return {
    calls: /** @type {any[]} */ ([]),
    async chat(body) {
      this.calls.push(body);
      if (reply instanceof Error) throw reply;
      return { message: { content: reply } };
    },
  };
}

const model = (name, params, vision) => ({ name, params, supportsVision: vision });

describe('imageRecognition', () => {
  beforeEach(() => imageRecognition._clearCache());

  describe('pickDescriber', () => {
    it('prefers the selected model when it can see, because that costs no extra load', () => {
      const pick = imageRecognition.pickDescriber(
        [model('qwen3.5:4b', 4.7, true), model('minicpm-v4.6:latest', 0.75, true)],
        { activeModel: 'qwen3.5:4b' }
      );
      assert.strictEqual(pick.name, 'qwen3.5:4b');
      assert.strictEqual(pick.isActive, true);
    });

    it('falls back to the smallest vision model when the selected one is blind', () => {
      // Smallest, not best: Ollama holds one model at a time, so this choice is paid
      // for in load time and the description is a read rather than a piece of
      // reasoning.
      const pick = imageRecognition.pickDescriber(
        [model('llama3.2:latest', 3.2, false), model('qwen3.5:4b', 4.7, true), model('minicpm-v4.6:latest', 0.75, true)],
        { activeModel: 'llama3.2:latest' }
      );
      assert.strictEqual(pick.name, 'minicpm-v4.6:latest');
      assert.strictEqual(pick.isActive, false);
    });

    it('sorts a model of unknown size last rather than first', () => {
      // `params` is null when Ollama did not report a size. Treating that as zero would
      // make an unknown quantity beat every known small model.
      const pick = imageRecognition.pickDescriber(
        [model('mystery:latest', null, true), model('minicpm-v4.6:latest', 0.75, true)],
        { activeModel: 'llama3.2:latest' }
      );
      assert.strictEqual(pick.name, 'minicpm-v4.6:latest');
    });

    it('honours a describer named in settings', () => {
      const pick = imageRecognition.pickDescriber(
        [model('qwen3.5:4b', 4.7, true), model('minicpm-v4.6:latest', 0.75, true)],
        { activeModel: 'llama3.2:latest', preferred: 'qwen3.5:4b' }
      );
      assert.strictEqual(pick.name, 'qwen3.5:4b');
      assert.strictEqual(pick.reason, 'chosen in settings');
    });

    it('ignores a setting that names a model which cannot see', () => {
      // A stale name in settings must not silently disable images altogether.
      const pick = imageRecognition.pickDescriber(
        [model('llama3.2:latest', 3.2, false), model('minicpm-v4.6:latest', 0.75, true)],
        { activeModel: 'llama3.2:latest', preferred: 'llama3.2:latest' }
      );
      assert.strictEqual(pick.name, 'minicpm-v4.6:latest');
    });

    it('ignores a setting that names a model which is not installed', () => {
      const pick = imageRecognition.pickDescriber([model('minicpm-v4.6:latest', 0.75, true)], {
        activeModel: 'minicpm-v4.6:latest',
        preferred: 'gemma4:e4b',
      });
      assert.strictEqual(pick.name, 'minicpm-v4.6:latest');
    });

    it('returns null when nothing installed can see', () => {
      assert.strictEqual(
        imageRecognition.pickDescriber([model('llama3.2:latest', 3.2, false)], { activeModel: 'llama3.2:latest' }),
        null
      );
      assert.strictEqual(imageRecognition.pickDescriber([], {}), null);
      assert.strictEqual(imageRecognition.pickDescriber(null, {}), null);
    });
  });

  describe('describe', () => {
    it('sends the image as base64 on the message, which is the shape Ollama wants', async () => {
      const client = mockClient('A tabby cat.');
      await imageRecognition.describe({ client, model: 'v', image: { name: 'cat.jpg', base64: IMAGE_A } });

      const body = client.calls[0];
      assert.deepStrictEqual(body.messages[0].images, [IMAGE_A]);
      assert.strictEqual(body.messages[0].role, 'user');
    });

    it('turns thinking off, because a description is not a reasoning task', async () => {
      // On a hybrid model the trace is not shown, not stored, and spends the token
      // budget the description itself needs.
      const client = mockClient('A tabby cat.');
      await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });
      assert.strictEqual(client.calls[0].think, false);
    });

    it('caps generation, so a model stuck in a loop stops before the request timeout', async () => {
      const client = mockClient('A tabby cat.');
      await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });
      assert.ok(client.calls[0].options.num_predict > 0);
      assert.ok(client.calls[0].options.temperature > 0, 'not zero: at zero a small model repeats one clause');
    });

    it('asks for the transcription-first prompt when the purpose is a task', async () => {
      const client = mockClient('A screenshot.');
      await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A }, purpose: 'task' });
      const sent = client.calls[0].messages[0].content;
      assert.ok(sent.includes('coding agent'), 'the task prompt frames the describer as the agent’s eyes');
      assert.ok(sent.includes('copied exactly as written'));
    });

    it('folds the user’s question into the answering prompt', async () => {
      // Without this, a describer asked "what breed is this?" produces a generic
      // caption, and the answering model then cannot answer the question either.
      const client = mockClient('A corgi.');
      await imageRecognition.describe({
        client,
        model: 'v',
        image: { base64: IMAGE_A },
        purpose: 'answer',
        question: 'what breed is this dog?',
      });
      assert.ok(client.calls[0].messages[0].content.includes('what breed is this dog?'));
    });

    it('does not fold the question into a task description', async () => {
      // A task description is read on every turn of the loop. Steering it with turn
      // one's wording makes it less useful as the run moves on to the other items.
      const client = mockClient('A screenshot.');
      await imageRecognition.describe({
        client,
        model: 'v',
        image: { base64: IMAGE_A },
        purpose: 'task',
        question: 'what breed is this dog?',
      });
      assert.ok(!client.calls[0].messages[0].content.includes('what breed is this dog?'));
    });

    it('reuses a description rather than paying for the same picture twice', async () => {
      const client = mockClient('A tabby cat.');
      const first = await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });
      const second = await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });

      assert.strictEqual(client.calls.length, 1, 'the second call was served from the cache');
      assert.strictEqual(second.description, first.description);
    });

    it('treats a different image, model, or purpose as a different question', async () => {
      const client = mockClient('Something.');
      await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });
      await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_B } });
      await imageRecognition.describe({ client, model: 'w', image: { base64: IMAGE_A } });
      await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A }, purpose: 'task' });
      assert.strictEqual(client.calls.length, 4);
    });

    it('truncates a describer that ignores the word limit', async () => {
      const client = mockClient('x'.repeat(imageRecognition.MAX_DESCRIPTION_CHARS * 3));
      const result = await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });
      assert.ok(result.description.length <= imageRecognition.MAX_DESCRIPTION_CHARS + 1);
    });

    it('reports a failed call as text rather than throwing', async () => {
      // The turn continues without the image. Throwing here would lose the whole
      // message over one unreadable attachment.
      const client = mockClient(new Error('Ollama is not running'));
      const result = await imageRecognition.describe({ client, model: 'v', image: { name: 'a.png', base64: IMAGE_A } });
      assert.strictEqual(result.ok, false);
      assert.ok(result.description.includes('Ollama is not running'));
    });

    it('reports an empty reply as a failure, not as an empty description', async () => {
      const client = mockClient('   ');
      const result = await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });
      assert.strictEqual(result.ok, false);
    });

    it('treats "I cannot see this image" as a failed read, not as a description', async () => {
      // Found by tools/bench-vision.js, once in 24 runs of qwen3.5:0.8b: a model that
      // reports vision, was sent the image, and had described the same photograph
      // correctly one sample earlier. Left alone, that paragraph becomes what the
      // coding model is told is in the picture.
      const client = mockClient(
        'I cannot see this image. I am an AI model designed to process text and provide ' +
          'information, but I do not have the ability to view or interpret visual content ' +
          'like screenshots, photos, or UI elements.'
      );
      const result = await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });

      assert.strictEqual(result.ok, false);
      assert.ok(result.description.includes('Sending the message again'), 'says what to do about it');
      assert.ok(!result.description.includes('designed to process text'), 'the refusal itself is not passed on');
    });

    it('does not mistake an honest hedge for a refusal', async () => {
      // The prompt asks the describer to say when it cannot make something out, so
      // "I cannot see the licence plate clearly" is the check working, not failing.
      // A detector that ate those would punish exactly the behaviour we want.
      const client = mockClient('A yellow car on a road. I cannot see the licence plate clearly, so it is unreadable.');
      const result = await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });
      assert.strictEqual(result.ok, true);
    });

    it('keeps a real description that ends with a boilerplate disclaimer', async () => {
      const client = mockClient(
        `${'A tabby kitten lying on a green surface, facing the camera. '.repeat(8)} ` +
          'As an AI I cannot view images.'
      );
      const result = await imageRecognition.describe({ client, model: 'v', image: { base64: IMAGE_A } });
      assert.strictEqual(result.ok, true, 'only the opening 400 characters are examined');
    });

    it('does not cache a failure', async () => {
      // Otherwise one timeout poisons the image for the rest of the session.
      const failing = mockClient(new Error('timed out'));
      await imageRecognition.describe({ client: failing, model: 'v', image: { base64: IMAGE_A } });
      const working = mockClient('A tabby cat.');
      const second = await imageRecognition.describe({ client: working, model: 'v', image: { base64: IMAGE_A } });
      assert.strictEqual(second.ok, true);
      assert.strictEqual(working.calls.length, 1);
    });
  });

  describe('describeAll', () => {
    it('describes in sequence and reports progress per image', async () => {
      const client = mockClient('Something.');
      /** @type {object[]} */
      const progress = [];
      const out = await imageRecognition.describeAll({
        client,
        model: 'v',
        images: [
          { name: 'a.png', base64: IMAGE_A },
          { name: 'b.png', base64: IMAGE_B },
        ],
        onProgress: (p) => progress.push(p),
      });

      assert.strictEqual(out.length, 2);
      assert.deepStrictEqual(
        progress.map((p) => `${p.index}/${p.total} ${p.name}`),
        ['1/2 a.png', '2/2 b.png']
      );
    });

    it('returns nothing for no images, without calling the model', async () => {
      const client = mockClient('Something.');
      assert.deepStrictEqual(await imageRecognition.describeAll({ client, model: 'v', images: [] }), []);
      assert.strictEqual(client.calls.length, 0);
    });
  });

  describe('renderForPrompt', () => {
    it('says the model is not looking at the picture', async () => {
      // Without this, a model handed a description replies "I can see the error in your
      // screenshot" and then offers to look at it more closely, which it cannot do.
      const block = imageRecognition.renderForPrompt([
        { name: 'shot.png', description: 'A login form with a red error.', ok: true },
      ]);
      assert.ok(block.includes('not looking at'));
      assert.ok(block.includes('do not offer to look'));
      assert.ok(block.includes('shot.png'));
      assert.ok(block.includes('A login form with a red error.'));
    });

    it('names each image when there is more than one', () => {
      const block = imageRecognition.renderForPrompt([
        { name: 'one.png', description: 'First.', ok: true },
        { name: 'two.png', description: 'Second.', ok: true },
      ]);
      assert.ok(block.includes('2 images'));
      assert.ok(block.includes('one.png'));
      assert.ok(block.includes('two.png'));
    });

    it('renders nothing at all when there is nothing to say', () => {
      // The caller uses the empty string to skip the section entirely, so a block of
      // boilerplate with no content in it would cost budget for nothing.
      assert.strictEqual(imageRecognition.renderForPrompt([]), '');
      assert.strictEqual(imageRecognition.renderForPrompt(null), '');
      assert.strictEqual(imageRecognition.renderForPrompt([{ name: 'a.png', description: '' }]), '');
    });
  });
});
