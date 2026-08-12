'use strict';

/**
 * The build benchmark's grading half.
 *
 * A benchmark that scores runs wrongly is worse than no benchmark: it produces numbers
 * that look authoritative and are not. The part worth testing is not the model loop —
 * that needs a real model — but the verdict: given a workspace, does `verify` reach the
 * right conclusion about it?
 *
 * So each language is checked three ways: a program that works, a program that runs and
 * prints the wrong thing, and a program that does not run at all. Only the first may
 * pass. The language tests skip themselves when the toolchain is missing, which is the
 * same rule the benchmark itself applies to a machine without a JDK.
 *
 * ## These tests start real compilers, so the default timeout does not apply
 *
 * Everything else in this suite is pure logic against a stubbed `vscode` and finishes in
 * microseconds. This file spawns `javac`, `java`, `node`, and `python` for real, and on a
 * cold CI runner the first spawn of a JVM alone can take several seconds — the
 * `windows-latest` job failed in exactly that way, timing out at 2000ms inside the
 * toolchain probe before a single Java test ran.
 *
 * Two things follow, and both are here rather than in a config file so the reason travels
 * with the code: the probes run once at load time instead of inside a hook, and the whole
 * describe gets a timeout sized for starting a compiler rather than for calling a
 * function.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { LANGUAGES, findFiles, parseArgs, slug, exec } = require('../../tools/bench-build');

/**
 * Deliberately above the harness's own 60s per-spawn cap in `exec`, so that a compiler
 * which genuinely hangs fails with the harness's reason rather than as an opaque Mocha
 * timeout that says nothing about which command stopped responding.
 */
const TOOLCHAIN_TIMEOUT_MS = 120000;

/** @param {string[]} argv */
function toolchainPresent(argv) {
  try {
    return exec(process.cwd(), argv).status === 0;
  } catch {
    return false;
  }
}

/**
 * Which toolchains this machine has, resolved once at load time.
 *
 * Probing inside a `before` hook put a process spawn under Mocha's 2000ms budget, which
 * is a budget for assertions, not for starting a JDK. Module load is not timed, and the
 * answer cannot change during a run.
 */
const AVAILABLE = {
  node: toolchainPresent(['node', '--version']),
  python: toolchainPresent(LANGUAGES.python.probe()),
  java: toolchainPresent(['javac', '-version']),
};

