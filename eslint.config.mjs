// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'newman/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The workflow sandbox must stay deterministic: no Node built-ins, no I/O.
    files: ['src/domain/selectBestOffers.ts', 'src/temporal/workflows/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'http', 'https', 'crypto', 'os', 'path'],
              message: 'Not allowed in deterministic code.',
            },
            { group: ['**/infra/*', 'ioredis', 'pino*'], message: 'No I/O in deterministic code.' },
          ],
        },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Non-deterministic.' },
        { object: 'Date', property: 'now', message: 'Non-deterministic.' },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'scripts/**/*.{ts,mjs}'],
    rules: { '@typescript-eslint/explicit-module-boundary-types': 'off' },
  },
  {
    files: ['scripts/**/*.{ts,mjs}'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
