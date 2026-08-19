'use strict';

/**
 * Working out what the written code imports and the project does not have.
 *
 * Written from the failure that produced it: a run that scaffolded, installed, and wrote
 * twelve of thirteen files, then failed to build with `Cannot find module 'tailwindcss'`
 * because the model wrote a correct `postcss.config.js` naming it and never installed it.
 */

const assert = require('assert');

const missingDeps = require('../../app/core/missingDeps');

describe('missingDeps.packageOf', () => {
  it('takes the package out of a deep import', () => {
    assert.strictEqual(missingDeps.packageOf('react-dom/client'), 'react-dom');
    assert.strictEqual(missingDeps.packageOf('lucide-react'), 'lucide-react');
  });

  it('keeps a scoped package whole', () => {
    assert.strictEqual(missingDeps.packageOf('@tailwindcss/postcss'), '@tailwindcss/postcss');
  });

  it('is not fooled by a relative import, a builtin, or a url', () => {
    assert.strictEqual(missingDeps.packageOf('./TodoItem.jsx'), '');
    assert.strictEqual(missingDeps.packageOf('../hooks/useTodos'), '');
    assert.strictEqual(missingDeps.packageOf('fs'), '');
    assert.strictEqual(missingDeps.packageOf('node:path'), '');
    assert.strictEqual(missingDeps.packageOf('https://esm.sh/react'), '');
  });
});

describe('missingDeps.packagesIn', () => {
  it('reads imports and requires', () => {
    const source = [
      "import { useState } from 'react';",
      "import Todo from './TodoItem.jsx';",
      "import { Trash } from 'lucide-react';",
      "const clsx = require('clsx');",
      "export { default } from 'zustand';",
    ].join('\n');
    const found = missingDeps.packagesIn('src/App.jsx', source).sort();
    assert.deepStrictEqual(found, ['clsx', 'lucide-react', 'react', 'zustand']);
  });

  it('reads plugin names out of a postcss config, which are keys and not imports', () => {
    // The exact file from the failing run.
    const source = 'export default {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n}';
    const found = missingDeps.packagesIn('postcss.config.js', source).sort();
    assert.deepStrictEqual(found, ['autoprefixer', 'tailwindcss']);
  });

  it('does not mistake a tailwind config’s settings for packages', () => {
    const source = "export default {\n  darkMode: 'class',\n  theme: { extend: {} },\n  plugins: [],\n}";
    assert.deepStrictEqual(missingDeps.packagesIn('tailwind.config.js', source), []);
  });

  it('does not read plugin-shaped keys out of ordinary source', () => {
    // In a component, a quoted word that looks like a package name is a class or an id.
    const source = "const styles = { plugins: { 'my-widget': {} } };\nexport default styles;";
    assert.deepStrictEqual(missingDeps.packagesIn('src/styles.js', source), []);
  });
});

describe('missingDeps.missing', () => {
  const manifest = JSON.stringify({
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
    devDependencies: { vite: '^8.0.0' },
  });

  it('names what is imported and not declared', () => {
    const files = [
      { path: 'src/App.jsx', source: "import { useState } from 'react';\nimport { Trash } from 'lucide-react';" },
      { path: 'postcss.config.js', source: 'export default { plugins: { tailwindcss: {} } }' },
    ];
    assert.deepStrictEqual(missingDeps.missing({ files, manifest }), ['lucide-react', 'tailwindcss']);
  });

  it('says nothing when everything is declared', () => {
    const files = [{ path: 'src/main.jsx', source: "import { createRoot } from 'react-dom/client';" }];
    assert.deepStrictEqual(missingDeps.missing({ files, manifest }), []);
  });

  it('survives a manifest that will not parse', () => {
    // A broken package.json is a different problem and not this one's to solve — but it
    // must not throw in the middle of a run.
    const files = [{ path: 'src/App.jsx', source: "import x from 'left-pad';" }];
    assert.deepStrictEqual(missingDeps.missing({ files, manifest: '{ not json' }), ['left-pad']);
  });

  it('says nothing when nothing was written', () => {
    assert.deepStrictEqual(missingDeps.missing({ files: [], manifest }), []);
  });
});
