import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcAlias = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [
    {
      // 移行 SQL を文字列として import する（ビルドでは tsup の --loader .sql=text が同じことをする）
      name: 'sql-as-text',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('.sql')) return null;
        return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
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
