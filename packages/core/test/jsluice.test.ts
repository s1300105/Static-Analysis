import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SaContext, type ToolConfig, createTarget, extractEndpoints, listEndpoints, loadArtifact, unpackBundle } from '@sa/core';
import { mapJsluiceMatches, parseJsluiceOutput } from '../src/analysis/endpoints/jsluice';
import { getAnalysisRun } from '../src/db/repo/analysisRun';
import { useContext, useTmpDir } from './helpers';

const makeCtx = useContext();
const tmp = useTmpDir();
const fixtureDir = new URL('./fixtures/webpack5-endpoints/', import.meta.url).pathname;
const bundle = join(fixtureDir, 'output', 'main.c452f02c.js');
const recorded = readFileSync(join(fixtureDir, 'jsluice-urls.jsonl'), 'utf8');
/** 実物の jsluice（あれば）。CI の Docker のジョブは実行イメージの中で sa extract-endpoints を通して確かめる */
const realJsluice = process.env.SA_TEST_JSLUICE;

function brief(bytes: Uint8Array, out: ReturnType<typeof mapJsluiceMatches>): string[] {
  return out.candidates.map((c) => {
    const params = c.params.map((p) => `${p.in}:${p.name}`).join(',');
    const text = Buffer.from(bytes.subarray(c.startByte, c.endByte)).toString('utf8');
    return `${c.method || '-'} ${c.url}${params ? ` [${params}]` : ''} @ ${text.slice(0, 24)}`;
  });
}

describe('jsluice output mapping', () => {
  it('maps the recorded output of the fixture back to raw byte ranges', () => {
    const bytes = readFileSync(bundle);
    const out = mapJsluiceMatches(bytes, parseJsluiceOutput(recorded));
    // 19 行 → 重複をまとめて 17 件。送信部 1・呼び出しの中の文字列 7・静的ファイル 1 を捨てる
    expect({ matches: out.matches, dropped: out.dropped, unmapped: out.unmapped }).toEqual({ matches: 17, dropped: 9, unmapped: [] });
    expect(brief(bytes, out)).toEqual([
      'DELETE /docs/EXPR @ a.delete("/docs/"+e)',
      'GET /admin/stats @ a.get("/admin/stats")',
      'POST https://auth.example.com/oauth/token [header:Content-Type,header:X-Client-Version] @ fetch("https://auth.exam',
      'POST /legacy/reports/EXPR/export @ t.open("POST","/legacy/r',
      'POST /telemetry/ping @ navigator.sendBeacon("/t',
      '- /api/v1/legacy-search @ "/api/v1/legacy-search"',
      '- /users/:id @ "/users/:id"',
      '- /settings @ "/settings"',
    ]);
    for (const c of out.candidates) expect(c.endByte).toBeGreaterThan(c.startByte);
  });

  it('places a repeated source at every occurrence, with byte offsets after multibyte text', () => {
    const code = 'const s = "日本😀"; get("/a"); get("/a"); x("/b");';
    const bytes = Buffer.from(code);
    const out = mapJsluiceMatches(bytes, [
      { url: '/a', type: 'stringLiteral', source: '"/a"' },
      { url: '/a', type: 'stringLiteral', source: '"/a"' },
      { url: '/b', type: 'stringLiteral', source: '"/b"' },
    ]);
    expect(out.candidates.map((c) => bytes.subarray(c.startByte, c.endByte).toString())).toEqual(['"/a"', '"/a"', '"/b"']);
    expect(out.candidates[0]!.startByte).toBe(Buffer.byteLength('const s = "日本😀"; get('));
    expect(out.matches).toBe(2);
  });

  it('drops literals inside a reported call but keeps the same literal elsewhere', () => {
    const code = 'api.post("/x", d); const y = "/x";';
    const bytes = Buffer.from(code);
    const out = mapJsluiceMatches(bytes, [
      { url: '/x', type: 'api.post', source: 'api.post("/x", d)' },
      { url: '/x', type: 'stringLiteral', source: '"/x"' },
    ]);
    expect(brief(bytes, out)).toEqual(['POST /x @ api.post("/x", d)', '- /x @ "/x"']);
    expect(out.candidates[1]!.startByte).toBe(code.lastIndexOf('"/x"'));
  });

  it('infers methods from the call type and drops transports and static files', () => {
    const code = 'r.del("/a/" + i); navigator.sendBeacon("/t"); fetch("https://h.example.com" + p); u = "/img/a.png?v=1"; f("/x.js")';
    const bytes = Buffer.from(code);
    const out = mapJsluiceMatches(bytes, [
      { url: '/a/EXPR', type: 'r.del', source: 'r.del("/a/" + i)' },
      { url: '/t', type: 'navigator.sendBeacon', source: 'navigator.sendBeacon("/t")' },
      { url: 'https://h.example.comEXPR', type: 'fetch', method: 'GET', source: 'fetch("https://h.example.com" + p)' },
      { url: '/img/a.png?v=1', type: 'stringLiteral', source: '"/img/a.png?v=1"' },
      // 呼び出しとして見つけたものは静的ファイルの拡張子でも残す
      { url: '/x.js', type: 'f', method: 'GET', source: 'f("/x.js")' },
    ]);
    expect(out.candidates.map((c) => `${c.method} ${c.url}`)).toEqual(['DELETE /a/EXPR', 'POST /t', 'GET /x.js']);
    expect(out.dropped).toBe(2);
  });

  it('reports sources it cannot find', () => {
    const out = mapJsluiceMatches(Buffer.from('fetch("/a")'), [
      { url: '/a', type: 'fetch', source: 'fetch("/b")' },
      { url: '/c', type: 'fetch' },
    ]);
    expect(out.candidates).toEqual([]);
    expect(out.unmapped.sort()).toEqual(['/a', '/c']);
  });

  it('rejects output that is not one JSON object per line', () => {
    expect(parseJsluiceOutput('\n{"url":"/a"}\n\n')).toEqual([{ url: '/a' }]);
    expect(() => parseJsluiceOutput('{"url":"/a"}\nnot json')).toThrow();
    expect(() => parseJsluiceOutput('{"nourl":1}')).toThrow(/unexpected jsluice output/);
  });
});

