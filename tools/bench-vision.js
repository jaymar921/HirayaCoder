'use strict';

/* eslint-disable security/detect-non-literal-fs-filename --
 * A developer benchmark script. Every path it touches is either the fixture directory
 * shipped in this repo or the results directory named on the command line, and the only
 * computed keys are fixture ids and axis names defined in this file. */

/**
 * The image-recognition benchmark.
 *
 * `bench-build.js` asks whether a model can build a project. This asks the much smaller
 * question underneath 1.1.0's image feature: **when a user attaches a photo, does the
 * model actually see what is in it?**
 *
 * It matters more than it sounds. A vision model that cannot see does not error — it
 * writes a fluent, confident paragraph about something else, and because that paragraph
 * then becomes the *only* thing the coding model is told about the picture (see
 * `core/imageRecognition`), a misread propagates silently into the answer. So the point
 * of this harness is to catch a describer that is wrong while sounding right.
 *
 * ## Nothing is graded on fluency
 *
 * Every fixture below carries a hand-written expectation of what is actually in the
 * photograph, and the description is graded against that and nothing else. Three axes,
 * scored separately because they fail separately:
 *
 *   1. **subject**  — did it name the right thing? Any accepted synonym counts.
 *   2. **detail**   — did it get the supporting facts: the colour, the setting, the count?
 *   3. **text**     — did it read the words that are visibly in the image?
 *
 * And one that can only be lost:
 *
 *   4. **confusion** — did it assert something the picture contradicts? A cat described
 *      as a dog fails here even if it scored on everything else, and this is the axis
 *      that separates "vague" from "wrong". Vague is usable; wrong is worse than
 *      nothing, because the user cannot tell.
 *
 * Keyword matching is crude and deliberately so. The alternative is grading one local
 * model's output with another local model, which makes the benchmark's own reliability
 * the thing in question. A word list cannot be talked into a false positive.
 *
 * ## Why the timings need `--cold` to mean anything
 *
 * Ollama caches the tokenized prompt, and for these requests the prompt is mostly the
 * image. So the second sample of the same picture comes back in about a second where
 * the first took fifteen, and the cache survives between *runs* as well — re-running
 * this harness half an hour later reported one second for everything, for a model that
 * genuinely takes fifteen.
 *
 * A benchmark that publishes that number publishes something nobody can reproduce. So
 * timings are reported in two columns, `cold` and `warm`, and `--cold` unloads the
 * model between samples to make the cold column honest. Without the flag, treat the
 * cold column as a lower bound and nothing more.
 *
 * None of this touches the accuracy scores. A cached answer is the same answer.
 *
 * ## Results are one file per run
 *
 *   benchmarks/results/<machine>/vision__<model>__<timestamp>.json
 *
 * Same convention as every other harness here, and for the same reason: machines A, B
 * and C write into their own directories, so three people can run this at once and
 * merge with no conflict. See `benchmarks/README.md`.
 *
 * ## Usage
 *
 *   node tools/bench-vision.js <model> --machine <A|B|C> [options]
 *
 *   node tools/bench-vision.js minicpm-v4.6:latest --machine B
 *   node tools/bench-vision.js qwen3.5:0.8b --machine B --purpose task
 *   node tools/bench-vision.js qwen3.5:2b --machine A --images cat,dog --repeat 2
 *
 *   --machine <A|B|C>   Required. Which machine this is; picks the results directory.
 *   --purpose <p>       answer (default), task, or both. The two prompts in
 *                       `core/imageRecognition`; they are graded identically.
 *   --images <list>     Fixture ids, comma separated. Default: all of them.
 *   --repeat <n>        Runs per image, default 1. Small vision models are not stable
 *                       across samples, and one run cannot tell luck from capability.
 *   --cold              Unload the model before every sample, so the timings are what a
 *                       user actually waits. Much slower. See the note on caching below.
 *   --notes "..."       Free text stored in the record — put the `ollama ps` split here.
 *   --out <dir>         Results root, default benchmarks/results.
 */

