import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { type SaContext, loadArtifact, unpackBundle } from '@sa/core';
import { getAnalysisRun } from '../src/db/repo/analysisRun';
import { getArtifactFile, listArtifactFiles } from '../src/db/repo/artifactFile';
import { insertTarget } from '../src/db/repo/target';
import { DEFAULT_WORKER_LIMITS } from '../src/jobs/runner';
import { useContext, useTmpDir } from './helpers';

const makeCtx = useContext();
const tmp = useTmpDir();
const T0 = '2026-10-01T09:00:00Z';
const fixtureDir = new URL('./fixtures/webpack5-basic/', import.meta.url).pathname;
const expected = JSON.parse(readFileSync(join(fixtureDir, 'expected.json'), 'utf8')) as {
  chunks: Record<string, { chunkIds: string[]; modules: string[] }>;
};

function load(ctx: SaContext, paths: string[]): { versionId: string; fileIds: string[] } {
  const targetId = insertTarget(ctx, { name: 'example' });
  return loadArtifact(ctx, { targetId, collectedAt: T0, files: paths.map((path) => ({ path })) });
}

/** dir に name で中身を書いてパスを返す */
function writeFixture(dir: string, name: string, content: string | Uint8Array): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

/**
 * unpacked 層の往復テスト（計画書 M1 の完了条件）。各 unpacked の全トークンについて、
 * raw_offset を足した raw のバイト範囲が同じトークンの文字列になることを確かめる。
 * 文字位置 → バイト位置の変換は worker とは別の素朴な方法（先頭からの Buffer.byteLength）で行う。
 */
function assertUnpackedRoundTrip(ctx: SaContext, versionId: string): number {
  let tokens = 0;
  for (const u of listArtifactFiles(ctx, { versionId, layer: 'unpacked' })) {
    const raw = getArtifactFile(ctx, u.parentFileId!)!;
    expect(raw.layer).toBe('raw');
    const rawBytes = ctx.store.get(raw.contentHash);
    const bytes = ctx.store.get(u.contentHash);
    const offset = u.rawOffset!;
    expect(Buffer.compare(rawBytes.subarray(offset, offset + bytes.byteLength), bytes)).toBe(0);

    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const ast = parse(text, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, tokens: true });
    for (const t of ast.tokens as { start: number; end: number }[]) {
      if (t.end === t.start) continue; // EOF
      const start = offset + Buffer.byteLength(text.slice(0, t.start));
      const end = offset + Buffer.byteLength(text.slice(0, t.end));
      expect(rawBytes.subarray(start, end).toString('utf8')).toBe(text.slice(t.start, t.end));
      tokens++;
    }
  }
  return tokens;
}

describe('unpackBundle: webpack 5 production', () => {
  async function unpackFixture() {
    const ctx = makeCtx();
    const files = readdirSync(join(fixtureDir, 'output')).filter((f) => f.endsWith('.js'));
    const { versionId } = load(
      ctx,
      files.map((f) => join(fixtureDir, 'output', f)),
    );
    const result = await unpackBundle(ctx, { versionId });
    return { ctx, versionId, result };
  }

  it('finds the module factories of the runtime chunk and of pushed chunks', async () => {
    const { ctx, versionId, result } = await unpackFixture();
    expect(result).toMatchObject({ files: 3, moduleCount: 4, bundlers: { webpack: 3 }, noBoundaryCount: 0, skipped: 0 });

    for (const raw of listArtifactFiles(ctx, { versionId, layer: 'raw' })) {
      const exp = expected.chunks[raw.origName!]!;
      expect(raw.bundler).toBe('webpack');
      const modules = listArtifactFiles(ctx, { versionId, layer: 'unpacked', parentFileId: raw.id });
      expect(modules.map((m) => m.origName).sort()).toEqual(exp.modules);
      for (const m of modules) {
        expect(m).toMatchObject({ kind: 'js', path: `${versionId}/unpacked/${m.id}.js`, ownership: 'unknown' });
      }
      // ランタイムのチャンク（main）は push を持たないので chunk_key は埋まらない
      expect(raw.chunkKey).toBe(raw.origName!.startsWith('main.') ? null : exp.chunkIds.join(','));
    }
  });

  it('round-trips every token of every unpacked module back to raw bytes', async () => {
    const { ctx, versionId } = await unpackFixture();
    expect(assertUnpackedRoundTrip(ctx, versionId)).toBeGreaterThan(100);
  });

  it('records the run', async () => {
    const { ctx, result } = await unpackFixture();
    expect(getAnalysisRun(ctx, result.runId)).toMatchObject({
      kind: 'engine',
      tool: 'unpack_bundle',
      inputLayer: 'raw',
      filesTotal: 3,
      filesAnalyzed: 3,
      filesSkipped: 0,
      skippedDetail: {},
      toolVersion: expect.stringContaining('@babel/parser 8.'),
    });
  });

  it('is idempotent: files already unpacked are not processed again', async () => {
    const { ctx, versionId } = await unpackFixture();
    const before = listArtifactFiles(ctx, { versionId, layer: 'unpacked' }).length;
    expect(await unpackBundle(ctx, { versionId })).toMatchObject({ files: 0, moduleCount: 0 });
    expect(listArtifactFiles(ctx, { versionId, layer: 'unpacked' })).toHaveLength(before);
  });
});

