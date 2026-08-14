'use strict';

const assert = require('assert');

const stepGuard = require('../../app/agent/stepGuard');

/** @param {object} over */
const evidence = (over = {}) => ({
  item: 'Assemble App.jsx layout with glassmorphism styling',
  stopReason: 'done',
  changed: [],
  steps: [],
  ...over,
});

describe('stepGuard', () => {
  describe('pathAnswers', () => {
    it('matches a bare filename against the full path it was written to', () => {
      assert.strictEqual(stepGuard.pathAnswers('todo-glass-app/src/App.jsx', 'App.jsx'), true);
    });

    it('matches an exact path', () => {
      assert.strictEqual(stepGuard.pathAnswers('src/hooks/useTodos.js', 'src/hooks/useTodos.js'), true);
    });

    it('matches a folder the step named', () => {
      assert.strictEqual(stepGuard.pathAnswers('src/components/TodoItem.jsx', 'src/components'), true);
    });

    it('does not match a different file', () => {
      assert.strictEqual(stepGuard.pathAnswers('vite.config.js', 'App.jsx'), false);
    });

    it('is not case- or separator-sensitive', () => {
      assert.strictEqual(stepGuard.pathAnswers('src\\App.jsx', 'app.jsx'), true);
    });
  });

  describe('verify', () => {
    it('passes a step that wrote the file it named', () => {
      const verdict = stepGuard.verify(
        evidence({ changed: [{ kind: 'edit', path: 'todo-glass-app/src/App.jsx' }] })
      );
      assert.strictEqual(verdict.ok, true);
      assert.strictEqual(verdict.reason, 'changed');
    });

    it('fails a step that changed nothing', () => {
      const verdict = stepGuard.verify(evidence());
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, 'no-change');
      assert.match(verdict.detail, /no work at all/);
    });

    // The macOS 0.6.0 run: `npx create-vite` exit 0, `npm install` exit 0, twenty
    // seconds of it, the project on disk — and the step was written off as "nothing was
    // written", which stopped the run and skipped the five remaining items. A
    // scaffolder's output never passes through write_file, so the files half of the
    // change set is empty and the commands half is the only record that anything
    // happened.
    it('passes a step whose work was done by a command that succeeded', () => {
      const verdict = stepGuard.verify(
        evidence({
          item: 'Scaffold the Vite React project and install dependencies',
          commands: [
            { command: 'npx create-vite@latest todo-glass-app -- --template react', ok: true },
            { command: 'npm install', ok: true },
          ],
        })
      );

      assert.strictEqual(verdict.ok, true);
      assert.strictEqual(verdict.reason, 'ran');
      assert.match(verdict.detail, /npm install/);
      // Said out loud rather than passed silently: a later step needs to know the agent
      // wrote nothing itself before it assumes a file is there.
      assert.match(verdict.detail, /no files were written directly/);
    });

    it('still fails a step whose commands all failed', () => {
      const verdict = stepGuard.verify(
        evidence({
          item: 'Scaffold the Vite React project',
          commands: [{ command: 'npm install', ok: false }],
        })
      );
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, 'no-change');
    });

    it('names the blocking error when the step tried and was refused', () => {
      const verdict = stepGuard.verify(
        evidence({
          steps: [{ action: {}, result: { ok: false, observation: 'src/App.jsx does not exist.\nUse list_files.' } }],
        })
      );
      assert.strictEqual(verdict.reason, 'no-change');
      assert.match(verdict.detail, /src\/App\.jsx does not exist\./);
      assert.ok(!verdict.detail.includes('Use list_files'), 'the whole observation was pasted in');
    });

    it('fails a step that wrote the wrong file', () => {
      // gemma2:latest, working a list about useTodos / TodoInput / App.jsx, edited
      // vite.config.js and README.md and was scored as having changed something.
      const verdict = stepGuard.verify(
        evidence({ changed: [{ kind: 'edit', path: 'vite.config.js' }, { kind: 'edit', path: 'README.md' }] })
      );
      assert.strictEqual(verdict.ok, false);
      assert.strictEqual(verdict.reason, 'off-target');
      assert.match(verdict.detail, /this step is about App\.jsx/);
      assert.match(verdict.detail, /vite\.config\.js, README\.md/);
    });

    it('accepts any change when the step named no file', () => {
      const verdict = stepGuard.verify(
        evidence({ item: 'Install the dependencies', changed: [{ kind: 'edit', path: 'package.json' }] })
      );
      assert.strictEqual(verdict.ok, true);
    });

    it('passes work that landed without the model closing the loop', () => {
      const verdict = stepGuard.verify(
        evidence({ stopReason: 'budget', changed: [{ kind: 'edit', path: 'src/App.jsx' }] })
      );
      assert.strictEqual(verdict.ok, true, 'a real edit was failed for want of a sign-off');
      assert.strictEqual(verdict.reason, 'stopped');
    });
  });

  describe('rethink', () => {
    it('restates the ask, the failure, and one instruction', () => {
      const prompt = stepGuard.rethink({
        item: 'Assemble App.jsx layout',
        verdict: { ok: false, reason: 'no-change', detail: 'nothing was created or changed' },
        sessionChanges: [{ kind: 'create', path: 'src/hooks/useTodos.js' }],
      });

      assert.match(prompt, /What was asked: Assemble App\.jsx layout/);
      assert.match(prompt, /nothing was created or changed/);
      assert.match(prompt, /written so far: src\/hooks\/useTodos\.js/);
      assert.match(prompt, /call write_file for App\.jsx/);
    });

    it('forbids the answer the benchmark models actually gave', () => {
      // Both qwen3.5:4b and ornith:9b answered a completion challenge by asking the
      // user what to work on, with the request still in the same conversation.
      const prompt = stepGuard.rethink({ item: 'Write src/App.jsx', verdict: { detail: 'nothing was written' } });
      assert.match(prompt, /do not ask what to work on/i);
      assert.match(prompt, /Do not read more files first/);
    });
  });

  describe('workaround', () => {
    const base = {
      item: 'Scaffold the Vite project',
      position: 1,
      verdict: { ok: false, reason: 'no-change', detail: 'nothing was written' },
      remaining: ['Implement useTodos', 'Build TodoInput'],
      steps: [],
    };

    it('says where it stopped and what it did not attempt', () => {
      const notice = stepGuard.workaround(base);
      assert.match(notice, /Stopped at step 1: Scaffold the Vite project/);
      assert.match(notice, /remaining 2 step\(s\) were not attempted/);
      assert.match(notice, /- Implement useTodos/);
    });

    it('explains a declined confirmation', () => {
      const notice = stepGuard.workaround({
        ...base,
        steps: [{ action: {}, result: { ok: false, error: 'USER_DENIED', observation: 'declined' } }],
      });
      assert.match(notice, /confirmation was declined/);
      assert.match(notice, /Auto Edit/);
    });

    it('explains a refused shell operator', () => {
      // ornith:9b spent four steps on `npm create vite@latest … 2>&1` before giving up.
      const notice = stepGuard.workaround({
        ...base,
        steps: [{ action: {}, result: { ok: false, error: 'SHELL_METACHARACTER', observation: 'refused' } }],
      });
      assert.match(notice, /refused for containing a shell operator/);
    });

    it('explains a run that kept guessing at paths', () => {
      const notice = stepGuard.workaround({
        ...base,
        steps: [{ action: {}, result: { ok: false, error: 'ENOENT', observation: 'no such file' } }],
      });
      assert.match(notice, /paths it tried do not exist/);
    });

    it('always offers something actionable, even with no error code to go on', () => {
      const notice = stepGuard.workaround({ ...base, item: 'Write src/App.jsx', steps: [] });
      assert.match(notice, /write src\/App\.jsx/);
      assert.match(notice, /larger model/);
    });

    it('never offers to carry on regardless', () => {
      assert.ok(!/continue anyway|carry on|ignore this/i.test(stepGuard.workaround(base)));
    });
  });
});
