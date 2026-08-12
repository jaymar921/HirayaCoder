'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readImage,
  modelSupportsImages,
  sniffMime,
  MAX_IMAGE_BYTES,
} = require('../../app/features/imageContext');

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

describe('imageContext', () => {
  /** @type {string} */
  let root;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-img-')));
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

  const write = (name, buffer) => {
    const full = path.join(root, name);
    fs.writeFileSync(full, buffer);
    return full;
  };

  describe('modelSupportsImages', () => {
    it('gates on the reported vision capability', () => {
      assert.strictEqual(modelSupportsImages({ supportsVision: true }), true);
      assert.strictEqual(modelSupportsImages({ supportsVision: false }), false);
      assert.strictEqual(modelSupportsImages(null), false);
      assert.strictEqual(modelSupportsImages({}), false);
    });
  });

  describe('sniffMime', () => {
    it('recognises the formats Ollama accepts', () => {
      assert.strictEqual(sniffMime(PNG_HEADER), 'image/png');
      assert.strictEqual(sniffMime(JPEG_HEADER), 'image/jpeg');
      assert.strictEqual(sniffMime(Buffer.from('GIF89a')), 'image/gif');
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
      assert.strictEqual(sniffMime(webp), 'image/webp');
    });

    it('returns null for something that is not an image', () => {
      assert.strictEqual(sniffMime(Buffer.from('#!/bin/sh\nrm -rf /')), null);
    });
  });

  describe('readImage', () => {
    it('reads a real image into base64 and a data URI', async () => {
      const file = write('shot.png', Buffer.concat([PNG_HEADER, Buffer.alloc(64)]));
      const result = await readImage(file);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.image.mime, 'image/png');
      assert.strictEqual(result.image.name, 'shot.png');
      assert.ok(result.image.dataUri.startsWith('data:image/png;base64,'));
      // Ollama wants the raw base64, not the data URI — mixing them up sends a model
      // the literal string "data:image/png;base64,..." as if it were pixels.
      assert.ok(!result.image.base64.startsWith('data:'));
      assert.strictEqual(Buffer.from(result.image.base64, 'base64').length, PNG_HEADER.length + 64);
    });

    it('refuses a file that only pretends to be an image', async () => {
      const file = write('payload.png', Buffer.from('#!/bin/sh\necho not a picture'));
      const result = await readImage(file);

      assert.strictEqual(result.ok, false);
      assert.match(result.error, /does not look like a real image/);
    });

    it('refuses an unsupported extension', async () => {
      const file = write('notes.txt', Buffer.from('hello'));
      const result = await readImage(file);

      assert.strictEqual(result.ok, false);
      assert.match(result.error, /not a supported image/);
    });

    it('refuses an oversized image and explains why it matters', async () => {
      // Checked from stat before reading, so an enormous file never lands in memory.
      const file = write('huge.png', Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_IMAGE_BYTES + 1024)]));
      const result = await readImage(file);

      assert.strictEqual(result.ok, false);
      assert.match(result.error, /over the 4 MB limit/);
      assert.match(result.error, /Base64 adds another third/);
    });

    it('reports a missing file rather than throwing', async () => {
      const result = await readImage(path.join(root, 'nope.png'));
      assert.strictEqual(result.ok, false);
      assert.match(result.error, /Could not read that file/);
    });

    it('accepts a jpeg whose extension is .jpg', async () => {
      const file = write('photo.jpg', Buffer.concat([JPEG_HEADER, Buffer.alloc(32)]));
      const result = await readImage(file);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.image.mime, 'image/jpeg');
    });
  });
});
