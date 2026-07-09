import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Flat ESLint config. The two async-safety rules below are enforced as ERRORS
// (plan 010 introduced them as warnings; plan 020 burned the warnings down to
// zero and flipped them). `npm run lint` runs with --max-warnings 0, so CI
// fails on any new floating promise or misused-promise callback. The broader
// recommended / recommendedTypeChecked noise stays silenced so these two
// rules remain the signal.
export default tseslint.config(
  {
    // These globs target the BUILT copies emitted at the repo root by Vite
    // (see package.json "clean"). Source lives under src/ and is NOT ignored.
    ignores: [
      'dist/',
      'node_modules/',
      'content.js',
      'service-worker.js',
      'interceptor.js',
      'assets/',
      'chunks/',
      'sidepanel/',
      'editor/',
      'objectview/',
      'diff/',
      'codesearch/',
      'studio/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // Don't flag the pre-existing `eslint-disable no-console` directives in the
    // source as unused just because this pass doesn't enable no-console. Keeps
    // the warning output to the two async rules only.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The two rules this pass is about — enforced as ERROR (plan 020).
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Everything else off/quiet this pass. These are the recommended /
      // recommendedTypeChecked rules that fire on the existing 43K-LOC source;
      // silencing them keeps the two async rules as the only signal and lets
      // ESLint land without a big cleanup. Ratchet path: re-enable (as 'error')
      // rule-by-rule after triage, then run with --max-warnings 0.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      'prefer-const': 'off',
      'no-irregular-whitespace': 'off',
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  },
);
