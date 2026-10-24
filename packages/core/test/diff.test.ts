import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DiffResult,
  type SaContext,
  createTarget,
  diffVersions,
  extractEndpoints,
  importHar,
  loadArtifact,
  rankEndpoints,
  triageEndpoint,
  unpackBundle,
} from '@sa/core';
import type { LoadArtifactFile } from '@sa/types';
import { useContext, useTmpDir } from './helpers';

const makeCtx = useContext();
const tmp = useTmpDir();
const chunks = new URL('./fixtures/webpack5-chunks/output/', import.meta.url).pathname;
const endpointsBundle = new URL('./fixtures/webpack5-endpoints/output/main.c452f02c.js', import.meta.url).pathname;

const file = (name: string): LoadArtifactFile => ({ path: join(chunks, name), sourceUrls: [`https://cdn.example.com/assets/${name}`] });

async function version(ctx: SaContext, targetId: string, at: string, files: LoadArtifactFile[]): Promise<string> {
  const { versionId } = loadArtifact(ctx, { targetId, collectedAt: at, files });
  await unpackBundle(ctx, { versionId });
  await extractEndpoints(ctx, { versionId });
  return versionId;
}

const short = (xs: { endpoint: { method: string; pathNorm: string } }[]) => xs.map((x) => `${x.endpoint.method} ${x.endpoint.pathNorm}`);

describe('diffVersions', () => {
  it('separates differences that come from chunks one version did not fetch', async () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example' });
    // 1 版目: settings のチャンクだけ取得（admin・867 は参照されているのに未取得）
    const v1 = await version(ctx, targetId, '2026-09-01T00:00:00Z', [file('main.f21b19c3.js'), file('settings.f61ce08e.chunk.js')]);
    // 2 版目: チャンクを全部取得し、別のバンドル（チャンクを持たないエントリ）も増えた
    const v2 = await version(ctx, targetId, '2026-10-01T00:00:00Z', [
      file('main.f21b19c3.js'),
      file('settings.f61ce08e.chunk.js'),
      file('admin.3be16cd6.chunk.js'),
      file('867.75f286be.chunk.js'),
      { path: endpointsBundle },
    ]);
    const d: DiffResult = await diffVersions(ctx, { versionId: v2 });
    expect(d.baseVersionId).toBe(v1);
    // admin・867 の呼び出しは 1 版目で取っていないチャンクにある → 未収集による差
    expect(short(d.uncollected.added)).toEqual(['GET /api/admin/users', 'POST /api/reports/export']);
    expect(d.uncollected.added.map((c) => c.chunks)).toEqual([['884'], ['867']]);
    // 別のバンドルの 10 件は本当の新規
    expect(d.added).toHaveLength(10);
    expect(d.added.every((c) => c.chunks.join() === 'entry')).toBe(true);
    expect(d.removed).toEqual([]);

    // 3 版目: また settings だけ（2 版目からの削除は、取っていないチャンクの分が未収集、バンドルの分は本当の削除）
    const v3 = await version(ctx, targetId, '2026-11-01T00:00:00Z', [file('main.f21b19c3.js'), file('settings.f61ce08e.chunk.js')]);
    const d3 = await diffVersions(ctx, { versionId: v3 });
    expect(d3.baseVersionId).toBe(v2);
    expect(short(d3.uncollected.removed)).toEqual(['GET /api/admin/users', 'POST /api/reports/export']);
    expect(d3.removed).toHaveLength(10);
    expect(d3.added).toEqual([]);
  });

  it('reports new parameters of an endpoint both versions have, and checks the base version', async () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example' });
    const dir = tmp();
    writeFileSync(join(dir, 'a.js'), 'fetch("/api/items?page=1"); fetch("/api/old");');
    writeFileSync(join(dir, 'b.js'), 'fetch("/api/items?page=1&sort=x", { method: "GET" }); fetch("/api/new");');
    const v1 = await version(ctx, targetId, '2026-09-01T00:00:00Z', [{ path: join(dir, 'a.js') }]);
    const v2 = await version(ctx, targetId, '2026-10-01T00:00:00Z', [{ path: join(dir, 'b.js') }]);
    const d = await diffVersions(ctx, { versionId: v2, baseVersionId: v1 });
    expect(d.newParams.map((n) => ({ path: n.endpoint.pathNorm, params: n.params }))).toEqual([
      { path: '/api/items', params: [{ name: 'sort', in: 'query' }] },
    ]);
    expect(short(d.added)).toEqual(['GET /api/new']);
    expect(short(d.removed)).toEqual(['GET /api/old']);

    const err = (p: Promise<unknown>) => p.catch((e: unknown) => (e as { code: string }).code);
    expect(await err(diffVersions(ctx, { versionId: v1 }))).toBe('INVALID_INPUT');
    expect(await err(diffVersions(ctx, { versionId: v1, baseVersionId: v1 }))).toBe('INVALID_INPUT');
    const other = createTarget(ctx, { name: 'other' }).id;
    const vo = await version(ctx, other, '2026-09-01T00:00:00Z', [{ path: join(dir, 'a.js') }]);
    expect(await err(diffVersions(ctx, { versionId: v2, baseVersionId: vo }))).toBe('NOT_FOUND');
  });
});

