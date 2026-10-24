import { defineConfig } from 'tsup';

// worker のエントリは dist/workers/<name>.js に出す（src/jobs/workers/index.ts の workerUrl() がここを探す）
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'workers/unpack': 'src/jobs/workers/unpack.worker.ts',
    'workers/sourcemap': 'src/jobs/workers/sourcemap.worker.ts',
  },
  format: ['esm'],
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  // 移行 SQL は文字列として埋め込む（vitest は vitest.config.ts のプラグインで同じことをする）
  loader: { '.sql': 'text' },
});
