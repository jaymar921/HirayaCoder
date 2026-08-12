/**
 * What the user watches while a local model thinks.
 *
 * On a CPU-only laptop a single turn can take a minute or more, and a bare spinner
 * for that long reads as a hang. These lines are here to make the wait feel like
 * someone is working rather than something is broken — Taglish, the way a Filipino
 * dev actually talks to a colleague who is waiting on a build.
 *
 * ## Ground rules for the copy
 *
 * The humour is *situational* — it is about the wait, the machine, and the coffee.
 * Nothing here characterises Filipinos, and nothing plays a group for laughs. A line
 * belongs only if a Filipino developer would say it to a teammate about a slow build.
 * That is the test any new line has to pass.
 *
 * The lines are also honest. They say the wait is long when it is long; none of them
 * claims progress the extension cannot see.
 */

/** Shown while the model is working. Rotated so a long wait does not read as frozen. */
export const THINKING_LINES = [
  'Nag-iisip pa si mister...',
  'Antay ka lang, matatapos din \'to...',
  'Naku! Ang hirap neto, saglit lang...',
  'Kutaw ka muna ng kape, matagal pa \'to...',
  'Hinihimay pa ang code...',
  'Sandali lang, iniisip pa ang sagot...',
  'Tinitignan pa ang mga files...',
  'Konting tiis, malapit na...',
  'Pinapaghugot pa ang logic...',
  'Nagbabasa pa, \'wag mo munang i-close...',
];

/**
 * Lines for a wait that has gone on long enough to need acknowledging.
 *
 * Swapping to these after a while is the honest move: a model that has been running
 * for two minutes should not still be saying "saglit lang".
 */
export const LONG_WAIT_LINES = [
  'Grabe, ang tagal talaga... pero tuloy pa rin...',
  'Buhay pa naman, mabagal lang...',
  'Ito na talaga, promise... siguro...',
  'Malaki yata ang tanong mo, ha...',
  'Nagpapahinga muna ang processor, sandali...',
];

/** After this long, switch to the honest-about-it lines. */
const LONG_WAIT_MS = 90000;

/** How often the line changes. Long enough to read, short enough to feel alive. */
const ROTATE_MS = 4200;

/**
 * Pick a line, avoiding an immediate repeat.
 *
 * @param {string[]} pool
 * @param {string} previous
 * @returns {string}
 */
export function pickLine(pool, previous) {
  if (pool.length === 0) return '';
  if (pool.length === 1) return pool[0];
  const choices = pool.filter((line) => line !== previous);
  return choices[Math.floor(Math.random() * choices.length)];
}

/**
 * A live "thinking" row: animated dots, a rotating line, and elapsed seconds.
 *
 * The elapsed counter is deliberate. The jokes make the wait pleasant; the counter
 * makes it *legible* — it is the part that tells the user whether 40 seconds is
 * normal for their model, and the thing they can quote when it is not.
 */
export class ThinkingIndicator {
  constructor() {
    this.startedAt = Date.now();
    this.current = '';
    /** @type {number | null} */
    this._timer = null;

    this.el = document.createElement('div');
    this.el.className = 'thinking';
    this.el.setAttribute('role', 'status');
    // Announced once by a screen reader; the rotating text is decorative and would
    // otherwise interrupt every few seconds.
    this.el.setAttribute('aria-label', 'HirayaCoder is thinking');

    const spark = document.createElement('span');
    spark.className = 'thinking-spark';
    spark.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 3; i += 1) {
      const dot = document.createElement('i');
      dot.style.animationDelay = `${i * 160}ms`;
      spark.appendChild(dot);
    }

    this.textEl = document.createElement('span');
    this.textEl.className = 'thinking-text';
    this.textEl.setAttribute('aria-hidden', 'true');

    this.timeEl = document.createElement('span');
    this.timeEl.className = 'thinking-time';

    this.el.appendChild(spark);
    this.el.appendChild(this.textEl);
    this.el.appendChild(this.timeEl);

    this._rotate();
    this._tick();
    this._timer = window.setInterval(() => {
      this._rotate();
    }, ROTATE_MS);
    this._clock = window.setInterval(() => this._tick(), 1000);
  }

  /** @private */
  _rotate() {
    const elapsed = Date.now() - this.startedAt;
    const pool = elapsed > LONG_WAIT_MS ? LONG_WAIT_LINES : THINKING_LINES;
    this.current = pickLine(pool, this.current);

    // Restarting the animation requires the class to actually leave the element,
    // so it is removed, the layout is flushed, and it goes back on.
    this.textEl.classList.remove('is-in');
    void this.textEl.offsetWidth;
    this.textEl.textContent = this.current;
    this.textEl.classList.add('is-in');
  }

  /** @private */
  _tick() {
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    this.timeEl.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  /** Update the step counter shown alongside the line. */
  setStep(step, maxSteps) {
    if (!this.stepEl) {
      this.stepEl = document.createElement('span');
      this.stepEl.className = 'thinking-step';
      this.el.appendChild(this.stepEl);
    }
    this.stepEl.textContent = `step ${step}/${maxSteps}`;
  }

  dispose() {
    if (this._timer !== null) window.clearInterval(this._timer);
    if (this._clock) window.clearInterval(this._clock);
    this._timer = null;
    this.el.remove();
  }
}