const fs = require('fs');
const path = require('path');

const appRoot = path.join(__dirname, '..', 'app');
const { createClient } = require(path.join(appRoot, 'core', 'ollamaClient'));
const imageRecognition = require(path.join(appRoot, 'core', 'imageRecognition'));
const { readImage } = require(path.join(appRoot, 'features', 'imageContext'));
const { parseArgs } = require('./lib/args');

/** Where the fixture photographs live. */
const IMAGE_DIR = path.join(__dirname, '..', 'docs', 'test-images');

/**
 * What is actually in each photograph.
 *
 * Written by looking at them, not by reading their filenames — `dog-1.jpg` is a corgi
 * and `dog.jpg` is two retriever puppies, and a benchmark that graded both against
 * "dog" would miss a describer that cannot count or cannot tell a breed from a species.
 *
 * `subject` and `detail` groups are OR within a group and AND across groups: one word
 * from each group has to appear. That shape is what lets "puppy" count for "dog"
 * without letting "animal" count for everything.
 *
 * `confusers` are words whose presence is a factual error about this specific image.
 * They are chosen narrowly. "Bird" is a confuser for the aeroplane because a model that
 * says bird has misclassified it; "sky" is not, because the aeroplane is in the sky.
 */
const FIXTURES = [
  {
    id: 'cat',
    file: 'cat.jpg',
    what: 'A tabby kitten lying down, head on a green surface, facing the camera.',
    subject: [['cat', 'kitten', 'feline']],
    detail: [
      ['tabby', 'stripe', 'striped', 'grey', 'gray', 'brown'],
      ['lying', 'laying', 'resting', 'rest', 'lies', 'down', 'green'],
    ],
    text: [],
    confusers: ['dog', 'puppy', 'rabbit', 'fox'],
  },
  {
    id: 'dog',
    file: 'dog.jpg',
    what: 'Two golden retriever puppies sitting in grass strewn with orange petals.',
    subject: [['dog', 'puppy', 'puppies', 'retriever']],
    detail: [
      ['two', 'pair', 'both', 'couple'],
      ['grass', 'field', 'lawn', 'meadow', 'flower', 'petal', 'orange'],
    ],
    text: [],
    confusers: ['cat', 'kitten'],
  },
  {
    id: 'dog-1',
    file: 'dog-1.jpg',
    what: 'A single corgi lying in sunlit grass, wearing a green collar.',
    subject: [['dog', 'corgi', 'puppy']],
    detail: [
      ['grass', 'field', 'lawn', 'meadow', 'outdoor'],
      ['collar', 'white', 'orange', 'tan', 'brown', 'ears'],
    ],
    text: [],
    // Not 'cat' alone here: this one is a corgi, and calling it a generic dog is
    // imprecise rather than wrong. Only a different species counts as confusion.
    confusers: ['cat', 'kitten', 'fox cub'],
  },
  {
    id: 'car',
    file: 'car.jpg',
    what: 'A yellow BMW M4 coupe on a road, panning shot, bare trees behind.',
    subject: [['car', 'coupe', 'vehicle', 'sedan', 'automobile', 'bmw']],
    detail: [
      ['yellow', 'gold', 'golden', 'lime'],
      ['road', 'highway', 'street', 'motion', 'driving', 'speed', 'blur'],
    ],
    // The badge is legible. A describer that reads it is doing real work; one that does
    // not has still described the picture correctly, so this axis is scored apart.
    text: ['bmw'],
    confusers: ['truck', 'motorcycle', 'bus', 'bicycle'],
  },
  {
    id: 'plane',
    file: 'plane.jpg',
    what: 'A Cebu Pacific Airbus A320 on approach, gear down, against grey sky.',
    subject: [['plane', 'airplane', 'aeroplane', 'aircraft', 'jet', 'airliner', 'airbus']],
    detail: [
      ['yellow', 'white', 'blue', 'green', 'teal'],
      ['sky', 'flying', 'flight', 'landing', 'air', 'gear', 'wheels'],
    ],
    // The largest text in the frame, in a clear typeface. This is the fixture that
    // separates a describer that reads from one that only classifies.
    text: ['cebu'],
    confusers: ['helicopter', 'bird', 'rocket', 'boat'],
  },
  {
    id: 'tree',
    file: 'tree.jpg',
    what: 'One large green tree alone in a grassy field at sunset, blue sky above.',
    subject: [['tree', 'oak']],
    detail: [
      ['field', 'grass', 'meadow', 'grassland'],
      ['sky', 'sunset', 'sunrise', 'blue', 'green', 'sun'],
    ],
    text: [],
    confusers: ['forest', 'city', 'building', 'people'],
  },
];

