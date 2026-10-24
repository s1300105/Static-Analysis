/**
 * jsluice 抽出器（design.md §7.3 extract_endpoints の 1）: Go の jsluice（tree-sitter）を子プロセスで raw の JS に掛ける。
 * - `jsluice urls --include-source` の 1 行 1 件の JSON を読む。jsluice は位置を出さないので、source（一致した式の本文）を
 *   raw のバイト列の中で探して範囲に戻す。同じ本文は同じ結果になるので、本文が何度も現れればそのすべての位置に置く。
 *   見つからなければ unmapped として記録する
 * - jsluice の出力の癖を直す: 同じ式を複数の規則で重ねて出す（method の有無だけ違う）→ 1 つにまとめる。
 *   呼び出しの中の文字列リテラルも別に出す → 報告済みの呼び出しの範囲に入る文字列は捨てる。
 *   x.get(...) / x.delete(...) の method を空で出す → type（"a.get" など）から補う。sendBeacon は POST
 * - ast_url と同じ規則で、"/api" + path のような送信部（"/" で終わらない文字列の直後に式）はエンドポイントにしない。
 *   文字列リテラルだけの一致のうち、静的ファイル（画像・CSS・フォント・JS・map）のパスは捨てる
 * - jsluice は http(s) の URL を引数に渡すと取りに行くので、引数は blob ストアの絶対パスだけにする（ネットワークは使わない）
 */
import { accessSync, constants, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { EndpointParam } from '@sa/types';
import type { SaContext, ToolConfig } from '../../context';
import { finishAnalysisRun, startAnalysisRun } from '../../db/repo/analysisRun';
import { listArtifactFiles } from '../../db/repo/artifactFile';
import type { ArtifactVersion } from '../../db/repo/artifactVersion';
import { SaError } from '../../errors';
import { SkipLog } from '../../jobs/skips';
import { sha256Hex } from '../../store/blob';
import { type EndpointCandidate, type ExtractorRun, type RawCandidates, writeSightings } from './sightings';

/** `jsluice urls --include-source` の 1 件 */
export interface JsluiceMatch {
  url: string;
  method?: string;
  type?: string;
  source?: string;
  queryParams?: string[];
  bodyParams?: string[];
  headers?: Record<string, string>;
}

export interface JsluiceMapping {
  candidates: EndpointCandidate[];
  /** まとめた後の件数 */
  matches: number;
  /** 送信部・静的ファイル・呼び出しの中の文字列として捨てた件数 */
  dropped: number;
  /** source が raw の中に見つからなかった URL */
  unmapped: string[];
}

const METHOD_IN_TYPE_RE = /(?:^|\.)(get|post|put|patch|delete|del|head|options)$/i;
const STATIC_FILE_RE = /\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|css|woff2?|ttf|otf|eot|js|mjs|map|mp4|webm|mp3|wav)$/i;
const STRING_LITERAL = 'stringLiteral';

export async function runJsluice(ctx: SaContext, version: ArtifactVersion, tool: ToolConfig): Promise<ExtractorRun> {
  if (!isAbsolute(tool.path)) throw new SaError('INVALID_INPUT', `tools.jsluice.path must be absolute: ${tool.path}`);
  // 置き場所の誤りは、ファイルごとの tool_error にせず最初に止める
  let toolVersion = tool.version;
  try {
    accessSync(tool.path, constants.X_OK);
    toolVersion ??= `sha256:${sha256Hex(readFileSync(tool.path)).slice(0, 16)}`;
  } catch (err) {
    throw new SaError('TOOL_ERROR', `cannot run jsluice at ${tool.path}`, { path: tool.path }, { cause: err });
  }

  const raws = listArtifactFiles(ctx, { versionId: version.id, layer: 'raw', kind: 'js' });
  const runId = startAnalysisRun(ctx, {
    versionId: version.id,
    kind: 'engine',
    tool: 'extract_endpoints/jsluice',
    toolVersion: `jsluice ${toolVersion}`,
    inputLayer: 'raw',
  });

  const results = await Promise.all(
    raws.map((raw) =>
      ctx.jobs.runChild({
        bin: tool.path,
        args: ['urls', '--include-source', '--placeholder', 'EXPR', ctx.store.pathOf(raw.contentHash)],
        cwd: ctx.config.workspaceDir,
        env: {},
        timeoutMs: tool.timeoutMs,
      }),
    ),
  );

  const skips = new SkipLog();
  let found = 0;
  let dropped = 0;
  let failed = 0;
  const byRaw: RawCandidates[] = [];
  raws.forEach((raw, i) => {
    const r = results[i]!;
    if (!skips.record(r, { fileId: raw.id })) {
      byRaw.push({ raw, complete: false, candidates: [] });
      failed++;
      return;
    }
    let matches: JsluiceMatch[];
    try {
      matches = parseJsluiceOutput(r.value.stdout);
    } catch (err) {
      skips.add('tool_error', { fileId: raw.id, detail: err instanceof Error ? err.message : String(err) });
      byRaw.push({ raw, complete: false, candidates: [] });
      failed++;
      return;
    }
    // blob は読むときにハッシュを検査する（jsluice が読んだものと同じ中身で位置を戻す）
    const m = mapJsluiceMatches(ctx.store.get(raw.contentHash), matches);
    found += m.matches;
    dropped += m.dropped;
    for (const url of m.unmapped) skips.add('unmapped', { ref: raw.id, detail: `jsluice match not found in the file: ${url}` });
    byRaw.push({ raw, complete: true, candidates: m.candidates });
  });

  const written = writeSightings(ctx, { versionId: version.id, targetId: version.targetId, extractor: 'jsluice', runId, raws: byRaw });
  const { filesSkipped, skippedDetail } = skips.summary();
  finishAnalysisRun(ctx, runId, { filesTotal: raws.length, filesAnalyzed: raws.length - filesSkipped, filesSkipped, skippedDetail });
  return {
    stats: { runId, inputs: raws.length, found, dropped: dropped + written.dropped, sightings: written.sightings, skipped: failed },
    endpointIds: written.endpointIds,
  };
}

