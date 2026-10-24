import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type JobFailure, type SaContext, createTarget, extractEndpoints, listEndpoints, loadArtifact, unpackBundle } from '@sa/core';
import type { LoadArtifactFile, TargetScopeInput } from '@sa/types';
import { displayPositions } from '../src/artifact/position';
import { getAnalysisRun } from '../src/db/repo/analysisRun';
import { getArtifactFile } from '../src/db/repo/artifactFile';
import { ensureCodeLocation } from '../src/db/repo/codeLocation';
import { upsertEndpoint, upsertSighting } from '../src/db/repo/endpoint';
import { useContext, useTmpDir } from './helpers';

const makeCtx = useContext();
const tmp = useTmpDir();
const T0 = '2026-10-01T09:00:00Z';
const fixtureDir = new URL('./fixtures/webpack5-endpoints/', import.meta.url).pathname;
const bundle = join(fixtureDir, 'output', 'main.c452f02c.js');
const expected = JSON.parse(readFileSync(join(fixtureDir, 'expected.json'), 'utf8')) as {
  endpoints: { protocol: string; method: string; origin: string; pathNorm: string; params: [string, string][] }[];
};

async function loadVersion(
  ctx: SaContext,
  files: LoadArtifactFile[],
  opts: { unpack?: boolean; scope?: TargetScopeInput } = {},
): Promise<{ targetId: string; versionId: string }> {
  const { id: targetId } = createTarget(ctx, { name: 'example', ...(opts.scope && { scope: opts.scope }) });
  const { versionId } = loadArtifact(ctx, { targetId, collectedAt: T0, files });
  if (opts.unpack !== false) await unpackBundle(ctx, { versionId });
  return { targetId, versionId };
}

/** expected.json と同じ形にする */
function asExpected(ctx: SaContext, targetId: string) {
  return listEndpoints(ctx, { targetId }).map((e) => ({
    protocol: e.protocol,
    method: e.method,
    origin: e.origin,
    pathNorm: e.pathNorm,
    params: e.params.map((p) => [p.name, p.in] as [string, string]),
  }));
}

/** 比べる前に endpoint とパラメータの順をそろえる */
function byKey<T extends { method: string; origin: string; pathNorm: string; params: [string, string][] }>(xs: T[]): T[] {
  const key = (p: [string, string]) => p.join(' ');
  return xs
    .map((x) => ({ ...x, params: [...x.params].sort((a, b) => (key(a) < key(b) ? -1 : 1)) }))
    .sort((a, b) => (`${a.pathNorm} ${a.method} ${a.origin}` < `${b.pathNorm} ${b.method} ${b.origin}` ? -1 : 1));
}

function sightingRows(ctx: SaContext, versionId: string) {
  return ctx.db
    .prepare(
      `SELECT s.endpoint_id, s.params, s.extracted_by, s.run_id, l.raw_file_id, l.start_byte, l.end_byte, l.line, l.col
       FROM endpoint_sighting s JOIN code_location l ON l.id = s.location_id WHERE s.version_id = ? ORDER BY l.start_byte`,
    )
    .all(versionId) as {
    endpoint_id: string;
    params: string;
    extracted_by: string;
    run_id: string;
    raw_file_id: string;
    start_byte: number;
    end_byte: number;
    line: number;
    col: number;
  }[];
}

