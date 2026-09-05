import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/.build/**',
      '**/.tsbuild/**',
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/target/**',
      '.build/**',
      '**/.vite/**',
      'libs/**',
      'runtime/**',
      'vendor/**',
      'packages/excalidraw-plan/**',
      'photolab/260217_MUC_Alte_Akademie/**',
      'packages/@himmelcad/data/src/generated/**',
    ],
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.stylistic,
  {
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      import: importPlugin,
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/consistent-generic-constructors': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-control-regex': 'off',
      // Prettier owns layout. Import ordering generated thousands of unrelated
      // diagnostics in the pre-existing monorepo without finding defects.
      'import/order': 'off',
    },
    settings: {
      react: { version: '19' },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}', '**/*.config.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/prefer-for-of': 'off',
      'no-undef': 'off',
    },
  },
  {
    files: ['**/test/**', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['scripts/verification/*.mjs'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // The verifier is a dependency-free Node boundary over Git, package JSON
      // and child-process results. Its own contract tests validate these values.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
    },
  },
);
