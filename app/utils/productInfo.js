'use strict';

/**
 * What HirayaCoder knows about itself.
 *
 * ## The failure this exists for
 *
 * Asked "what version are you?", the agent had no way to answer, because nothing in
 * this codebase ever told it. Every system prompt opened with "You are HirayaCoder"
 * and stopped there — the name was hardcoded prose, the version was in `package.json`,
 * and no path connected the two. So the model did the only thing left to it and
 * guessed: it asked the user to confirm whether `hiraya-coder` was installed, denied
 * being v0.5.0 when it was, and in one session answered correctly only because the
 * user had typed the version two messages earlier and it was echoing the transcript.
 *
 * That last case is the one worth naming. An agent repeating a fact back to the person
 * who just supplied it looks like knowledge and is not, and the difference only shows
 * when nobody supplies it.
 *
 * ## Why the version is read rather than written down
 *
 * A constant here would be a second place to bump on every release and a silent liar
 * on the first release somebody forgot. `package.json` is the version by definition —
 * it is what the `.vsix` is built from — so it is the only honest source.
 *
 * Read once at require time. The file cannot change under a running extension host,
 * and a prompt built per turn should not be doing disk I/O to learn a constant.
 *
 * @module utils/productInfo
 */

const logger = require('./logger');

/** The product name, as it should appear to a user and to a model. */
const NAME = 'HirayaCoder';

/**
 * Resolve the shipped version from `package.json`.
 *
 * Falls back to `'unknown'` rather than throwing or inventing a number: an agent that
 * says it does not know its version is telling the truth, and is a better outcome than
 * one confidently reporting a version that was never built.
 *
 * @returns {string}
 */
function readVersion() {
  try {
    // `app/utils` → repo root. Same hop `promptLoader` makes to reach `setup/`.
    const pkg = require('../../package.json');
    const version = pkg && typeof pkg.version === 'string' ? pkg.version.trim() : '';
    return version || 'unknown';
  } catch (err) {
    logger.warn(`Could not read the product version: ${/** @type {Error} */ (err).message}`);
    return 'unknown';
  }
}

/** @type {string} */
const VERSION = readVersion();

/**
 * The identity line injected into every system prompt.
 *
 * Phrased as a fact the model holds rather than as an instruction to recite, because a
 * model told to "answer v0.5.0 when asked about your version" will volunteer it
 * unprompted. It needs to know this, not to advertise it.
 *
 * @returns {string}
 */
function identityLine() {
  return (
    `You are ${NAME}, version ${VERSION}. That is your own version — the extension you are ` +
    `running inside — and it has nothing to do with the version of whatever project the ` +
    `user has open. If you are asked which version you are, answer ${VERSION} directly; do ` +
    `not look for it in the workspace and do not ask the user to confirm it.`
  );
}

module.exports = { NAME, VERSION, identityLine, readVersion };
