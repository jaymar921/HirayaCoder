'use strict';

/**
 * One turn at a time, and — the part that actually bites — the lane is always handed on.
 *
 * A queue that can wedge is worse than no queue: the failure it replaces was two turns
 * interfering, and the failure it must not introduce is every tab blocked forever
 * behind a turn that threw, or was cancelled, or belonged to a tab that has closed.
 */

const assert = require('assert');

const { TurnQueue, TurnCancelled } = require('../../app/core/turnQueue');

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('TurnQueue', () => {
  it('runs a single turn immediately', async () => {
    const queue = new TurnQueue();
    const release = await queue.acquire({ label: 'session 1' });

    assert.strictEqual(queue.busy, true);
    assert.strictEqual(queue.activeLabel, 'session 1');

    release();
    assert.strictEqual(queue.busy, false);
  });

  it('serialises two turns rather than interleaving them', async () => {
    const queue = new TurnQueue();
    /** @type {string[]} */
    const order = [];

    const one = (async () => {
      const release = await queue.acquire({ label: 'one' });
      order.push('one:start');
      await sleep(20);
      order.push('one:end');
      release();
    })();

    // Started while the first is mid-flight.
    const two = (async () => {
      const release = await queue.acquire({ label: 'two' });
      order.push('two:start');
      order.push('two:end');
      release();
    })();

    await Promise.all([one, two]);
    assert.deepStrictEqual(order, ['one:start', 'one:end', 'two:start', 'two:end']);
  });

  it('tells the second turn what it is waiting for', async () => {
    const queue = new TurnQueue();
    const release = await queue.acquire({ label: 'session 3' });

    /** @type {any[]} */
    const waits = [];
    const second = queue.acquire({ label: 'session 4', onWait: (info) => waits.push(info) });

    assert.strictEqual(waits.length, 1);
    assert.strictEqual(waits[0].activeLabel, 'session 3');

    release();
    (await second)();
  });

  it('does not call onWait when the lane is free', async () => {
    const queue = new TurnQueue();
    let called = false;
    const release = await queue.acquire({ onWait: () => { called = true; } });

    assert.strictEqual(called, false);
    release();
  });

  it('hands the lane on when a turn throws', async () => {
    const queue = new TurnQueue();

    await assert.rejects(async () => {
      const release = await queue.acquire({ label: 'boom' });
      try {
        throw new Error('turn failed');
      } finally {
        release();
      }
    }, /turn failed/);

    // The next one must not be stuck behind the failure.
    const release = await queue.acquire({ label: 'after' });
    assert.strictEqual(queue.activeLabel, 'after');
    release();
  });

  it('survives a release called twice', async () => {
    const queue = new TurnQueue();
    const release = await queue.acquire();
    release();
    release();

    const second = await queue.acquire({ label: 'second' });
    assert.strictEqual(queue.activeLabel, 'second');
    second();
  });

  describe('cancelling a turn that is still waiting', () => {
    it('rejects with TurnCancelled and never runs', async () => {
      const queue = new TurnQueue();
      const release = await queue.acquire({ label: 'running' });

      const controller = new AbortController();
      const waiting = queue.acquire({ label: 'waiting', signal: controller.signal });
      controller.abort();

      await assert.rejects(waiting, (err) => err instanceof TurnCancelled);
      release();
    });

    it('does not block the turns behind it', async () => {
      // The case that would wedge every other tab: a queued turn is cancelled, and the
      // chain has to skip over it rather than wait on a promise nobody will resolve.
      const queue = new TurnQueue();
      const releaseFirst = await queue.acquire({ label: 'first' });

      const controller = new AbortController();
      const cancelled = queue.acquire({ label: 'cancelled', signal: controller.signal });
      const third = queue.acquire({ label: 'third' });

      controller.abort();
      await assert.rejects(cancelled, (err) => err instanceof TurnCancelled);

      releaseFirst();

      const release = await third;
      assert.strictEqual(queue.activeLabel, 'third');
      release();
    });

    it('rejects immediately for a signal that has already fired', async () => {
      const queue = new TurnQueue();
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        queue.acquire({ signal: controller.signal }),
        (err) => err instanceof TurnCancelled
      );

      // And the lane is still usable.
      const release = await queue.acquire({ label: 'fine' });
      assert.strictEqual(queue.activeLabel, 'fine');
      release();
    });

    it('ignores a signal that fires after the turn has started', async () => {
      const queue = new TurnQueue();
      const controller = new AbortController();
      const release = await queue.acquire({ label: 'started', signal: controller.signal });

      // Cancelling the turn itself is `session.cancel()`; this controller is spent.
      controller.abort();
      assert.strictEqual(queue.activeLabel, 'started');

      release();
      assert.strictEqual(queue.busy, false);
    });
  });

  it('keeps a correct waiting count', async () => {
    const queue = new TurnQueue();
    const first = await queue.acquire();
    assert.strictEqual(queue.waiting, 0);

    const second = queue.acquire();
    const third = queue.acquire();
    await sleep(0);
    assert.strictEqual(queue.waiting, 2);

    first();
    (await second)();
    (await third)();
    assert.strictEqual(queue.waiting, 0);
    assert.strictEqual(queue.busy, false);
  });

  it('never lets two turns overlap, even with cancellations mixed in', async () => {
    // The regression guard for a real bug in the first version: a cancelled middle
    // entry resolved its own link immediately, which released the turn queued *behind*
    // it while the turn in *front* was still running. Ordering assertions did not catch
    // it; counting concurrent holders does.
    const queue = new TurnQueue();
    let active = 0;
    let peak = 0;

    const hold = async (signal) => {
      let release;
      try {
        release = await queue.acquire({ signal });
      } catch {
        return; // cancelled before it started, which is fine
      }
      active += 1;
      peak = Math.max(peak, active);
      await sleep(5);
      active -= 1;
      release();
    };

    const cancelMe = new AbortController();
    const runs = [hold(), hold(cancelMe.signal), hold(), hold(cancelMe.signal), hold()];
    cancelMe.abort();

    await Promise.all(runs);

    assert.strictEqual(peak, 1, `two turns held the lane at once (peak ${peak})`);
    assert.strictEqual(queue.busy, false);
    assert.strictEqual(queue.waiting, 0);
  });

  it('preserves FIFO order across several turns', async () => {
    const queue = new TurnQueue();
    /** @type {number[]} */
    const order = [];
    const running = await queue.acquire();

    const queued = [1, 2, 3, 4].map((n) =>
      queue.acquire({ label: `s${n}` }).then((release) => {
        order.push(n);
        release();
      })
    );

    running();
    await Promise.all(queued);
    assert.deepStrictEqual(order, [1, 2, 3, 4]);
  });
});
