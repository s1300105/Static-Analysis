import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAP_CHECK_THRESHOLD, type SaContext, importSourcemap, loadArtifact } from '@sa/core';
import { getAnalysisRun } from '../src/db/repo/analysisRun';
import { getArtifactFile, listArtifactFiles } from '../src/db/repo/artifactFile';
import { insertTarget } from '../src/db/repo/target';
import { UP_SEGMENT } from '../src/policy/paths';
import { useContext, useTmpDir } from './helpers';

const makeCtx = useContext();
const tmp = useTmpDir();
const T0 = '2026-10-01T09:00:00Z';
const out = (name: string) => new URL(`./fixtures/webpack5-basic/output/${name}`, import.meta.url).pathname;
const otherBuildMap = new URL('./fixtures/webpack5-basic/other-build/main.57d12ed8.js.map', import.meta.url).pathname;

function load(ctx: SaContext, paths: string[]): { versionId: string; fileIds: string[] } {
  const targetId = insertTarget(ctx, { name: 'example' });
  return loadArtifact(ctx, { targetId, collectedAt: T0, files: paths.map((path) => ({ path })) });
}

async function rejection(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return (err as { code: string } | undefined)?.code ?? 'resolved';
}

describe('importSourcemap', () => {
  it('validates a matching map and builds the original layer, keeping the source structure', async () => {
    const ctx = makeCtx();
    const { versionId, fileIds } = load(ctx, [out('main.037dca38.js'), out('main.037dca38.js.map')]);
    const [jsId, mapId] = fileIds as [string, string];
    // 生成元は sourceMappingURL から見つける
    const r = await importSourcemap(ctx, { versionId, mapFileId: mapId });

    expect(r.generatedFileId).toBe(jsId);
    expect(r.accepted).toBe(true);
    expect(r.mapCheck).toMatchObject({ sampled: 500, threshold: DEFAULT_MAP_CHECK_THRESHOLD, accepted: true });
    expect(r.mapCheck!.rate).toBeGreaterThan(0.9);
    expect(getArtifactFile(ctx, mapId)?.mapCheck).toEqual(r.mapCheck);

    const map = JSON.parse(readFileSync(out('main.037dca38.js.map'), 'utf8')) as { sources: string[]; sourcesContent: string[] };
    const originals = r.originalFileIds.map((id) => getArtifactFile(ctx, id)!);
    expect(originals).toHaveLength(map.sources.length);
    const mapFile = getArtifactFile(ctx, mapId)!;
    for (const o of originals) {
      expect(o).toMatchObject({ layer: 'original', parentFileId: jsId, positionMapHash: mapFile.contentHash });
      expect(o.path.startsWith(`${versionId}/original/${mapId}/sa-fixture-webpack5/`)).toBe(true);
      const i = map.sources.indexOf(o.origName!);
      expect(ctx.store.get(o.contentHash).toString('utf8')).toBe(map.sourcesContent[i]);
    }
    expect(originals.map((o) => o.path)).toContain(`${versionId}/original/${mapId}/sa-fixture-webpack5/src/render.js`);
    expect(getAnalysisRun(ctx, r.runId!)).toMatchObject({ kind: 'ingest', tool: 'import_sourcemap', filesSkipped: 0 });
  });

  it('marks node_modules sources as vendored', async () => {
    const ctx = makeCtx();
    const { versionId, fileIds } = load(ctx, [out('949.d486fd40.js'), out('949.d486fd40.js.map')]);
    const r = await importSourcemap(ctx, { versionId, mapFileId: fileIds[1]! });
    expect(r.originalFileIds.map((id) => getArtifactFile(ctx, id))).toEqual([
      expect.objectContaining({
        origName: 'webpack://sa-fixture-webpack5/./node_modules/tiny-escape/index.js',
        ownership: 'vendored_lib',
      }),
    ]);
  });

  it('rejects a map from a different build: records map_check and builds no original layer', async () => {
    const ctx = makeCtx();
    const { versionId, fileIds } = load(ctx, [out('main.037dca38.js'), otherBuildMap]);
    const r = await importSourcemap(ctx, { versionId, mapFileId: fileIds[1]!, generatedFileId: fileIds[0]! });
    expect(r.accepted).toBe(false);
    expect(r.originalFileIds).toEqual([]);
    expect(r.mapCheck!.rate).toBeLessThan(0.3);
    expect(getArtifactFile(ctx, fileIds[1]!)?.mapCheck).toMatchObject({ accepted: false });
    expect(listArtifactFiles(ctx, { versionId, layer: 'original' })).toEqual([]);
  });

  it('is idempotent', async () => {
    const ctx = makeCtx();
    const { versionId, fileIds } = load(ctx, [out('lazy.ce3f5b37.js'), out('lazy.ce3f5b37.js.map')]);
    const first = await importSourcemap(ctx, { versionId, mapFileId: fileIds[1]! });
    const again = await importSourcemap(ctx, { versionId, mapFileId: fileIds[1]! });
    expect(first.accepted).toBe(true);
    expect(again).toMatchObject({ accepted: true, originalFileIds: first.originalFileIds });
    expect(again.runId).toBeUndefined();
    expect(listArtifactFiles(ctx, { versionId, layer: 'original' })).toHaveLength(first.originalFileIds.length);
  });

  it('skips sources it cannot place, and keeps differing sources that normalise to the same path apart', async () => {
    const ctx = makeCtx();
    const map = JSON.parse(readFileSync(out('main.037dca38.js.map'), 'utf8')) as {
      sources: string[];
      sourcesContent: (string | null)[];
    };
    const idx = (suffix: string) => map.sources.findIndex((s) => s.endsWith(suffix));
    // 小さいランタイムの sources を書き換える（names の検査にはほとんど効かない）
    map.sourcesContent[idx('hasOwnProperty shorthand')] = null;
    map.sources[idx('webpack/runtime/global')] = '..';
    map.sources[idx('webpack/runtime/publicPath')] = 'webpack:///./src/App.vue?vue&type=script';
    map.sources[idx('get javascript chunk filename')] = 'webpack:///./src/App.vue?vue&type=template';
    map.sources[idx('define property getters')] = 'webpack:///../../../etc/passwd';
    const dir = tmp();
    writeFileSync(join(dir, 'main.037dca38.js.map'), JSON.stringify(map));

    const { versionId, fileIds } = load(ctx, [out('main.037dca38.js'), join(dir, 'main.037dca38.js.map')]);
    const mapId = fileIds[1]!;
    const r = await importSourcemap(ctx, { versionId, mapFileId: mapId });
    expect(r.accepted).toBe(true);

    const paths = r.originalFileIds.map((id) => getArtifactFile(ctx, id)!.path.slice(`${versionId}/original/${mapId}/`.length));
    expect(paths).toEqual(
      expect.arrayContaining(['src/App.vue', 'src/App~2.vue', `${UP_SEGMENT}/${UP_SEGMENT}/${UP_SEGMENT}/etc/passwd`]),
    );
    expect(paths).toHaveLength(map.sources.length - 2);
    expect(getAnalysisRun(ctx, r.runId!)?.skippedDetail).toEqual({
      path_excluded: { count: 1, items: [{ ref: '..', detail: expect.stringContaining('usable file path') }] },
      no_source_content: {
        count: 1,
        items: [{ ref: 'webpack://sa-fixture-webpack5/webpack/runtime/hasOwnProperty shorthand' }],
      },
    });
  });

  it('records an unreadable map as parse_failed', async () => {
    const ctx = makeCtx();
    const dir = tmp();
    writeFileSync(join(dir, 'lazy.ce3f5b37.js.map'), '{"version":3,"sections":[]}');
    const { versionId, fileIds } = load(ctx, [out('lazy.ce3f5b37.js'), join(dir, 'lazy.ce3f5b37.js.map')]);
    const r = await importSourcemap(ctx, { versionId, mapFileId: fileIds[1]! });
    expect(r).toMatchObject({ accepted: false, mapCheck: null, originalFileIds: [] });
    expect(getArtifactFile(ctx, fileIds[1]!)?.parseStatus).toBe('parse_failed');
    expect(getAnalysisRun(ctx, r.runId!)?.skippedDetail?.parse_failed?.items[0]?.detail).toContain('sections');
  });

  it('asks for the generated file when it cannot be determined', async () => {
    const ctx = makeCtx();
    // other-build の map 名（main.57d12ed8.js.map）を参照する JS も、同じ名前の JS も無い
    const { versionId, fileIds } = load(ctx, [out('main.037dca38.js'), out('lazy.ce3f5b37.js'), otherBuildMap]);
    expect(await rejection(importSourcemap(ctx, { versionId, mapFileId: fileIds[2]! }))).toBe('INVALID_INPUT');
  });

  it('validates its arguments', async () => {
    const ctx = makeCtx();
    const { versionId, fileIds } = load(ctx, [out('lazy.ce3f5b37.js'), out('lazy.ce3f5b37.js.map')]);
    const [jsId, mapId] = fileIds as [string, string];
    expect(await rejection(importSourcemap(ctx, { versionId: 'missing', mapFileId: mapId }))).toBe('NOT_FOUND');
    expect(await rejection(importSourcemap(ctx, { versionId, mapFileId: 'missing' }))).toBe('NOT_FOUND');
    expect(await rejection(importSourcemap(ctx, { versionId, mapFileId: jsId }))).toBe('INVALID_INPUT');
    expect(await rejection(importSourcemap(ctx, { versionId, mapFileId: mapId, generatedFileId: mapId }))).toBe('INVALID_INPUT');
  });
});
