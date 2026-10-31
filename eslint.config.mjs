import js from '@eslint/js';
import globals from 'globals';

const ignores = {
  ignores: ['test/', 'app/', 'portal/', 'src/db/updates/', 'src/vm/bundles/', 'node_modules/'],
};

// @formio/eslint-config is resolved from the Form.io monorepo and is not published to npm.
// Where it is present (the monorepo) it is the config; where it is not (a standalone clone
// of this repo) lint falls back to ESLint's recommended rules so `npm run lint` and the
// pre-commit hook still check the tree.
let formioConfigs;
try {
  const [{ config }, { config: loggingConfig }] = await Promise.all([
    import('@formio/eslint-config/base'),
    import('@formio/eslint-config/logging'),
  ]);
  formioConfigs = [...config, ...loggingConfig];
} catch (err) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') {
    throw err;
  }
  formioConfigs = [
    js.configs.recommended,
    {
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'commonjs',
        globals: { ...globals.node },
      },
      // `lint` runs with --fix, which would strip the formio/* directives as unused.
      linterOptions: { reportUnusedDisableDirectives: 'off' },
      // Stub rules so the tree's `eslint-disable formio/...` comments still resolve.
      plugins: { formio: { rules: { 'no-debug-package': { create: () => ({}) } } } },
      rules: {
        'no-prototype-builtins': 'off',
        'no-unused-vars': [
          'error',
          { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' },
        ],
      },
    },
    {
      files: ['**/*.mjs'],
      languageOptions: { sourceType: 'module' },
    },
  ];
}

/** @type {import("eslint").Linter.Config} */
export default [ignores, ...formioConfigs];