/**
 * Does the description contain any word from this group?
 *
 * Word-boundary matched rather than substring: `'car'` must not be satisfied by
 * "carpet", and `'jet'` must not be satisfied by "jetty". This was not a hypothetical —
 * the first draft matched plain `includes` and scored a description of a cat on a
 * *carpet* as having identified a car.
 *
 * @param {string} haystack Lowercased description.
 * @param {string[]} group
 * @returns {string | null} The word that matched, for the record.
 */
function matchAny(haystack, group) {
  for (const word of group) {
    // Built from the fixture word lists in this file, escaped, and never from model
    // output or user input.
    // eslint-disable-next-line security/detect-non-literal-regexp
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?\\b`, 'i');
    if (pattern.test(haystack)) return word;
  }
  return null;
}

/**
 * Grade one description against one fixture.
 *
 * @param {typeof FIXTURES[0]} fixture
 * @param {string} description
 */
function grade(fixture, description) {
  const text = String(description || '').toLowerCase();

  const subjectHits = fixture.subject.map((group) => matchAny(text, group));
  const detailHits = fixture.detail.map((group) => matchAny(text, group));
  const textHits = fixture.text.map((word) => matchAny(text, [word]));
  const confused = fixture.confusers.filter((word) => matchAny(text, [word]));

  const subject = subjectHits.every(Boolean);
  const detail = detailHits.filter(Boolean).length;
  const detailTotal = fixture.detail.length;
  const readText = fixture.text.length === 0 ? null : textHits.every(Boolean);

  return {
    // The headline. A description that names the wrong animal is not partially right,
    // whatever else it got, so a confusion sinks the whole fixture rather than
    // subtracting from it.
    passed: subject && confused.length === 0,
    subject,
    subjectMatched: subjectHits.filter(Boolean),
    detail,
    detailTotal,
    detailMatched: detailHits.filter(Boolean),
    // Null means this image has no text in it, which is different from failing to read
    // text that is there. Averaging those together would punish a describer for the
    // fixtures rather than for its own performance.
    readText,
    textMatched: textHits.filter(Boolean),
    confused,
  };
}

/**
 * Evict the model from memory, so the next call pays the real cost.
 *
 * `keep_alive: 0` on a generate call with no prompt is Ollama's own way of saying
 * "unload this now", and it is what `ollama stop` does underneath. Going through the
 * HTTP client rather than spawning the CLI keeps this harness free of `child_process`
 * and inside the same loopback-only path as everything else the project talks to.
 *
 * A failure is logged and ignored. An un-evicted model produces an optimistic timing,
 * which is worth far less than losing the run over.
 *
 * @param {import('../app/core/ollamaClient').OllamaClient} client
 * @param {string} model
 */
async function unload(client, model) {
  try {
    await client.generate({ model, prompt: '', keep_alive: 0 });
  } catch (err) {
    console.log(`  (could not unload ${model}: ${/** @type {Error} */ (err).message}; timing will be optimistic)`);
  }
}

/**
 * @param {string} model
 * @param {string} purpose
 * @param {typeof FIXTURES} fixtures
 * @param {number} repeat
 * @param {import('../app/core/ollamaClient').OllamaClient} client
 */
async function runPurpose(client, model, purpose, fixtures, repeat, cold) {
  /** @type {object[]} */
  const results = [];

  for (const fixture of fixtures) {
    const absolute = path.join(IMAGE_DIR, fixture.file);
    const read = await readImage(absolute);
    if (!read.ok) {
      console.log(`  ${fixture.id.padEnd(8)} SKIPPED — ${read.error}`);
      results.push({ id: fixture.id, file: fixture.file, purpose, skipped: read.error });
      continue;
    }

    for (let attempt = 1; attempt <= repeat; attempt += 1) {
      // The cache in `imageRecognition` is keyed on content+purpose+model, so a second
      // sample of the same image would be the first one handed back. Cleared between
      // attempts because measuring the cache is not the point.
      imageRecognition._clearCache();
      // Ollama's own cache is the one that matters, and only this clears it.
       
      if (cold) await unload(client, model);

      const started = Date.now();
        const described = await imageRecognition.describe({
        client,
        model,
        image: { name: fixture.file, base64: read.image.base64 },
        purpose,
      });
      const ms = Date.now() - started;

      const scored = described.ok
        ? grade(fixture, described.description)
        : { passed: false, subject: false, error: described.description };

      const mark = scored.passed ? 'PASS' : 'FAIL';
      const note = scored.confused && scored.confused.length > 0 ? ` (called it a ${scored.confused[0]})` : '';
      const detail = scored.detailTotal ? ` detail ${scored.detail}/${scored.detailTotal}` : '';
      const read_ = scored.readText === null ? '' : scored.readText ? ' text ok' : ' text missed';
      console.log(
        `  ${fixture.id.padEnd(8)} ${purpose.padEnd(6)} ${mark}${note}${detail}${read_}  ${Math.round(ms / 1000)}s`
      );

      results.push({
        id: fixture.id,
        file: fixture.file,
        purpose,
        attempt,
        durationMs: ms,
        ok: described.ok,
        // Stored in full. When a score looks wrong the only way to tell a bad grader
        // from a bad model is to read what the model actually wrote.
        description: described.description,
        expected: fixture.what,
        ...scored,
      });
    }
  }

  return results;
}

/**
 * @param {object[]} results
 */
function summarize(results) {
  const graded = results.filter((r) => !r.skipped && r.ok);
  const passed = graded.filter((r) => r.passed).length;
  const confused = graded.filter((r) => r.confused && r.confused.length > 0).length;

  const detailScored = graded.filter((r) => typeof r.detailTotal === 'number' && r.detailTotal > 0);
  const detailGot = detailScored.reduce((sum, r) => sum + r.detail, 0);
  const detailMax = detailScored.reduce((sum, r) => sum + r.detailTotal, 0);

  const withText = graded.filter((r) => r.readText !== null && r.readText !== undefined);
  const textRead = withText.filter((r) => r.readText).length;

  const totalMs = graded.reduce((sum, r) => sum + (r.durationMs || 0), 0);

  // Only the first sample of each image is a cold measurement.
  //
  // Ollama caches the prompt prefix, and the prefix here is the image — so attempt 2 of
  // the same picture with the same prompt comes back in about a second where attempt 1
  // took fifteen. Averaging them together produced a "4s per image" headline for a
  // model that takes fifteen, which is the kind of number that gets quoted and then
  // does not reproduce for anybody.
  //
  // The repeats are still worth running; they just measure a different thing.
  // Consistency is what they are for, and latency is what `coldMeanMs` is for.
  const cold = graded.filter((r) => r.attempt === 1);
  const coldMs = cold.reduce((sum, r) => sum + (r.durationMs || 0), 0);

  return {
    graded: graded.length,
    passed,
    failed: graded.length - passed,
    confused,
    detailScore: detailMax > 0 ? Number((detailGot / detailMax).toFixed(3)) : null,
    detailGot,
    detailMax,
    textImages: withText.length,
    textRead,
    errored: results.filter((r) => !r.skipped && !r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    meanMs: graded.length > 0 ? Math.round(totalMs / graded.length) : 0,
    coldMeanMs: cold.length > 0 ? Math.round(coldMs / cold.length) : 0,
    coldSamples: cold.length,
    totalMs,
  };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const model = positional[0];

  if (!model) {
    console.error('Usage: node tools/bench-vision.js <model> --machine <A|B|C> [--purpose answer|task|both]');
    process.exit(1);
  }

  const machine = String(flags.machine || '').toUpperCase();
  if (!['A', 'B', 'C'].includes(machine)) {
    console.error('--machine is required and must be A, B, or C. It picks the results directory.');
    process.exit(1);
  }

  const purposeFlag = String(flags.purpose || 'answer').toLowerCase();
  const purposes = purposeFlag === 'both' ? ['answer', 'task'] : [purposeFlag];
  for (const purpose of purposes) {
    if (purpose !== 'answer' && purpose !== 'task') {
      console.error(`--purpose must be answer, task, or both. Got "${purpose}".`);
      process.exit(1);
    }
  }

  const only = flags.images
    ? String(flags.images)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  const fixtures = only ? FIXTURES.filter((f) => only.includes(f.id)) : FIXTURES;
  if (fixtures.length === 0) {
    console.error(`No fixture matched --images. Available: ${FIXTURES.map((f) => f.id).join(', ')}`);
    process.exit(1);
  }

  const repeat = Math.max(1, Number(flags.repeat) || 1);
  const cold = flags.cold === true || flags.cold === 'true';
  const client = createClient({ endpoint: flags.endpoint || 'http://127.0.0.1:11434', timeoutMs: 300000 });

  // Checked before a long run rather than discovered thirty seconds in. A model without
  // vision does not refuse an image, so without this the whole sweep would complete and
  // score zero for a reason the numbers would not explain.
  const tags = await client.tags();
  const entry = (tags || []).find((t) => t.name === model || t.model === model);
  if (!entry) {
    console.error(`${model} is not installed. Run: ollama pull ${model}`);
    process.exit(1);
  }
  const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
  if (!capabilities.includes('vision')) {
    console.error(
      `${model} does not report the "vision" capability, so it cannot read an image. ` +
        `It reports: ${capabilities.join(', ') || '(nothing)'}.`
    );
    process.exit(1);
  }

  const startedAt = new Date();
  console.log(`\nbench-vision — ${model} on machine ${machine}`);
  console.log(`${fixtures.length} image(s) × ${repeat} run(s) × ${purposes.length} prompt(s)\n`);

  /** @type {object[]} */
  let results = [];
  for (const purpose of purposes) {
    results = results.concat(await runPurpose(client, model, purpose, fixtures, repeat, cold));
  }

  const summary = summarize(results);
  const record = {
    schemaVersion: 1,
    benchmark: 'vision',
    model,
    machine,
    params: (entry.details && entry.details.parameter_size) || null,
    capabilities,
    purposes,
    repeat,
    // Recorded because it changes what the timings mean, and a reader of the JSON
    // cannot tell otherwise.
    coldStart: cold,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    notes: flags.notes || '',
    summary,
    results,
  };

  const outRoot = flags.out || path.join(__dirname, '..', 'benchmarks', 'results');
  const dir = path.join(outRoot, machine);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `vision__${model.replace(/[:/\\]/g, '-')}__${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

  console.log(`\n  subject      ${summary.passed}/${summary.graded}`);
  console.log(`  detail       ${summary.detailGot}/${summary.detailMax}`);
  console.log(
    `  text read    ${summary.textImages > 0 ? `${summary.textRead}/${summary.textImages}` : 'no image had any'}`
  );
  console.log(`  confused     ${summary.confused}`);
  console.log(
    `  cold         ${Math.round(summary.coldMeanMs / 1000)}s per image` +
      (cold ? ' (model unloaded first)' : ' (first sample; NOT a true cold start, pass --cold)')
  );
  console.log(`  warm         ${Math.round(summary.meanMs / 1000)}s per image (all samples, prompt-cached)`);
  console.log(`\nWritten to ${path.relative(process.cwd(), file)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