describe('rankEndpoints / triageEndpoint', () => {
  it('orders by the deterministic rules and shows which ones matched', async () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example' });
    const dir = tmp();
    writeFileSync(join(dir, 'a.js'), 'fetch("/api/old/list");');
    writeFileSync(join(dir, 'b.js'), 'fetch("/api/old/list"); fetch("/api/new/list"); fetch(`/api/new/${userId}`, { method: "DELETE" }); fetch("/api/new/search?accountId=1");');
    await version(ctx, targetId, '2026-09-01T00:00:00Z', [{ path: join(dir, 'a.js') }]);
    await version(ctx, targetId, '2026-10-01T00:00:00Z', [{ path: join(dir, 'b.js') }]);
    const ranked = rankEndpoints(ctx, { targetId });
    expect(ranked.map((e) => `${e.method} ${e.pathNorm} [${e.rules.join(',')}]`)).toEqual([
      'DELETE /api/new/{} [new_in_latest,not_in_har,state_changing,id_param]',
      'GET /api/new/search [new_in_latest,not_in_har,id_param]',
      'GET /api/new/list [new_in_latest,not_in_har]',
      'GET /api/old/list [not_in_har]',
    ]);
    expect(ranked.every((e) => e.needsTriage)).toBe(true);
  });

  it('moves triaged endpoints down and brings them back when new parameters appear', async () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example' });
    const dir = tmp();
    writeFileSync(join(dir, 'a.js'), 'fetch("/api/a", { method: "POST" }); fetch("/api/b");');
    const v = await version(ctx, targetId, '2026-09-01T00:00:00Z', [{ path: join(dir, 'a.js') }]);
    const a = rankEndpoints(ctx, { targetId }).find((e) => e.pathNorm === '/api/a')!;
    triageEndpoint(ctx, { targetId, endpointId: a.id, triage: 'tested' });
    expect(rankEndpoints(ctx, { targetId }).map((e) => `${e.pathNorm} ${e.needsTriage}`)).toEqual(['/api/b true', '/api/a false']);

    // HAR で新しいパラメータが見つかる → 再浮上
    const har = join(dir, 'x.har');
    writeFileSync(
      har,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: '2026-09-01T00:00:00Z',
              _resourceType: 'fetch',
              request: { method: 'POST', url: 'https://app.example.com/api/a', postData: { mimeType: 'application/json', text: '{"debug":1}' } },
              response: { status: 200, content: { mimeType: 'application/json' } },
            },
          ],
        },
      }),
    );
    importHar(ctx, { targetId, versionId: v, harPath: har });
    const again = rankEndpoints(ctx, { targetId }).find((e) => e.id === a.id)!;
    expect(again).toMatchObject({ triage: 'tested', needsTriage: true, paramsChangedSinceTriage: true });
    expect(again.rules).not.toContain('not_in_har');

    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { code: string }).code;
      }
      return 'ok';
    };
    expect(code(() => triageEndpoint(ctx, { targetId, endpointId: a.id, triage: 'maybe' as 'tested' }))).toBe('INVALID_INPUT');
    expect(code(() => triageEndpoint(ctx, { targetId, endpointId: 'nope', triage: 'ignore' }))).toBe('NOT_FOUND');
    expect(code(() => triageEndpoint({ ...ctx, caller: 'mcp' }, { targetId, endpointId: a.id, triage: 'ignore' }))).toBe('POLICY_DENIED');
  });
});
