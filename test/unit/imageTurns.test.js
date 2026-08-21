'use strict';

/**
 * What happens to an attached image once a turn starts.
 *
 * `imageRecognition.test.js` covers the describer in isolation. This covers the wiring
 * decisions in `AgentSession` that the module cannot see: which turns get the raw
 * picture, which get the words, and which get both. Those decisions are the whole
 * feature — the describer being correct is worth nothing if its output never reaches
 * the model that answers.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AgentSession } = require('../../app/agent/agentSession');
const { PermissionGate } = require('../../app/security/permissionGate');
const { PermissionModes } = require('../../app/security/permissionModes');
const { AuditLog } = require('../../app/security/auditLog');
const imageRecognition = require('../../app/core/imageRecognition');

const TIER_B = { tier: 'B', strategy: 'react', label: 'Lite', model: 'llama3.2:1b' };
const PICTURE = Buffer.from('not-really-a-jpeg').toString('base64');

/**
 * A client that answers the describer and the main turn differently.
 *
 * The two are told apart by the images on the message, which is exactly how the real
 * request differs: a description call carries the base64 and nothing else does.
 */
function twoStageClient(mainReplies) {
  return {
    /** @type {any[]} */ bodies: [],
    /** @type {any[]} */ describeCalls: [],
    /** @type {any[]} */ mainCalls: [],
    async chat(body) {
      this.bodies.push(body);
      const first = body.messages[0] || {};
      const isDescribe =
        Array.isArray(first.images) && first.images.length > 0 && String(first.content || '').includes('image');

      if (isDescribe) {
        this.describeCalls.push(body);
        return { message: { content: 'A screenshot of a login form with a red error reading "Invalid password".' } };
      }
      this.mainCalls.push(body);
      const reply = mainReplies[Math.min(this.mainCalls.length - 1, mainReplies.length - 1)];
      return { message: { content: reply } };
    },
  };
}

/** Every message body that went out, flattened to searchable text. */
const allText = (client) => JSON.stringify(client.bodies);

