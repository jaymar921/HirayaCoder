'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * The only path read here comes from VS Code's own file picker, i.e. from the user
 * clicking a file, never from model output. */

/**
 * Images the user attaches to a message, for models that can actually see them.
 *
 * Ollama takes images as base64 strings on a chat message (`{role, content, images}`),
 * so the work here is reading the file, checking it is what it claims to be, and
 * keeping it small enough not to wreck the request.
 *
 * ## Why the vision capability is enforced and not just hinted
 *
 * A model without vision does not error on an image — it silently ignores it and
 * answers from the text alone. The user then sees a confident reply about a
 * screenshot the model never looked at, having waited through a long upload for it.
 * That is worse than a refusal, so the button is disabled and the host checks again
 * before sending.
 *
 * ## Size
 *
 * Base64 inflates by a third, and the encoded string is charged against the model's
 * context. A 10 MB screenshot becomes ~13 MB of prompt and will either be truncated
 * or take minutes to process on CPU inference. The cap is deliberately well below
 * what a phone camera produces, and the error says so plainly.
 *
 * @module features/imageContext
 */

const fs = require('fs');
const path = require('path');

const logger = require('../utils/logger');

/** Formats Ollama's vision models accept, by extension. */
const SUPPORTED = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

/** Largest image accepted, before base64 expansion. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * Magic numbers, checked against the extension.
 *
 * A `.png` that is actually something else is not necessarily an attack here — the
 * bytes are base64'd and handed to a local model, not executed — but a mismatch means
 * the file is not what the user thinks it is, and sending it wastes a long request.
 * Checking costs one comparison.
 */
const SIGNATURES = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
];

/**
 * @param {Buffer} buffer
 * @returns {string | null} The detected mime type, or null when unrecognized.
 */
function sniffMime(buffer) {
  for (const signature of SIGNATURES) {
    // `index` is the loop counter over a module-constant array, and `buffer` is a
    // Buffer, so this is an ordinary bounds-checked byte read.
    // eslint-disable-next-line security/detect-object-injection
    if (signature.bytes.every((byte, index) => buffer[index] === byte)) return signature.mime;
  }
  // WEBP is "RIFF" .... "WEBP". The signature ends at byte 12, so 12 bytes is
  // enough to identify one — `> 12` rejected a header that was exactly complete.
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * @typedef {object} AttachedImage
 * @property {string} name       Basename, for the chip.
 * @property {string} path       Absolute path, for the audit trail.
 * @property {string} base64     Raw base64, which is what Ollama wants.
 * @property {string} dataUri    `data:<mime>;base64,…`, for the webview thumbnail.
 * @property {number} bytes
 * @property {string} mime
 */

/**
 * Read and validate one image.
 *
 * @param {string} absolutePath
 * @returns {Promise<{ok: true, image: AttachedImage} | {ok: false, error: string}>}
 */
async function readImage(absolutePath) {
  const extension = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED.has(extension)) {
    return {
      ok: false,
      error: `${path.basename(absolutePath)} is not a supported image. Use PNG, JPEG, WEBP, or GIF.`,
    };
  }

  /** @type {fs.Stats} */
  let stats;
  try {
    stats = await fs.promises.stat(absolutePath);
  } catch (err) {
    return { ok: false, error: `Could not read that file: ${/** @type {Error} */ (err).message}` };
  }

  if (!stats.isFile()) return { ok: false, error: 'That is a folder, not an image.' };

  // Checked before reading, so an enormous file is never pulled into memory.
  if (stats.size > MAX_IMAGE_BYTES) {
    const mb = (stats.size / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      error:
        `${path.basename(absolutePath)} is ${mb} MB, over the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB limit. ` +
        'Base64 adds another third on top, and a local model on CPU will take minutes to read it. ' +
        'Crop or downscale it first.',
    };
  }

  /** @type {Buffer} */
  let buffer;
  try {
    buffer = await fs.promises.readFile(absolutePath);
  } catch (err) {
    return { ok: false, error: `Could not read that file: ${/** @type {Error} */ (err).message}` };
  }

  const sniffed = sniffMime(buffer);
  if (!sniffed) {
    return { ok: false, error: `${path.basename(absolutePath)} does not look like a real image file.` };
  }

  const declared = SUPPORTED.get(extension);
  if (sniffed !== declared) {
    logger.warn(`${absolutePath} has a ${extension} extension but ${sniffed} content; using the real type.`);
  }

  const base64 = buffer.toString('base64');
  return {
    ok: true,
    image: {
      name: path.basename(absolutePath),
      path: absolutePath,
      base64,
      dataUri: `data:${sniffed};base64,${base64}`,
      bytes: stats.size,
      mime: sniffed,
    },
  };
}

/**
 * Can this model actually look at an image?
 *
 * @param {{supportsVision?: boolean} | null} model
 * @returns {boolean}
 */
function modelSupportsImages(model) {
  return Boolean(model && model.supportsVision);
}

module.exports = {
  readImage,
  modelSupportsImages,
  sniffMime,
  SUPPORTED_EXTENSIONS: [...SUPPORTED.keys()],
  MAX_IMAGE_BYTES,
};
