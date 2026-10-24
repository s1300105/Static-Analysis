import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ExpectedChunk,
  type SaContext,
  createTarget,
  findMissingChunks,
  loadArtifact,
  markChunkUnavailable,
  unpackBundle,
} from '@sa/core';
import type { LoadArtifactFile } from '@sa/types';
import { getAnalysisRun } from '../src/db/repo/analysisRun';
import { listExpectedChunks } from '../src/db/repo/expectedChunk';
import collectChunkRefs from '../src/jobs/workers/chunks.worker';
import { useContext } from './helpers';

const makeCtx = useContext();
const chunksDir = new URL('./fixtures/webpack5-chunks/output/', import.meta.url).pathname;
const basicDir = new URL('./fixtures/webpack5-basic/output/', import.meta.url).pathname;
const CDN = 'https://cdn.example.com/assets/';

function refs(code: string) {
  const r = collectChunkRefs({ bytes: Buffer.from(code) });
  return {
    templates: r.templates.map((t) => ({ parts: t.parts, publicPath: t.publicPath })),
    chunkIds: r.chunkIds.map((c) => `${c.via}:${c.id}`),
    refs: r.refs.map((x) => `${x.kind}:${x.value}`),
  };
}

describe('chunk references in the worker', () => {
  it('reads the webpack 5 filename template and public path of the same runtime object', () => {
    expect(
      refs(`
        r.u = e => (({1: "admin"}[e] || e) + "." + {1: "aa11", 2: "bb22"}[e] + ".js");
        r.p = "/static/";
        q.p = "/other/";
      `).templates,
    ).toEqual([
      {
        parts: [{ map: { 1: 'admin' }, fallbackToId: true }, { lit: '.' }, { map: { 1: 'aa11', 2: 'bb22' }, fallbackToId: false }, { lit: '.js' }],
        publicPath: '/static/',
      },
    ]);
    expect(refs('n.u = function (e) { return "js/" + e + `.${{7: "cc"}[e]}.chunk.js` }; n.p = s()').templates).toEqual([
      { parts: [{ lit: 'js/' }, { id: true }, { lit: '.' }, { map: { 7: 'cc' }, fallbackToId: false }, { lit: '.chunk.js' }], publicPath: null },
    ]);
    // 組み立て方でないもの
    expect(refs('x.u = e => e.toUpperCase(); y.u = (a, b) => a + b; z.u = 5;').templates).toEqual([]);
  });

  it('reads chunk ids from X.e(id) and startup dependencies, but not from variables', () => {
    expect(refs('n.e(12).then(n.bind(n, 3)); n.e("admin"); n.e(t); a.O(void 0, [949, "vendors"], () => a(1)); a.O(x, [5]);').chunkIds).toEqual([
      'async:12',
      'async:admin',
      'startup:949',
      'startup:vendors',
    ]);
  });

  it('reads dynamic imports, code URLs and the sourcemap / license comments', () => {
    // vitest（vite）がテストのソースから sourceMappingURL の行を消すので、組み立てて渡す
    const mapComment = (url: string) => `//${'#'} sourceMappingURL=${url}`;
    expect(
      refs(`/*! For license information please see app.js.LICENSE.txt */
        import("./lazy.js"); import(dynamicName);
        new URL("./worker.mjs", import.meta.url); new URL("./logo.png", import.meta.url); new URL("./x.js", base);
        ${mapComment('app.js.map')}
        ${mapComment('data:application/json;base64,e30=')}
      `).refs,
    ).toEqual(['license:app.js.LICENSE.txt', 'import:./lazy.js', 'url:./worker.mjs', 'sourcemap:app.js.map']);
  });
});

async function load(ctx: SaContext, targetId: string, files: LoadArtifactFile[], versionId?: string): Promise<string> {
  const r = loadArtifact(ctx, { targetId, files, ...(versionId ? { versionId } : { collectedAt: '2026-10-01T00:00:00Z' }) });
  await unpackBundle(ctx, { versionId: r.versionId });
  return r.versionId;
}

const cdnFile = (name: string): LoadArtifactFile => ({
  path: join(chunksDir, name),
  sourceUrls: [`${CDN}${name}`],
  loadedByOrigins: ['https://app.example.com'],
});

function brief(chunks: ExpectedChunk[]): string[] {
  return chunks.map((c) => `${c.status} ${c.kind} ${c.chunkKey}${c.url && c.url !== c.chunkKey ? ` ${c.url}` : ''} ${c.hostInScope}`);
}

