'use strict';

/**
 * Reading a request's own structure as a plan.
 *
 * The cases here are the ones that decide whether the split helps or hurts: a short
 * request must not be split at all, a constraints section must not become an item, and
 * the order and wording must be the user's rather than a paraphrase. The long fixture
 * is the real benchmark brief, because the whole feature exists for briefs that shape.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const requestPlan = require('../../app/core/requestPlan');

const BRIEF = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'prompts', 'todo-glass-app.md'), 'utf8');

describe('requestPlan.fromRequest — when not to split', () => {
  it('leaves a one-line request alone', () => {
    const plan = requestPlan.fromRequest('Fix the login bug in src/auth.js.');
    assert.strictEqual(plan.items.length, 0);
    assert.match(plan.reason, /one pass/);
  });

  it('leaves a long request with no structure alone', () => {
    const plan = requestPlan.fromRequest('Please rewrite the parser. '.repeat(60));
    assert.strictEqual(plan.items.length, 0);
    assert.match(plan.reason, /no headings or numbered steps/);
  });

  it('does not split a long request with a single heading', () => {
    const plan = requestPlan.fromRequest('## The work\n\n' + 'Rewrite the parser so it handles nested quotes. '.repeat(30));
    assert.strictEqual(plan.items.length, 0);
  });

  it('does not split on three short bullets', () => {
    // Short enough to fit one window: splitting costs two extra prompts to save nothing.
    const plan = requestPlan.fromRequest('1. Add a button.\n2. Wire it up.\n3. Test it.');
    assert.strictEqual(plan.items.length, 0);
  });
});

describe('requestPlan.fromRequest — the benchmark brief', () => {
  const plan = requestPlan.fromRequest(BRIEF);

  it('splits it into one item per section of work', () => {
    assert.strictEqual(plan.items.length, 6);
  });

  it('keeps the user’s own order', () => {
    const titles = plan.items.map((item) => item.text);
    assert.match(titles[0], /Project Setup/);
    assert.match(titles[1], /Folder Structure/);
    assert.match(titles[2], /Features/);
    assert.match(titles[3], /Design Requirements/);
    assert.match(titles[4], /README/);
    assert.match(titles[5], /Build Verification/);
  });

  it('keeps the tech stack as a constraint rather than as work', () => {
    // Five lines of "React", "Vite", "Tailwind", "No backend" — nothing to do, and
    // everything to obey. As an item it would be a session that changes no file.
    assert.strictEqual(
      plan.items.some((item) => /Tech Stack/i.test(item.text)),
      false
    );
    assert.match(plan.constraints, /Tech Stack/);
    assert.match(plan.constraints, /Vite as the build tool/);
  });

  it('drops the closing "Output" section, which asks for a message and not for work', () => {
    assert.strictEqual(
      plan.items.some((item) => /^Output/i.test(item.text)),
      false
    );
    assert.match(plan.reason, /dropping "Output" as reporting/);
  });

  it('gives every item the user’s own words to work from', () => {
    for (const item of plan.items) {
      assert.ok(item.detail.length > 0, `${item.text} has no detail`);
      assert.ok(BRIEF.includes(item.detail.split('\n')[1] || item.detail), 'detail must be a span of the request');
    }
  });

  it('keeps each item small enough to restate every turn', () => {
    for (const item of plan.items) {
      assert.ok(item.text.length <= requestPlan.MAX_ITEM_CHARS, `${item.text} is too long`);
    }
  });

  it('names the file the structure section is about, so stepBrief can pick it up', () => {
    const structure = plan.items.find((item) => /Folder Structure/.test(item.text));
    assert.match(structure.detail, /useTodos\.js/);
    assert.match(structure.detail, /TodoItem\.jsx/);
  });
});

describe('requestPlan.fromRequest — numbered requests', () => {
  const REQUEST = [
    'Please do the following to the reporting service, in order.',
    '',
    '1. Add a /health endpoint that returns 200 and the build sha. It should not touch the database,',
    '   because the load balancer polls it every second and we do not want the extra query load.',
    '2. Install the prometheus client and expose /metrics with request counts and latencies,',
    '   labelled by route and status code, using the default registry.',
    '3. Write the runbook in docs/oncall.md covering what to do when either endpoint stops responding,',
    '   with the escalation path, the dashboard links, and the two alerts that page rather than',
    '   emailing. Say explicitly which of them is safe to silence overnight and which is not, because',
    '   the last incident was made worse by somebody silencing the wrong one at three in the morning.',
  ].join('\n');

  it('splits on top-level numbers when there are no headings', () => {
    const plan = requestPlan.fromRequest(REQUEST);
    assert.strictEqual(plan.items.length, 3);
    assert.match(plan.items[0].text, /health endpoint/);
    assert.match(plan.items[2].text, /runbook/);
  });

  it('keeps each step’s own explanation with it', () => {
    const plan = requestPlan.fromRequest(REQUEST);
    assert.match(plan.items[0].detail, /load balancer polls it every second/);
  });
});

describe('requestPlan.fromRequest — heading depth', () => {
  it('cuts at the shallowest heading level, so subsections stay inside their section', () => {
    const request = [
      '## Backend',
      'Create the endpoint in server/api.js and register it on the router so requests reach it.',
      '### Validation',
      'Reject a body over one megabyte with a 413 and a message naming the limit.',
      '## Frontend',
      'Add the form in web/src/Form.jsx and post to the endpoint above, showing the error inline.',
      '### Styling',
      'Use the existing form classes rather than adding new ones for this one screen.',
    ].join('\n\n');
    const plan = requestPlan.fromRequest(request + '\n' + 'Keep the existing tests passing. '.repeat(12));
    assert.strictEqual(plan.items.length, 2);
    assert.match(plan.items[0].detail, /Validation/);
    assert.match(plan.items[1].detail, /Styling/);
  });
});

describe('requestPlan.hasInstruction', () => {
  it('reads a constraint list as having nothing to do', () => {
    assert.strictEqual(
      requestPlan.hasInstruction([
        '- React (functional components + hooks only)',
        '- Vite as the build tool',
        '- No backend — use in-memory React state',
      ]),
      false
    );
  });

  it('reads a line that opens with a verb as an instruction', () => {
    assert.strictEqual(requestPlan.hasInstruction(['- Add 1–2 soft floating blurred blue circles']), true);
  });
});
