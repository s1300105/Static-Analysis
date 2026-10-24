import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'coverage/**',
      '*.config.ts',
      '*.config.js',
      '*.config.cjs',
      'eslint.config.js',
      '.dependency-cruiser.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // テスト用の worker モジュール（ビルドせず Node がそのまま読む素の ESM）
    files: ['packages/*/test/fixtures/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', setTimeout: 'readonly' } },
  },
);
