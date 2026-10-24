import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourcemapWorker, unpackWorker } from '../src/jobs/workers';

const dir = new URL('../src/jobs/workers/', import.meta.url);

describe('worker modules', () => {
  // src（Node の型除去）と dist（tsup）の両方で同じように読めるための規約（src/jobs/workers/index.ts）
  it('import at runtime only packages and sibling worker modules with an explicit .ts extension', () => {
    // index.ts（sa-core の側で worker を登録する）以外はすべて worker の中で読まれる
    const files = readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'index.ts');
    expect(files).toEqual(expect.arrayContaining(['bindings.ts', 'endpoints.worker.ts', 'shared.ts']));
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      const bad = [...src.matchAll(/^import\s+(?!type\b)[^;]*from\s+['"](\.[^'"]*)['"]/gm)]
        .map((m) => m[1]!)
        .filter((spec) => !/^\.\/[\w.-]+\.ts$/.test(spec) || spec === './index.ts');
      expect({ file: f, bad }).toEqual({ file: f, bad: [] });
    }
  });

  it('resolve to the TypeScript sources when not built', () => {
    for (const w of [unpackWorker, sourcemapWorker]) {
      expect(w.url.pathname.endsWith(`/src/jobs/workers/${w.name}.worker.ts`)).toBe(true);
      expect(existsSync(fileURLToPath(w.url))).toBe(true);
    }
  });
});
