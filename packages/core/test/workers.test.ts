import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourcemapWorker, unpackWorker } from '../src/jobs/workers';

const dir = new URL('../src/jobs/workers/', import.meta.url);

describe('worker modules', () => {
  // src（Node の型除去）と dist（tsup）の両方で同じように読めるための規約（src/jobs/workers/index.ts）
  it('import only packages at runtime (relative imports must be type-only)', () => {
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.worker.ts'))) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      const runtimeRelative = [...src.matchAll(/^import\s+(?!type\b)[^;]*from\s+['"](\.[^'"]*)['"]/gm)].map((m) => m[1]);
      expect({ file: f, runtimeRelative }).toEqual({ file: f, runtimeRelative: [] });
    }
  });

  it('resolve to the TypeScript sources when not built', () => {
    for (const w of [unpackWorker, sourcemapWorker]) {
      expect(w.url.pathname.endsWith(`/src/jobs/workers/${w.name}.worker.ts`)).toBe(true);
      expect(existsSync(fileURLToPath(w.url))).toBe(true);
    }
  });
});
