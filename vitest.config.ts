import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcAlias = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sa/types': srcAlias('types'),
      '@sa/core': srcAlias('core'),
      '@sa/cli': srcAlias('cli'),
      '@sa/mcp': srcAlias('mcp'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