describe('unpackBundle: byte offsets', () => {
  it('maps character positions to bytes across a BOM, 2/3-byte characters and surrogate pairs', async () => {
    const ctx = makeCtx();
    const chunk =
      '(self.webpackChunkt=self.webpackChunkt||[]).push([["a"],{"./src/a.js":function(e,t,n){var s="😀é ✓";e.exports=s},' +
      '7:e=>{e.exports="終わり😀"},"x-y":(e,t)=>t.z="ü"}]);\n';
    const path = writeFixture(tmp(), 'chunk.js', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(chunk)]));
    const { versionId, fileIds } = load(ctx, [path]);
    expect(await unpackBundle(ctx, { versionId })).toMatchObject({ moduleCount: 3, bundlers: { webpack: 1 } });

    const modules = listArtifactFiles(ctx, { versionId, layer: 'unpacked' });
    const text = (id: string) => ctx.store.get(getArtifactFile(ctx, id)!.contentHash).toString('utf8');
    expect(Object.fromEntries(modules.map((m) => [m.origName, text(m.id)]))).toEqual({
      './src/a.js': 'var s="😀é ✓";e.exports=s',
      '7': 'e.exports="終わり😀"',
      'x-y': 't.z="ü"',
    });
    expect(getArtifactFile(ctx, fileIds[0]!)?.chunkKey).toBe('a');
    expect(assertUnpackedRoundTrip(ctx, versionId)).toBeGreaterThan(10);
  });
});

describe('unpackBundle: other formats and failures', () => {
  it('keeps an ESM chunk and an unrecognised script whole, recording the latter', async () => {
    const ctx = makeCtx();
    const dir = tmp();
    const esm = writeFixture(dir, 'esm.js', 'import{a as b}from"./x.js";export const c=b+1;\n');
    const plain = writeFixture(dir, 'plain.js', 'var x = 1;\nfunction f() { return x; }\n');
    const { versionId, fileIds } = load(ctx, [esm, plain]);
    const result = await unpackBundle(ctx, { versionId });
    expect(result).toMatchObject({ files: 2, moduleCount: 2, bundlers: { esm: 1, unknown: 1 }, noBoundaryCount: 1, skipped: 0 });

    for (const id of fileIds) {
      const raw = getArtifactFile(ctx, id)!;
      const [whole] = listArtifactFiles(ctx, { versionId, layer: 'unpacked', parentFileId: id });
      expect(whole).toMatchObject({ rawOffset: 0, contentHash: raw.contentHash, origName: null });
    }
    // 境界が見つからなかったファイルは記録するが、unpacked は作ったのでスキップには数えない
    expect(getAnalysisRun(ctx, result.runId)).toMatchObject({
      filesSkipped: 0,
      skippedDetail: { no_module_boundary: { count: 1, items: [{ ref: fileIds[1] }] } },
    });
  });

  it('leaves only the raw layer for files that fail to parse and counts them as skipped', async () => {
    const ctx = makeCtx();
    const dir = tmp();
    const broken = writeFixture(dir, 'broken.js', 'function (\n');
    const latin1 = writeFixture(dir, 'latin1.js', Buffer.from([0x76, 0x61, 0x72, 0x20, 0x73, 0x3d, 0x22, 0xe9, 0x22, 0x3b]));
    const ok = join(fixtureDir, 'output', 'lazy.ce3f5b37.js');
    const { versionId, fileIds } = load(ctx, [broken, latin1, ok]);
    const result = await unpackBundle(ctx, { versionId });
    expect(result).toMatchObject({ files: 3, skipped: 2, moduleCount: 1 });

    for (const id of fileIds.slice(0, 2)) {
      expect(getArtifactFile(ctx, id)).toMatchObject({ parseStatus: 'parse_failed', bundler: null });
      expect(listArtifactFiles(ctx, { versionId, layer: 'unpacked', parentFileId: id })).toEqual([]);
    }
    const run = getAnalysisRun(ctx, result.runId);
    expect(run).toMatchObject({ filesTotal: 3, filesAnalyzed: 1, filesSkipped: 2 });
    expect(run?.skippedDetail?.parse_failed?.items).toEqual([
      { fileId: fileIds[0], detail: expect.stringContaining('unpack: Unexpected token') },
      { fileId: fileIds[1], detail: 'unpack: not valid UTF-8' },
    ]);
    // 失敗したファイルは次の実行では掛け直さない
    expect(await unpackBundle(ctx, { versionId })).toMatchObject({ files: 0 });
  });

  it('marks timeouts and retries them on request', async () => {
    const tight = makeCtx({ workerLimits: { ...DEFAULT_WORKER_LIMITS, timeoutMs: 1 } });
    const { versionId, fileIds } = load(tight, [join(fixtureDir, 'output', 'lazy.ce3f5b37.js')]);
    expect(await unpackBundle(tight, { versionId })).toMatchObject({ skipped: 1 });
    expect(getArtifactFile(tight, fileIds[0]!)?.parseStatus).toBe('timeout');

    const relaxed = { ...tight, config: { ...tight.config, workerLimits: DEFAULT_WORKER_LIMITS } };
    expect(await unpackBundle(relaxed, { versionId })).toMatchObject({ files: 0 });
    expect(await unpackBundle(relaxed, { versionId, retryFailed: true })).toMatchObject({ files: 1, skipped: 0, moduleCount: 1 });
    expect(getArtifactFile(tight, fileIds[0]!)?.parseStatus).toBe('ok');
  });

  it('only unpacks JS files', async () => {
    const ctx = makeCtx();
    const { versionId } = load(ctx, [join(fixtureDir, 'output', 'lazy.ce3f5b37.js.map')]);
    expect(await unpackBundle(ctx, { versionId })).toMatchObject({ files: 0 });
  });

  it('rejects an unknown version', async () => {
    const err = await unpackBundle(makeCtx(), { versionId: 'missing' }).catch((e: unknown) => e);
    expect((err as { code: string }).code).toBe('NOT_FOUND');
  });
});