/** 引数を確かめて、記録した出力を返す偽の jsluice（シェルを通さず、PATH の無い環境でも動くように node の絶対パスを使う） */
function fakeJsluice(dir: string, opts: { stdout?: string; exitCode?: number } = {}): { tool: ToolConfig; argsLog: string } {
  const out = join(dir, 'jsluice-out.jsonl');
  const argsLog = join(dir, 'jsluice-args.log');
  writeFileSync(out, opts.stdout ?? recorded);
  const bin = join(dir, 'jsluice');
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify({ args, env: Object.keys(process.env) }) + '\\n');
fs.readFileSync(args[4]);
process.stdout.write(fs.readFileSync(${JSON.stringify(out)}));
process.exitCode = ${opts.exitCode ?? 0};
`,
  );
  chmodSync(bin, 0o755);
  return { tool: { path: bin, version: 'test-1', timeoutMs: 30_000 }, argsLog };
}

async function loadFixture(ctx: SaContext): Promise<{ targetId: string; versionId: string }> {
  const { id: targetId } = createTarget(ctx, { name: 'example' });
  const { versionId } = loadArtifact(ctx, { targetId, collectedAt: '2026-10-01T09:00:00Z', files: [{ path: bundle }] });
  await unpackBundle(ctx, { versionId });
  return { targetId, versionId };
}

function rows(ctx: SaContext, versionId: string, extractor: string) {
  return ctx.db
    .prepare(
      `SELECT e.method, e.origin, e.path_norm, s.params, s.run_id, l.start_byte, l.end_byte
       FROM endpoint_sighting s JOIN api_endpoint e ON e.id = s.endpoint_id JOIN code_location l ON l.id = s.location_id
       WHERE s.version_id = ? AND s.extracted_by = ? ORDER BY l.start_byte`,
    )
    .all(versionId, extractor) as { method: string; path_norm: string; run_id: string; start_byte: number; end_byte: number }[];
}

describe('extractEndpoints with jsluice', () => {
  it('runs jsluice on each raw file and writes its sightings next to ast_url', async () => {
    const dir = tmp();
    const { tool, argsLog } = fakeJsluice(dir);
    const ctx = makeCtx({ tools: { jsluice: tool } });
    const { targetId, versionId } = await loadFixture(ctx);
    const r = await extractEndpoints(ctx, { versionId });

    expect(r.unavailable).toEqual([]);
    expect(r.extractors.jsluice).toMatchObject({ inputs: 1, found: 17, dropped: 9, sightings: 8, skipped: 0 });
    expect(r.extractors.ast_url).toMatchObject({ found: 10, sightings: 10 });
    // auth・legacy reports・telemetry は ast_url と同じ endpoint。jsluice だけのものが 5 件
    expect(r.endpoints).toBe(15);

    // 引数は「urls --include-source --placeholder EXPR <blob の絶対パス>」だけ。環境変数は渡さない
    const calls = readFileSync(argsLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; env: string[] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 4)).toEqual(['urls', '--include-source', '--placeholder', 'EXPR']);
    expect(calls[0]!.args[4]).toMatch(new RegExp(`^${ctx.store.root}/[0-9a-f]{2}/[0-9a-f]{64}$`));
    expect(calls[0]!.env.filter((k) => !k.startsWith('__CF'))).toEqual([]);

    const run = getAnalysisRun(ctx, r.extractors.jsluice!.runId)!;
    expect(run).toMatchObject({ tool: 'extract_endpoints/jsluice', toolVersion: 'jsluice test-1', inputLayer: 'raw', filesTotal: 1 });
    const js = rows(ctx, versionId, 'jsluice');
    expect(js.map((s) => `${s.method || '-'} ${s.path_norm}`)).toEqual([
      'DELETE /docs/{}',
      'GET /admin/stats',
      'POST /oauth/token',
      'POST /legacy/reports/{}/export',
      'POST /telemetry/ping',
      '- /api/v1/legacy-search',
      '- /users/{}',
      '- /settings',
    ]);
    const raw = readFileSync(bundle);
    expect(raw.subarray(js[1]!.start_byte, js[1]!.end_byte).toString()).toBe('a.get("/admin/stats")');

    // メソッド不明の /api/v1/legacy-search は POST があるので既定の一覧では省く
    const list = listEndpoints(ctx, { targetId });
    expect(list.filter((e) => e.pathNorm === '/api/v1/legacy-search').map((e) => e.method)).toEqual(['POST']);
    expect(listEndpoints(ctx, { targetId, all: true }).filter((e) => e.pathNorm === '/api/v1/legacy-search')).toHaveLength(2);
    expect(list.find((e) => e.pathNorm === '/users/{}')).toMatchObject({ method: '', params: [{ name: 'id', in: 'path' }] });
  });

  it('records sources it cannot place and failures of the tool', async () => {
    const dir = tmp();
    const ctx0 = makeCtx({ tools: { jsluice: fakeJsluice(dir).tool } });
    const { versionId } = await loadFixture(ctx0);
    const first = await extractEndpoints(ctx0, { versionId, extractors: ['jsluice'] });
    expect(Object.keys(first.extractors)).toEqual(['jsluice']);

    // 中身に無い source → unmapped
    const extra = `${recorded}{"url":"/nowhere","type":"fetch","source":"fetch(\\"/nowhere\\")"}\n`;
    const ctx1 = { ...ctx0, config: { ...ctx0.config, tools: { jsluice: fakeJsluice(tmp(), { stdout: extra }).tool } } };
    const second = await extractEndpoints(ctx1, { versionId, extractors: ['jsluice'] });
    const run = getAnalysisRun(ctx0, second.extractors.jsluice!.runId)!;
    expect(run.skippedDetail?.unmapped).toMatchObject({ count: 1, items: [{ detail: expect.stringContaining('/nowhere') }] });
    expect(run.filesSkipped).toBe(0);

    // 異常終了 → tool_error。前回の sighting は残す
    const ctx2 = { ...ctx0, config: { ...ctx0.config, tools: { jsluice: fakeJsluice(tmp(), { exitCode: 3 }).tool } } };
    const third = await extractEndpoints(ctx2, { versionId, extractors: ['jsluice'] });
    expect(third.extractors.jsluice).toMatchObject({ inputs: 1, found: 0, sightings: 0, skipped: 1 });
    expect(getAnalysisRun(ctx0, third.extractors.jsluice!.runId)!.skippedDetail?.tool_error?.count).toBe(1);
    const kept = rows(ctx0, versionId, 'jsluice');
    expect(kept).toHaveLength(8);
    expect(kept.every((s) => s.run_id === second.extractors.jsluice!.runId)).toBe(true);
  });

  it('fails clearly when the configured binary is missing or not executable', async () => {
    const notExecutable = join(tmp(), 'jsluice');
    writeFileSync(notExecutable, '');
    for (const tool of [
      { path: '/nonexistent/jsluice', timeoutMs: 1000 },
      { path: '/nonexistent/jsluice', version: 'v1', timeoutMs: 1000 },
      { path: notExecutable, version: 'v1', timeoutMs: 1000 },
    ]) {
      const ctx = makeCtx({ tools: { jsluice: tool } });
      const { versionId } = await loadFixture(ctx);
      expect(await extractEndpoints(ctx, { versionId }).catch((e: unknown) => e)).toMatchObject({ code: 'TOOL_ERROR' });
    }
  });

  it.runIf(realJsluice)('gives the same result with the real jsluice as with the recorded output', async () => {
    const real = makeCtx({ tools: { jsluice: { path: realJsluice!, timeoutMs: 60_000 } } });
    const fake = makeCtx({ tools: { jsluice: fakeJsluice(tmp()).tool } });
    const results = [];
    for (const ctx of [real, fake]) {
      const { versionId } = await loadFixture(ctx);
      const r = await extractEndpoints(ctx, { versionId, extractors: ['jsluice'] });
      results.push(rows(ctx, versionId, 'jsluice').map(({ run_id: _r, ...rest }) => rest));
      // 版の指定が無ければ実行ファイルの sha256 を版として残す
      if (ctx === real) expect(getAnalysisRun(ctx, r.extractors.jsluice!.runId)!.toolVersion).toMatch(/^jsluice sha256:[0-9a-f]{16}$/);
    }
    expect(results[0]).toEqual(results[1]);
  });
});
