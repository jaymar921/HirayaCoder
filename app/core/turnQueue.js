'use strict';

/**
 * One model turn at a time, across every open tab.
 *
 * ## The failure this exists for
 *
 * Two things went wrong, and they look identical from the transcript.
 *
 * Within one tab: `chatTab._run` had no guard, so a message sent while a turn was still
 * running started a second `AgentSession` and overwrote `this.session` with it. The
 * first session kept running, orphaned — nothing could cancel it, its result posted
 * into the same panel, and whichever finished last set `this.session = null` for both.
 * Session 8 of the Machine B evaluation has two consecutive user turns with no reply
 * between them, which is exactly this.
 *
 * Across tabs: `activeModel` is one global, the client is one instance, and Ollama on a
 * CPU box holds one model resident. A turn started in a second tab makes Ollama unload
 * the first model and load the second, and the first turn stalls behind it — long
 * enough that the user presses Stop, which is where all the "The model could not be
 * reached: Request aborted." lines come from. The abort was the user giving up on a
 * hang, not a bug in the client.
 *
 * ## Why a queue rather than a refusal
 *
 * `runExternalTask` already refuses ("finish or stop the current turn first"), and for
 * a command invoked from a menu that is reasonable. For a message someone typed it is
 * not: the message is gone and they have to retype it. So a second turn waits, and is
 * told it is waiting and what for.
 *
 * Serialising costs nothing real. The bottleneck is one Ollama holding one model on one
 * CPU; two turns interleaved are not faster than two turns in order, they are slower
 * and one of them is usually broken.
 *
 * ## Cancellation
 *
 * A queued turn that is cancelled before it starts must leave the queue without ever
 * running, and without stalling the turns behind it. That is the case worth being
 * careful about: a user who presses Stop on a waiting tab and then closes it should not
 * leave every other tab blocked forever.
 *
 * @module core/turnQueue
 */

const logger = require('../utils/logger');

/** Raised for a turn cancelled while it was still waiting. */
class TurnCancelled extends Error {
  constructor() {
    super('The turn was cancelled before it started.');
    this.name = 'TurnCancelled';
  }
}

class TurnQueue {
  constructor() {
    /**
     * The tail of the promise chain. Each acquirer waits on the previous release.
     *
     * @type {Promise<void>}
     * @private
     */
    this._tail = Promise.resolve();
    /** What is running right now, for the message shown to everyone waiting. */
    this._activeLabel = null;
    /** How many are waiting behind it. */
    this._waiting = 0;
  }

  /** Is a turn running? */
  get busy() {
    return this._activeLabel !== null;
  }

  /** What the running turn is called, or null. */
  get activeLabel() {
    return this._activeLabel;
  }

  /** How many turns are queued behind the running one. */
  get waiting() {
    return this._waiting;
  }

  /**
   * Wait for the lane, then take it.
   *
   * @param {object} [opts]
   * @param {string} [opts.label]        Shown to whoever is waiting, e.g. "session 3".
   * @param {AbortSignal} [opts.signal]  Cancels the wait, not a turn already running.
   * @param {(info: {activeLabel: string | null}) => void} [opts.onWait]
   *   Called once, only if the caller actually has to wait. The place to tell the user
   *   why nothing is happening.
   * @returns {Promise<() => void>} Release. Idempotent, and safe to call from a
   *   `finally` whether or not the body threw.
   */
  async acquire(opts = {}) {
    const label = opts.label || 'another turn';

    if (this.busy && opts.onWait) {
      opts.onWait({ activeLabel: this._activeLabel });
    }

    const previous = this._tail;

    /** @type {() => void} */
    let releaseThis;
    // The next acquirer waits on this, so it must resolve even if the body throws and
    // even if this acquirer is cancelled before it ever runs.
    this._tail = new Promise((resolve) => {
      releaseThis = resolve;
    });

    this._waiting += 1;
    try {
      await this._raceCancellation(previous, opts.signal);
    } catch (err) {
      // Cancelled while waiting. This link has to come out of the chain without
      // breaking it, and *without* letting the turn behind it start early: resolving
      // immediately would release whoever is queued behind this one while the turn in
      // front is still running, which is the exact interleaving the queue exists to
      // prevent. So the successor is spliced onto the predecessor instead.
      this._waiting -= 1;
      previous.then(releaseThis, releaseThis);
      throw err;
    }
    this._waiting -= 1;

    this._activeLabel = label;
    logger.debug(`Turn lane taken by ${label}${this._waiting > 0 ? ` (${this._waiting} waiting)` : ''}.`);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._activeLabel = null;
      releaseThis();
    };
  }

  /**
   * Wait for `previous`, unless the signal fires first.
   *
   * @param {Promise<void>} previous
   * @param {AbortSignal} [signal]
   * @returns {Promise<void>}
   * @private
   */
  _raceCancellation(previous, signal) {
    if (!signal) return previous;
    if (signal.aborted) return Promise.reject(new TurnCancelled());

    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new TurnCancelled());
      signal.addEventListener('abort', onAbort, { once: true });
      previous.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        () => {
          // The previous turn's release never rejects, but a chain that somehow did
          // must not wedge this one.
          signal.removeEventListener('abort', onAbort);
          resolve();
        }
      );
    });
  }
}

module.exports = { TurnQueue, TurnCancelled };