describe('extractEndpoints (ast_url)', () => {
  it('finds exactly the calls of the fixture and nothing else', async () => {
    const ctx = makeCtx();
    const { targetId, versionId } = await loadVersion(ctx, [{ path: bundle }]);
    const r = await extractEndpoints(ctx, { versionId });
    expect(r).toMatchObject({ modules: 1, calls: 10, dropped: 0, endpoints: 10, sightings: 10, skipped: 0 });
    expect(byKey(asExpected(ctx, targetId))).toEqual(byKey(expected.endpoints));

    const run = getAnalysisRun(ctx, r.runId)!;
    expect(run).toMatchObject({ tool: 'extract_endpoints', kind: 'engine', inputLayer: 'unpacked', filesTotal: 1, filesSkipped: 0 });
    expect(run.toolVersion).toContain('ast_url');
    expect(run.finishedAt).not.toBeNull();
  });

  it('points each sighting at the call expression in the raw file', async () => {
    const ctx = makeCtx();
    const { versionId } = await loadVersion(ctx, [{ path: bundle }]);
    await extractEndpoints(ctx, { versionId });
    const rows = sightingRows(ctx, versionId);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      const raw = getArtifactFile(ctx, row.raw_file_id)!;
      expect(raw.layer).toBe('raw');
      const bytes = ctx.store.get(raw.contentHash);
      const text = Buffer.from(bytes.subarray(row.start_byte, row.end_byte)).toString('utf8');
      // 呼び出し式（fetch(...)・n.get(...)・new WebSocket(...) など）が丸ごと入っている
      expect(text).toMatch(/^(new )?[\w$.]+\(.*\)$/s);
      expect(text).toMatch(/fetch|\.(get|put|delete|open|sendBeacon|ajax)\(|WebSocket/);
      expect({ line: row.line, col: row.col }).toEqual(displayPositions(bytes, [row.start_byte]).get(row.start_byte));
      expect(row.extracted_by).toBe('ast_url');
    }
  });

  it('is idempotent and drops sightings the extractor no longer reports', async () => {
    const ctx = makeCtx();
    const { targetId, versionId } = await loadVersion(ctx, [{ path: bundle }]);
    const first = await extractEndpoints(ctx, { versionId });
    const before = sightingRows(ctx, versionId).map(({ run_id: _run, ...rest }) => rest);

    // 前の実行の結果に、もう拾われない呼び出しがあったことにする
    const raw = getArtifactFile(ctx, sightingRows(ctx, versionId)[0]!.raw_file_id)!;
    const loc = ensureCodeLocation(ctx, { rawFileId: raw.id, startByte: 0, endByte: 5 });
    const stale = upsertEndpoint(ctx, { targetId, protocol: 'rest', origin: '', method: 'GET', pathNorm: '/gone', operation: '' });
    upsertSighting(ctx, { endpointId: stale, versionId, locationId: loc, params: [], extractedBy: 'ast_url' });
    // 他の抽出器の sighting は触らない
    upsertSighting(ctx, { endpointId: stale, versionId, locationId: loc, params: [], extractedBy: 'jsluice' });

    const second = await extractEndpoints(ctx, { versionId });
    expect(second.runId).not.toBe(first.runId);
    const after = sightingRows(ctx, versionId);
    expect(after.filter((s) => s.extracted_by === 'ast_url').map(({ run_id: _run, ...rest }) => rest)).toEqual(before);
    expect(after.filter((s) => s.extracted_by === 'ast_url').every((s) => s.run_id === second.runId)).toBe(true);
    expect(after.filter((s) => s.extracted_by === 'jsluice')).toHaveLength(1);
    // endpoint は triage を持つので消さない（sighting の無いものは既定の一覧に出さない）
    expect(listEndpoints(ctx, { targetId })).toHaveLength(11);
    expect(listEndpoints(ctx, { targetId }).find((e) => e.pathNorm === '/gone')?.sightings).toBe(1);
  });

  it('keeps the previous sightings of a file whose modules could not all be read', async () => {
    const ctx = makeCtx();
    const { versionId } = await loadVersion(ctx, [{ path: bundle }]);
    const first = await extractEndpoints(ctx, { versionId });
    // worker が時間切れになったことにする
    const timedOut: JobFailure = { ok: false, reason: 'timeout', detail: 'timed out', durationMs: 1 };
    const failing: SaContext = { ...ctx, jobs: { ...ctx.jobs, runWorker: () => Promise.resolve(timedOut) } };
    const r = await extractEndpoints(failing, { versionId });
    expect(r).toMatchObject({ modules: 1, calls: 0, sightings: 0, skipped: 1 });
    const rows = sightingRows(ctx, versionId);
    expect(rows).toHaveLength(10);
    expect(rows.every((s) => s.run_id === first.runId)).toBe(true);
    expect(getAnalysisRun(ctx, r.runId)).toMatchObject({ filesTotal: 1, filesAnalyzed: 0, filesSkipped: 1 });
    expect(getAnalysisRun(ctx, r.runId)!.skippedDetail?.timeout?.count).toBe(1);
  });

  it('fills the origin of relative URLs from the pages that loaded the script', async () => {
    const ctx = makeCtx();
    const { targetId, versionId } = await loadVersion(
      ctx,
      [{ path: bundle, loadedByOrigins: ['https://app.example.com/dashboard?x=1', 'https://admin.example.com:443/'] }],
      { scope: { allowed_domains: ['app.example.com', '*.example.com'], out_of_scope: ['auth.example.com'] } },
    );
    const r = await extractEndpoints(ctx, { versionId });
    // 相対 URL の 8 件は 2 つの origin に分かれ、絶対 URL の 2 件はそのまま
    expect(r).toMatchObject({ calls: 10, endpoints: 18, sightings: 18 });
    const list = listEndpoints(ctx, { targetId });
    expect(new Set(list.map((e) => e.origin))).toEqual(
      new Set(['https://app.example.com', 'https://admin.example.com', 'https://auth.example.com', 'wss://rt.example.com']),
    );
    const scopeOf = (origin: string) => [...new Set(list.filter((e) => e.origin === origin).map((e) => e.inScope))];
    expect(scopeOf('https://app.example.com')).toEqual([true]);
    expect(scopeOf('https://admin.example.com')).toEqual([true]);
    expect(scopeOf('https://auth.example.com')).toEqual([false]);
  });

  it('reads every module of a webpack bundle and skips files unpack could not parse', async () => {
    const ctx = makeCtx();
    const basic = new URL('./fixtures/webpack5-basic/output/', import.meta.url).pathname;
    const dir = tmp();
    const broken = join(dir, 'broken.js');
    writeFileSync(broken, 'function (');
    const files = readdirSync(basic)
      .filter((f) => f.endsWith('.js'))
      .map((f) => ({ path: join(basic, f) }));
    const { targetId, versionId } = await loadVersion(ctx, [...files, { path: broken }]);
    const r = await extractEndpoints(ctx, { versionId });
    // webpack のファクトリ（関数式）も読める。この fixture に HTTP の呼び出しは無い
    expect(r).toMatchObject({ modules: 4, calls: 0, endpoints: 0, skipped: 0 });
    expect(listEndpoints(ctx, { targetId })).toEqual([]);
    const run = getAnalysisRun(ctx, r.runId)!;
    expect(run).toMatchObject({ filesTotal: 5, filesAnalyzed: 4, filesSkipped: 1 });
    expect(run.skippedDetail?.parse_failed?.count).toBe(1);
  });

  it('reads the whole raw file when unpack has not run', async () => {
    const ctx = makeCtx();
    const { targetId, versionId } = await loadVersion(ctx, [{ path: bundle }], { unpack: false });
    expect(await extractEndpoints(ctx, { versionId })).toMatchObject({ modules: 1, endpoints: 10 });
    expect(byKey(asExpected(ctx, targetId))).toEqual(byKey(expected.endpoints));
  });

  it('rejects an unknown version', async () => {
    const ctx = makeCtx();
    const err = await extractEndpoints(ctx, { versionId: 'nope' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('displayPositions', () => {
  it('counts lines and UTF-16 columns in one pass', () => {
    const text = 'ab\nc日本😀d\n\nxyz';
    const bytes = Buffer.from(text);
    const offsets = [0, 2, 3, 4, Buffer.byteLength('ab\nc日本😀'), Buffer.byteLength('ab\nc日本😀d\n\n'), bytes.length];
    const naive = (o: number) => {
      const before = bytes.subarray(0, o).toString('utf8');
      const lines = before.split('\n');
      return { line: lines.length, col: lines.at(-1)!.length };
    };
    const got = displayPositions(bytes, offsets);
    for (const o of offsets) expect(got.get(o)).toEqual(naive(o));
  });
});
