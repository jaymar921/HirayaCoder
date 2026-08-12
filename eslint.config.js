'use strict';

/**
 * ESLint flat config.
 *
 * `PROMPT.md` section 3 lists `.eslintrc.json`, but ESLint 9 — what installs on
 * Node 20+/npm 11 — uses flat config and ignores `.eslintrc.*` unless run in a
 * compatibility mode. Pinning ESLint 8 purely to match a filename would ship the
 * project on an unmaintained major, so the format changed and the rule intent
 * (security + no-unsanitized, enforced across `/app`) is preserved exactly.
 */

const security = require('eslint-plugin-security');
const noUnsanitized = require('eslint-plugin-no-unsanitized');

module.exports = [
  {
    ignores: ['node_modules/**', 'out/**', 'dist/**', 'builds/**', '.vscode-test/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
      },
    },
    plugins: {
      security,
      'no-unsanitized': noUnsanitized,
    },
    rules: {
      ...security.configs.recommended.rules,
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',

      // Hard bans backing the security requirements in PROMPT.md section 15.
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // General hygiene.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-undef': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
    },
  },
  {
    // The webview is a different runtime entirely: ES modules in a browser, with no
    // Node globals and no `require`. Linting it as CommonJS reported every `import`
    // as a parse error and hid whatever real problems were behind them.
    files: ['app/webview/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        HTMLElement: 'readonly',
        DocumentFragment: 'readonly',
        // Injected by VS Code into the webview.
        acquireVsCodeApi: 'readonly',
      },
    },
    rules: {
      // The whole point of `markdown.js` is that model text never becomes markup;
      // these rules are the mechanical check that it stays that way.
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
    },
  },
  {
    // Test files run under mocha and legitimately reach for dynamic paths.
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        before: 'readonly',
        after: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
      },
    },
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-object-injection': 'off',
    },
  },
];