/** 1 行 1 件の JSON を読む。形の違う行があれば誤りにする（ファイルごとに tool_error） */
export function parseJsluiceOutput(stdout: string): JsluiceMatch[] {
  const out: JsluiceMatch[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const v = JSON.parse(line) as unknown;
    if (typeof v !== 'object' || v === null || typeof (v as { url?: unknown }).url !== 'string') {
      throw new Error(`unexpected jsluice output: ${line.slice(0, 200)}`);
    }
    out.push(v as JsluiceMatch);
  }
  return out;
}

interface Merged {
  url: string;
  method: string;
  literal: boolean;
  source: string;
  params: EndpointParam[];
}

/** jsluice の結果を raw の位置つきの候補にする（純粋関数。テストは実行ファイル無しで回す） */
export function mapJsluiceMatches(bytes: Uint8Array, matches: JsluiceMatch[]): JsluiceMapping {
  const out: JsluiceMapping = { candidates: [], matches: 0, dropped: 0, unmapped: [] };

  // 同じ本文・同じ URL の重複（規則違い・同じ本文の別の位置）を 1 つにまとめる
  const merged = new Map<string, Merged>();
  for (const m of matches) {
    if (m.source === undefined || m.source === '') {
      out.unmapped.push(m.url);
      continue;
    }
    const key = `${m.source}\u0000${m.url}`;
    const e = merged.get(key) ?? { url: m.url, method: '', literal: true, source: m.source, params: [] };
    merged.set(key, e);
    if (e.method === '') e.method = methodOf(m);
    if (m.type !== STRING_LITERAL) e.literal = false;
    const add = (name: string, loc: EndpointParam['in']) => {
      if (!e.params.some((p) => p.name === name && p.in === loc)) e.params.push({ name, in: loc });
    };
    for (const name of m.queryParams ?? []) add(name, 'query');
    for (const name of m.bodyParams ?? []) add(name, 'body');
    for (const name of Object.keys(m.headers ?? {})) add(name, 'header');
  }
  out.matches = merged.size;

  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const located = [...merged.values()].map((e) => ({ e, at: occurrences(buf, Buffer.from(e.source, 'utf8')) }));
  // 呼び出し（文字列リテラル以外の一致）の範囲。文字列リテラルがこの中にあれば、その呼び出しの一部として捨てる
  const calls = located.filter((l) => !l.e.literal).flatMap((l) => l.at);

  for (const { e, at } of located) {
    if (at.length === 0) {
      out.unmapped.push(e.url);
      continue;
    }
    if (isTransport(e.url) || (e.literal && STATIC_FILE_RE.test(e.url.split(/[?#]/)[0]!))) {
      out.dropped++;
      continue;
    }
    const kept = e.literal ? at.filter((r) => !calls.some((c) => c.start <= r.start && r.end <= c.end)) : at;
    if (kept.length === 0) {
      out.dropped++;
      continue;
    }
    for (const r of kept) {
      out.candidates.push({ url: e.url, method: e.method, websocket: false, params: e.params, startByte: r.start, endByte: r.end });
    }
  }
  out.candidates.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
  return out;
}

function methodOf(m: JsluiceMatch): string {
  const method = (m.method ?? '').toUpperCase();
  if (method !== '') return method;
  const type = m.type ?? '';
  const named = METHOD_IN_TYPE_RE.exec(type)?.[1]?.toUpperCase();
  if (named !== undefined) return named === 'DEL' ? 'DELETE' : named;
  return type.endsWith('sendBeacon') ? 'POST' : '';
}

/** "/api/v2EXPR" のように、"/" で終わらない文字列の直後に式が続く URL（クライアントの送信部。ast_url の basePrefix と同じ規則） */
function isTransport(url: string): boolean {
  const i = url.indexOf('EXPR');
  if (i <= 0) return false;
  const prefix = url.slice(0, i);
  return !prefix.endsWith('/') && !prefix.includes('?') && /^(https?:\/\/|\/)/.test(prefix);
}

/** needle のすべての出現（重ならないもの）のバイト範囲 */
function occurrences(haystack: Buffer, needle: Buffer): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) {
    out.push({ start: i, end: i + needle.length });
  }
  return out;
}
