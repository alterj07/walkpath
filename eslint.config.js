import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.astro/**', '**/out/**', '**/state/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-eval': 'error',
      'no-implied-eval': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['**/*.tsx'],
    plugins: { react },
    rules: {
      // The single documented exception is the sanitized job description (see docs/security.md).
      'react/no-danger': 'error',
    },
  },
);