describe('findMissingChunks', () => {
  it('lists the chunks, sourcemap, license and imports a runtime refers to, with URLs from its public path', async () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example', scope: { allowed_domains: ['cdn.example.com', 'app.example.com'] } });
    const versionId = await load(ctx, targetId, [cdnFile('main.f21b19c3.js')]);
    const r = await findMissingChunks(ctx, { versionId });
    expect(brief(r.chunks)).toEqual([
      `missing chunk 472 ${CDN}settings.f61ce08e.chunk.js true`,
      `missing chunk 867 ${CDN}867.75f286be.chunk.js true`,
      `missing chunk 884 ${CDN}admin.3be16cd6.chunk.js true`,
      'missing import https://widgets.thirdparty.example/w.js false',
      `missing sourcemap ${CDN}main.f21b19c3.js.map true`,
      `missing license ${CDN}main.f21b19c3.js.LICENSE.txt true`,
    ]);
    expect(r).toMatchObject({ missing: 6, skipped: 0 });
    expect(getAnalysisRun(ctx, r.runId)).toMatchObject({ tool: 'find_missing_chunks', filesTotal: 1, filesSkipped: 0 });
    expect(listExpectedChunks(ctx, versionId)).toHaveLength(6);
  });

  it('marks chunks fetched once they are loaded, and keeps what a human marked unavailable', async () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example', scope: { allowed_domains: ['cdn.example.com'] } });
    const versionId = await load(ctx, targetId, [cdnFile('main.f21b19c3.js')]);
    await findMissingChunks(ctx, { versionId });
    markChunkUnavailable(ctx, versionId, '884');
    expect(() => markChunkUnavailable(ctx, versionId, 'nope')).toThrow(/not found/);

    // settings のチャンク（unpack が push からチャンク ID 472 を chunk_key に入れる）と main の sourcemap を足す
    await load(ctx, targetId, [cdnFile('settings.f61ce08e.chunk.js'), cdnFile('main.f21b19c3.js.map')], versionId);
    const status = async () => Object.fromEntries((await findMissingChunks(ctx, { versionId })).chunks.map((c) => [c.chunkKey, c.status]));
    expect(await status()).toMatchObject({
      '472': 'fetched',
      '884': 'unavailable',
      '867': 'missing',
      [`${CDN}main.f21b19c3.js.map`]: 'fetched',
      // 取り込んだチャンクが参照する sourcemap が増える
      [`${CDN}settings.f61ce08e.chunk.js.map`]: 'missing',
    });
    // 取れれば unavailable でも fetched になる
    await load(ctx, targetId, [cdnFile('admin.3be16cd6.chunk.js')], versionId);
    expect((await status())['884']).toBe('fetched');
  });

  it('falls back to file names when the URLs are unknown (auto public path without a delivery URL)', async () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example' });
    const versionId = await load(ctx, targetId, [{ path: join(basicDir, 'main.037dca38.js') }]);
    const first = await findMissingChunks(ctx, { versionId });
    // 245 は X.e で読む非同期のチャンク（ファイル名は定数に畳まれている）、949 は HTML が読む起動時のチャンク
    expect(brief(first.chunks)).toEqual(['missing chunk 245 null', 'missing startup_chunk 949 null', 'missing sourcemap main.037dca38.js.map null']);

    await load(ctx, targetId, ['lazy.ce3f5b37.js', '949.d486fd40.js', 'main.037dca38.js.map'].map((n) => ({ path: join(basicDir, n) })), versionId);
    const second = await findMissingChunks(ctx, { versionId });
    expect(brief(second.chunks)).toEqual([
      'fetched chunk 245 null',
      'fetched startup_chunk 949 null',
      'missing sourcemap 949.d486fd40.js.map null',
      'missing sourcemap lazy.ce3f5b37.js.map null',
      'fetched sourcemap main.037dca38.js.map null',
    ]);

    // 同じ版に配信 URL が分かれば、定数のファイル名をスクリプトの場所から解く
    const ctx2 = makeCtx();
    const t2 = createTarget(ctx2, { name: 'example' }).id;
    const v2 = await load(ctx2, t2, [{ path: join(basicDir, 'main.037dca38.js'), sourceUrls: ['https://app.example.com/js/main.037dca38.js'] }]);
    expect((await findMissingChunks(ctx2, { versionId: v2 })).chunks[0]).toMatchObject({
      chunkKey: '245',
      url: 'https://app.example.com/js/lazy.ce3f5b37.js',
    });
  });
});
