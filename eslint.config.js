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
      // テスト用のバンドラ出力（minify 済み）とその入力（ブラウザ向け）
      'packages/*/test/fixtures/*/build/**',
      'packages/*/test/fixtures/*/output/**',
      'packages/*/test/fixtures/*/output-*/**',
      'packages/*/test/fixtures/*/other-build/**',
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
    // テスト用の worker モジュールとスクリプト（ビルドせず Node がそのまま読む素の ESM）
    files: ['packages/*/test/fixtures/**/*.mjs', 'packages/*/scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', setTimeout: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
);