describe('images in a turn', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    imageRecognition._clearCache();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-imgturn-')));
    fs.writeFileSync(path.join(root, 'README.md'), '# Test project\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  /**
   * @param {object} opts
   */
  function makeSession(opts) {
    const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: false } });
    return new AgentSession({
      client: /** @type {any} */ (opts.client),
      model: opts.model || 'llama3.2:latest',
      capability: TIER_B,
      gate: new PermissionGate({
        workspaceRoot: root,
        modes,
        auditLog: new AuditLog(root),
        confirm: async () => true,
      }),
      workspaceRoot: root,
      thinkingCapacity: 'medium',
      sessionId: '1',
      images: [PICTURE],
      imageFiles: [{ name: 'shot.png', base64: PICTURE }],
      vision: opts.vision,
    });
  }

  describe('Ask mode', () => {
    it('sends the picture straight to a model that can see, with no description pass', async () => {
      // A description here would be a second full generation — a minute or more on CPU —
      // to produce a paraphrase strictly worse than the original, for the one model
      // that was going to look at the original anyway.
      const client = twoStageClient(['That error means the password was wrong.']);
      const session = makeSession({
        client,
        model: 'qwen3.5:4b',
        vision: { enabled: true, describeModel: 'qwen3.5:4b', activeCanSee: true },
      });

      await session.run('what does this error say?', { mode: 'ask' });

      assert.strictEqual(client.describeCalls.length, 0, 'no separate recognition call');
      assert.strictEqual(client.mainCalls.length, 1);
      assert.deepStrictEqual(client.mainCalls[0].messages[1].images, [PICTURE]);
    });

    it('describes first when the selected model is blind, and answers from the words', async () => {
      // The capability this release adds: a screenshot is usable on llama3.2, which has
      // no vision at all, without the user having to switch models.
      const client = twoStageClient(['The error says the password was wrong.']);
      const session = makeSession({
        client,
        model: 'llama3.2:latest',
        vision: { enabled: true, describeModel: 'minicpm-v4.6:latest', activeCanSee: false },
      });

      const result = await session.run('what does this error say?', { mode: 'ask' });

      assert.strictEqual(client.describeCalls.length, 1);
      assert.strictEqual(client.describeCalls[0].model, 'minicpm-v4.6:latest', 'described by the vision model');
      assert.strictEqual(client.mainCalls[0].model, 'llama3.2:latest', 'answered by the selected model');
      assert.ok(client.mainCalls[0].messages[1].content.includes('Invalid password'), 'the words reached the answer');
      assert.strictEqual(result.stopReason, 'answered');
    });

    it('never puts the raw picture on a message to a model that cannot see it', async () => {
      // Not an API error — Ollama drops it silently, after the upload. The only effect
      // is a slower turn, which is exactly the kind of waste that goes unnoticed.
      const client = twoStageClient(['An answer.']);
      const session = makeSession({
        client,
        model: 'llama3.2:latest',
        vision: { enabled: true, describeModel: 'minicpm-v4.6:latest', activeCanSee: false },
      });

      await session.run('what is this?', { mode: 'ask' });

      for (const body of client.mainCalls) {
        for (const message of body.messages) {
          assert.ok(!message.images, 'no images on any message to the blind model');
        }
      }
    });

    it('carries the user’s question into the recognition prompt', async () => {
      const client = twoStageClient(['An answer.']);
      const session = makeSession({
        client,
        model: 'llama3.2:latest',
        vision: { enabled: true, describeModel: 'minicpm-v4.6:latest', activeCanSee: false },
      });

      await session.run('which field is highlighted?', { mode: 'ask' });

      assert.ok(client.describeCalls[0].messages[0].content.includes('which field is highlighted?'));
    });
  });

  describe('Agent mode', () => {
    it('describes with the task prompt, not the conversational one', async () => {
      // Agent mode acts on what it is told, so transcription outranks description. The
      // two prompts differ on exactly that.
      const client = twoStageClient(['{"action":"done","summary":"Looked at it."}']);
      const session = makeSession({
        client,
        model: 'qwen3.5:4b',
        vision: { enabled: true, describeModel: 'qwen3.5:4b', activeCanSee: true },
      });

      await session.run('fix the error shown in this screenshot', { mode: 'agent' });

      assert.strictEqual(client.describeCalls.length, 1);
      assert.ok(client.describeCalls[0].messages[0].content.includes('coding agent'));
    });

    it('describes even when the selected model can see, because the loop outlives the picture', async () => {
      // Images ride on the first message only. By turn four the model is working from a
      // conversation about a picture it can no longer see; the description is what
      // carries across.
      const client = twoStageClient(['{"action":"done","summary":"Done."}']);
      const session = makeSession({
        client,
        model: 'qwen3.5:4b',
        vision: { enabled: true, describeModel: 'qwen3.5:4b', activeCanSee: true },
      });

      await session.run('build what this mockup shows', { mode: 'agent' });

      assert.strictEqual(client.describeCalls.length, 1);
      assert.ok(allText(client).includes('Invalid password'), 'the description reached the loop');
    });

    it('puts the description in the context of the turn, not only in the first message', async () => {
      const client = twoStageClient(['{"action":"done","summary":"Done."}']);
      const session = makeSession({
        client,
        model: 'llama3.2:latest',
        vision: { enabled: true, describeModel: 'minicpm-v4.6:latest', activeCanSee: false },
      });

      await session.run('implement the form in this mockup', { mode: 'agent' });

      const context = JSON.stringify(client.mainCalls[0].messages);
      assert.ok(context.includes('shot.png'), 'the image is named');
      assert.ok(context.includes('Invalid password'), 'and what was in it is carried');
      assert.ok(context.includes('not looking at'), 'and the model is told it is reading a description');
    });
  });

  describe('the project must not drown the picture', () => {
    // The bug this covers, measured on minicpm-v4.6 in Ask mode: "describe the image"
    // with a photograph of a dog attached returned a description of HirayaCoder. Not a
    // vision failure — the same model and photograph score 24/24 in bench-vision. The
    // model was handed 2,500 characters of project description and file listing with
    // "Task: describe the image" on the last line, under a system prompt opening with
    // "everything below this line is what you know about the user's project… Answer
    // from it". A small model resolves that conflict by weight.

    it('leaves the project overview and file listing out of a no-tools image turn', async () => {
      const client = twoStageClient(['A corgi in grass.']);
      const session = makeSession({
        client,
        model: 'qwen3.5:4b',
        vision: { enabled: true, describeModel: 'qwen3.5:4b', activeCanSee: true },
      });

      await session.run('describe the image', { mode: 'ask' });

      const userTurn = client.mainCalls[0].messages[1].content;
      assert.ok(!userTurn.includes('Files in this project'), 'no file listing');
      assert.ok(!userTurn.includes("project's own description of itself"), 'no project overview');
      assert.ok(userTurn.includes('describe the image'), 'the task still gets there');
    });

    it('tells the model the question is about the image', async () => {
      const client = twoStageClient(['A corgi in grass.']);
      const session = makeSession({
        client,
        model: 'qwen3.5:4b',
        vision: { enabled: true, describeModel: 'qwen3.5:4b', activeCanSee: true },
      });

      await session.run('describe the image', { mode: 'ask' });

      const system = client.mainCalls[0].messages[0].content;
      assert.ok(system.includes('attached an image'), 'the instruction is present');
      assert.ok(system.includes('Answer about the image'));
    });

    it('says nothing about images on a turn that has none', async () => {
      const client = twoStageClient(['An answer.']);
      const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: false } });
      const session = new AgentSession({
        client: /** @type {any} */ (client),
        model: 'qwen3.5:4b',
        capability: TIER_B,
        gate: new PermissionGate({
          workspaceRoot: root,
          modes,
          auditLog: new AuditLog(root),
          confirm: async () => true,
        }),
        workspaceRoot: root,
        sessionId: '1',
      });

      await session.run('what is this project?', { mode: 'ask' });

      const system = client.mainCalls[0].messages[0].content;
      assert.ok(!system.includes('attached an image'));
      // And the orientation blocks it needs are still there, which is the thing the
      // suppression above must not break for ordinary questions.
      assert.ok(client.mainCalls[0].messages[1].content.includes('Files in this project'));
    });

    it('keeps the file listing in Agent mode, where it is load-bearing', async () => {
      // A model asked to build the screen in a mockup needs to know which paths exist.
      // There the picture is not competing with the project, it is a fact about the job.
      const client = twoStageClient(['{"action":"done","summary":"Done."}']);
      const session = makeSession({
        client,
        model: 'qwen3.5:4b',
        vision: { enabled: true, describeModel: 'qwen3.5:4b', activeCanSee: true },
      });

      await session.run('build the screen in this mockup', { mode: 'agent' });

      assert.ok(allText(client).includes('Files in this project'), 'the listing survives in Agent mode');
    });
  });

  describe('what the reply footer is told', () => {
    it('names the model that answered and how long the turn took', async () => {
      const client = twoStageClient(['A corgi in grass.']);
      const session = makeSession({
        client,
        model: 'qwen3.5:4b',
        vision: { enabled: true, describeModel: 'qwen3.5:4b', activeCanSee: true },
      });

      const result = await session.run('describe the image', { mode: 'ask' });

      assert.strictEqual(result.model, 'qwen3.5:4b');
      assert.strictEqual(typeof result.ms, 'number');
      assert.ok(result.ms >= 0);
    });

    it('accounts for a second model separately when one read the image', async () => {
      // Without this the headline duration silently includes another model's load and
      // inference, and the coding model looks like it got slower.
      const client = twoStageClient(['A corgi in grass.']);
      const session = makeSession({
        client,
        model: 'llama3.2:latest',
        vision: { enabled: true, describeModel: 'minicpm-v4.6:latest', activeCanSee: false },
      });

      const result = await session.run('describe the image', { mode: 'ask' });

      assert.strictEqual(result.model, 'llama3.2:latest');
      assert.ok(result.vision, 'the describer is reported');
      assert.strictEqual(result.vision.model, 'minicpm-v4.6:latest');
      assert.strictEqual(typeof result.vision.ms, 'number');
    });

    it('reports no second model when the selected one described its own image', async () => {
      // Naming it twice would read as though there were two costs.
      const client = twoStageClient(['{"action":"done","summary":"Done."}']);
      const session = makeSession({
        client,
        model: 'qwen3.5:4b',
        vision: { enabled: true, describeModel: 'qwen3.5:4b', activeCanSee: true },
      });

      const result = await session.run('build what this mockup shows', { mode: 'agent' });

      assert.strictEqual(result.vision, undefined);
      assert.strictEqual(result.model, 'qwen3.5:4b');
    });
  });

  describe('secrets visible in the picture', () => {
    it('redacts a credential the describer read off the screenshot', async () => {
      // Not a hypothetical, and not merely permitted: the recognition prompt asks the
      // describer to copy visible text exactly, so a screenshot of a terminal with an
      // exported key in it produces a description containing the key. That description
      // then goes into the prompt like any other context block, and every other context
      // block is redacted.
      const key = `sk-proj-${'AbCdEf0123456789'.repeat(2)}`;
      const client = {
        /** @type {any[]} */ bodies: [],
        async chat(body) {
          this.bodies.push(body);
          const first = body.messages[0] || {};
          if (Array.isArray(first.images) && first.images.length > 0) {
            return { message: { content: `A terminal. The visible text reads: export OPENAI_API_KEY=${key}` } };
          }
          return { message: { content: 'An answer.' } };
        },
      };

      const session = makeSession({
        client,
        model: 'llama3.2:latest',
        vision: { enabled: true, describeModel: 'minicpm-v4.6:latest', activeCanSee: false },
      });

      await session.run('what is on this screen?', { mode: 'ask' });

      const answering = client.bodies.filter((b) => !(b.messages[0].images || []).length);
      const sent = JSON.stringify(answering);
      assert.ok(!sent.includes(key), 'the key must not reach the answering model');
      assert.ok(sent.includes('REDACTED'), 'and it is replaced rather than dropped');
      assert.ok(sent.includes('The visible text reads'), 'the sentence around it survives');
    });
  });

  describe('when it is switched off or unavailable', () => {
    it('reads nothing when vision is disabled in settings', async () => {
      const client = twoStageClient(['An answer.']);
      const session = makeSession({
        client,
        model: 'llama3.2:latest',
        vision: { enabled: false, describeModel: 'minicpm-v4.6:latest', activeCanSee: false },
      });

      await session.run('what is this?', { mode: 'ask' });

      assert.strictEqual(client.describeCalls.length, 0);
    });

    it('answers anyway when no model can see, rather than failing the turn', async () => {
      // Losing the whole message over an unreadable attachment would be worse than an
      // answer that does not mention the picture.
      const client = twoStageClient(['An answer.']);
      const session = makeSession({
        client,
        model: 'llama3.2:latest',
        vision: { enabled: true, describeModel: null, activeCanSee: false },
      });

      const result = await session.run('what is this?', { mode: 'ask' });

      assert.strictEqual(client.describeCalls.length, 0);
      assert.strictEqual(result.summary, 'An answer.');
    });

    it('keeps the pre-1.1.0 behaviour when no vision config is supplied at all', async () => {
      // Every caller before this release had already refused to attach an image to a
      // model that could not see it, so an absent config means "the picture is fine to
      // send".
      const client = twoStageClient(['An answer.']);
      const session = makeSession({ client, model: 'qwen3.5:4b', vision: undefined });

      await session.run('what is this?', { mode: 'ask' });

      assert.strictEqual(client.describeCalls.length, 0, 'no recognition pass without config');
      assert.deepStrictEqual(client.mainCalls[0].messages[1].images, [PICTURE]);
    });
  });

  describe('no images attached', () => {
    it('changes nothing about an ordinary turn', async () => {
      const client = twoStageClient(['An answer.']);
      const modes = new PermissionModes({ initial: { autoEdit: true, autoApproveScripts: false } });
      const session = new AgentSession({
        client: /** @type {any} */ (client),
        model: 'llama3.2:latest',
        capability: TIER_B,
        gate: new PermissionGate({
          workspaceRoot: root,
          modes,
          auditLog: new AuditLog(root),
          confirm: async () => true,
        }),
        workspaceRoot: root,
        sessionId: '1',
        vision: { enabled: true, describeModel: 'minicpm-v4.6:latest', activeCanSee: false },
      });

      await session.run('what does this project do?', { mode: 'ask' });

      assert.strictEqual(client.describeCalls.length, 0);
      assert.strictEqual(client.mainCalls.length, 1);
      assert.ok(!allText(client).includes('not looking at'));
    });
  });
});