/** A temp workspace with the given files, cleaned up by the caller. */
function workspaceWith(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hiraya-benchtest-')));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

/** Does this verification satisfy the phase's expectations? Mirrors `runPhase`. */
function grade(spec, root, phaseIndex) {
  const verified = spec.verify(root);
  const missing = spec.phases[phaseIndex].expect.filter((pattern) => !pattern.test(verified.stdout || ''));
  return { passed: verified.ok && missing.length === 0, verified, missing };
}

// A regular function, not an arrow: `this.timeout` needs Mocha's context.
describe('bench-build verification', function benchBuildVerification() {
  this.timeout(TOOLCHAIN_TIMEOUT_MS);

  /** @type {string[]} */
  const created = [];
  const make = (files) => {
    const root = workspaceWith(files);
    created.push(root);
    return root;
  };

  after(() => {
    for (const root of created) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe('javascript', () => {
    before(function skipWithoutNode() {
      if (!AVAILABLE.node) this.skip();
    });

    it('passes a program that prints what the task asked for', () => {
      const root = make({ 'src/main.js': 'console.log("a");\nconsole.log("b");\nconsole.log("TOTAL: 2");\n' });
      assert.strictEqual(grade(LANGUAGES.javascript, root, 0).passed, true);
    });

    it('fails a program that runs cleanly and prints the wrong total', () => {
      // The failure a benchmark must not wave through: it exits 0 and looks fine.
      const root = make({ 'src/main.js': 'console.log("TOTAL: 3");\n' });
      const result = grade(LANGUAGES.javascript, root, 0);
      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.verified.ok, true);
      assert.strictEqual(result.missing.length, 1);
    });

    it('fails a program that throws', () => {
      const root = make({ 'src/main.js': 'require("./nope");\n' });
      assert.strictEqual(grade(LANGUAGES.javascript, root, 0).passed, false);
    });

    it('reports an empty workspace as having no entry point rather than crashing', () => {
      const result = LANGUAGES.javascript.verify(make({}));
      assert.strictEqual(result.ok, false);
      assert.match(result.reason, /no entry point/i);
    });

    it('requires both lines in the modify phase', () => {
      const root = make({ 'src/main.js': 'console.log("TOTAL: 2");\n' });
      // Enough for the create phase, not for the phase that adds the DONE line.
      assert.strictEqual(grade(LANGUAGES.javascript, root, 0).passed, true);
      assert.strictEqual(grade(LANGUAGES.javascript, root, 2).passed, false);
    });
  });

  describe('python', () => {
    before(function skipWithoutPython() {
      if (!AVAILABLE.python) this.skip();
    });

    it('passes a program that prints what the task asked for', () => {
      const root = make({ 'main.py': 'print("a")\nprint("b")\nprint("TOTAL: 2")\n' });
      assert.strictEqual(grade(LANGUAGES.python, root, 0).passed, true);
    });

    it('fails a program that raises', () => {
      const root = make({ 'main.py': 'raise SystemExit(1)\n' });
      assert.strictEqual(grade(LANGUAGES.python, root, 0).passed, false);
    });
  });

  describe('java', () => {
    before(function skipWithoutJdk() {
      if (!AVAILABLE.java) this.skip();
    });

    const APP = (body) => `public class TodoApp {\n  public static void main(String[] a) {\n${body}\n  }\n}\n`;

    it('compiles and runs what the model actually wrote', () => {
      const root = make({ 'src/main/java/TodoApp.java': APP('    System.out.println("TOTAL: 2");') });
      assert.strictEqual(grade(LANGUAGES.java, root, 0).passed, true);
    });

    it('fails source that does not compile', () => {
      const root = make({ 'src/main/java/TodoApp.java': 'public class TodoApp { oops }\n' });
      const result = grade(LANGUAGES.java, root, 0);
      assert.strictEqual(result.passed, false);
      assert.match(result.verified.reason, /javac failed/);
    });

    it('does not let a stale build folder pass a source file that no longer compiles', () => {
      // The reason the harness compiles into its own directory. A phase whose source
      // broke must fail even though `build/` still holds a working class from before.
      const root = make({ 'src/main/java/TodoApp.java': APP('    System.out.println("TOTAL: 2");') });
      assert.strictEqual(grade(LANGUAGES.java, root, 0).passed, true);

      fs.mkdirSync(path.join(root, 'build'), { recursive: true });
      fs.copyFileSync(
        path.join(root, '.bench-classes', 'TodoApp.class'),
        path.join(root, 'build', 'TodoApp.class')
      );
      fs.writeFileSync(path.join(root, 'src', 'main', 'java', 'TodoApp.java'), 'public class TodoApp { oops }\n');

      assert.strictEqual(grade(LANGUAGES.java, root, 0).passed, false);
    });

    it('reports no .java files rather than compiling nothing successfully', () => {
      const result = LANGUAGES.java.verify(make({ 'README.md': '# nothing here\n' }));
      assert.strictEqual(result.ok, false);
      assert.match(result.reason, /no \.java files/i);
    });
  });

  describe('findFiles', () => {
    it('lists what the model wrote and skips build output', () => {
      const root = workspaceWith({
        'src/todo.js': '',
        'src/main.js': '',
        'build/Todo.class': '',
        '.hidden/secret': '',
      });
      assert.deepStrictEqual(findFiles(root), ['src/main.js', 'src/todo.js']);
      assert.deepStrictEqual(findFiles(root, '.js'), ['src/main.js', 'src/todo.js']);
      fs.rmSync(root, { recursive: true, force: true });
    });
  });

  describe('argument parsing', () => {
    it('separates the model from its flags', () => {
      const { positional, flags } = parseArgs(['gemma4:e2b', '--machine', 'B', '--lang', 'java,python', '--keep']);
      assert.deepStrictEqual(positional, ['gemma4:e2b']);
      assert.strictEqual(flags.machine, 'B');
      assert.strictEqual(flags.lang, 'java,python');
      assert.strictEqual(flags.keep, true);
    });

    it('treats a flag followed by another flag as a switch', () => {
      const { flags } = parseArgs(['m', '--keep', '--machine', 'C']);
      assert.strictEqual(flags.keep, true);
      assert.strictEqual(flags.machine, 'C');
    });
  });

  describe('result filenames', () => {
    it('makes a model name safe to put in a path', () => {
      // `qwen3.5:4b` would otherwise be a drive letter on Windows and a no-op on Linux.
      assert.strictEqual(slug('qwen3.5:4b'), 'qwen3.5-4b');
      assert.strictEqual(slug('stable-code:latest'), 'stable-code-latest');
      assert.doesNotMatch(slug('a/b\\c:d'), /[/\\:]/);
    });
  });
});
