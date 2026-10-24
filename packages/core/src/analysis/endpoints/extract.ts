/**
 * extract_endpoints（design.md §6.2・§7.3、計画書 M2）の ast_url 抽出器: JS の HTTP クライアント呼び出しから
 * api_endpoint / endpoint_sighting を作る。
 * - パースと呼び出しの認識は worker（jobs/workers/endpoints.worker.ts）。入力は unpacked のモジュール。
 *   unpack していない raw（境界の検出を掛けていないもの）はファイル全体を 1 つのモジュールとして読む
 * - URL は normalizeEndpointUrl で path_norm にする。パスが全部可変で origin も無いもの、http(s)・ws(s) 以外は捨てる（dropped）
 * - 相対 URL の origin は、その script を読み込んだ文書のオリジン（raw の loaded_by_origins）で補う（design.md §6.2）。
 *   複数あればそれぞれの origin の endpoint にする。分からなければ ''
 * - 位置は呼び出し式の raw 基準のバイト範囲（unpacked の raw_offset を足す）で code_location に置く
 * 掛け直し: raw ファイルごとに、全モジュールを読めたら ast_url の sighting を作り直す（消えた呼び出しの sighting を残さない）。
 * 一部のモジュールが読めなかった raw は前回の sighting を消さずに足すだけにする。api_endpoint（triage を持つ）は消さない。
 */
import type { EndpointParam, Protocol } from '@sa/types';
import type { SaContext } from '../../context';
import { withTxn } from '../../db/connection';
import { finishAnalysisRun, startAnalysisRun } from '../../db/repo/analysisRun';
import { type ArtifactFile, listArtifactFiles } from '../../db/repo/artifactFile';
import { getArtifactVersion } from '../../db/repo/artifactVersion';
import { ensureCodeLocation } from '../../db/repo/codeLocation';
import { deleteSightingsInRawFile, upsertEndpoint, upsertSighting } from '../../db/repo/endpoint';
import { SaError } from '../../errors';
import { SkipLog } from '../../jobs/skips';
import { BABEL_PARSER_VERSION, endpointsWorker } from '../../jobs/workers';
import type { ExtractedCall } from '../../jobs/workers/endpoints.worker';
import { CORE_VERSION } from '../../version';
import { displayPositions } from '../../artifact/position';
import { normalizeEndpointUrl } from './normalize';

export interface ExtractEndpointsOptions {
  versionId: string;
}

export interface ExtractEndpointsResult {
  runId: string;
  /** 読んだモジュール（unpacked、unpack していない raw はファイル全体）の数 */
  modules: number;
  /** 認識した呼び出しの数 */
  calls: number;
  /** URL を正規化できずに捨てた呼び出しの数 */
  dropped: number;
  /** この実行で sighting を書いた endpoint の数（異なり） */
  endpoints: number;
  /** 書いた sighting の数 */
  sightings: number;
  /** 読めなかったファイル（モジュール）の数 */
  skipped: number;
}

interface Module {
  raw: ArtifactFile;
  file: ArtifactFile;
  /** raw の中でのモジュールの開始バイト */
  offset: number;
}

/** endpoint 1 つ分の書き込み（同じ呼び出しから複数の origin の endpoint が出ることがある） */
interface Sighting {
  protocol: Protocol;
  origin: string;
  method: string;
  pathNorm: string;
  pathTemplate: string;
  params: EndpointParam[];
  startByte: number;
  endByte: number;
}

const GRAPHQL_PATH_RE = /\/(graphql|gql)$/i;
/** GraphQL の本文の封筒（パラメータとしては意味が無い） */
const GRAPHQL_ENVELOPE = new Set(['query', 'variables', 'operationName', 'extensions']);

export async function extractEndpoints(ctx: SaContext, opts: ExtractEndpointsOptions): Promise<ExtractEndpointsResult> {
  const version = getArtifactVersion(ctx, opts.versionId);
  if (!version) throw new SaError('NOT_FOUND', `artifact_version not found: ${opts.versionId}`);

  const skips = new SkipLog();
  const modules = collectModules(ctx, opts.versionId, skips);
  // unpack_bundle がパースできなかった raw（collectModules がスキップに積んだもの）
  const unparsed = skips.filesSkipped;
  const runId = startAnalysisRun(ctx, {
    versionId: opts.versionId,
    kind: 'engine',
    tool: 'extract_endpoints',
    toolVersion: `sa-core ${CORE_VERSION}; @babel/parser ${BABEL_PARSER_VERSION}; extractors ast_url`,
    inputLayer: 'unpacked',
  });

  const results = await Promise.all(
    modules.map((m) => ctx.jobs.runWorker(endpointsWorker, { bytes: ctx.store.get(m.file.contentHash) }, ctx.config.workerLimits)),
  );

  const out: ExtractEndpointsResult = { runId, modules: modules.length, calls: 0, dropped: 0, endpoints: 0, sightings: 0, skipped: 0 };
  // raw ファイルごとにまとめて書く（位置の行・列は raw を 1 回走査して求める）
  const byRaw = new Map<string, { raw: ArtifactFile; complete: boolean; sightings: Sighting[] }>();
  modules.forEach((m, i) => {
    const r = results[i]!;
    const entry = byRaw.get(m.raw.id) ?? { raw: m.raw, complete: true, sightings: [] };
    byRaw.set(m.raw.id, entry);
    if (!skips.record(r, { fileId: m.file.id })) {
      entry.complete = false;
      out.skipped++;
      return;
    }
    const origins = pageOrigins(m.raw);
    for (const call of r.value.calls) {
      out.calls++;
      const s = toSightings(call, origins, m.offset);
      if (s.length === 0) out.dropped++;
      entry.sightings.push(...s);
    }
  });

  const endpointIds = new Set<string>();
  for (const { raw, complete, sightings } of byRaw.values()) {
    const positions =
      sightings.length > 0 ? displayPositions(ctx.store.get(raw.contentHash), sightings.map((s) => s.startByte)) : new Map();
    withTxn(ctx, () => {
      if (complete) deleteSightingsInRawFile(ctx, { versionId: opts.versionId, rawFileId: raw.id, extractedBy: 'ast_url' });
      for (const s of sightings) {
        const { line, col } = positions.get(s.startByte)!;
        const locationId = ensureCodeLocation(ctx, { rawFileId: raw.id, startByte: s.startByte, endByte: s.endByte, line, col });
        const endpointId = upsertEndpoint(ctx, {
          targetId: version.targetId,
          protocol: s.protocol,
          origin: s.origin,
          method: s.method,
          pathNorm: s.pathNorm,
          pathTemplate: s.pathTemplate,
          operation: '',
        });
        upsertSighting(ctx, { endpointId, versionId: opts.versionId, locationId, params: s.params, extractedBy: 'ast_url', runId });
        endpointIds.add(endpointId);
      }
    });
    out.sightings += sightings.length;
  }
  out.endpoints = endpointIds.size;

  const { filesSkipped, skippedDetail } = skips.summary();
  const filesTotal = modules.length + unparsed;
  finishAnalysisRun(ctx, runId, { filesTotal, filesAnalyzed: filesTotal - filesSkipped, filesSkipped, skippedDetail });
  return out;
}

/** 版の JS をモジュールの並びにする。unpack_bundle がパースできなかった raw はスキップに数える */
function collectModules(ctx: SaContext, versionId: string, skips: SkipLog): Module[] {
  const unpacked = new Map<string, ArtifactFile[]>();
  for (const u of listArtifactFiles(ctx, { versionId, layer: 'unpacked', kind: 'js' })) {
    const list = unpacked.get(u.parentFileId!) ?? [];
    list.push(u);
    unpacked.set(u.parentFileId!, list);
  }
  const modules: Module[] = [];
  for (const raw of listArtifactFiles(ctx, { versionId, layer: 'raw', kind: 'js' })) {
    if (raw.parseStatus !== 'ok') {
      skips.add(raw.parseStatus === 'timeout' ? 'timeout' : 'parse_failed', {
        fileId: raw.id,
        detail: `unpack_bundle could not parse this file (${raw.parseStatus})`,
      });
      continue;
    }
    const children = unpacked.get(raw.id);
    if (children) modules.push(...children.map((u) => ({ raw, file: u, offset: u.rawOffset ?? 0 })));
    else modules.push({ raw, file: raw, offset: 0 });
  }
  return modules;
}

/** script を読み込んだ文書のオリジン（http(s) だけ。重複を除く） */
function pageOrigins(raw: ArtifactFile): string[] {
  const origins = new Set<string>();
  for (const url of raw.loadedByOrigins ?? []) {
    const n = normalizeEndpointUrl(url);
    if (n && (n.scheme === 'http' || n.scheme === 'https')) origins.add(n.origin);
  }
  return [...origins];
}

function toSightings(call: ExtractedCall, pageOrigins: string[], offset: number): Sighting[] {
  const n = normalizeEndpointUrl(call.url);
  if (!n) return [];
  // パスに固定の部分が 1 つも無く、origin も分からないものは手掛かりにならない（fetch(base + "/") など）
  if (n.origin === '' && !n.pathNorm.split('/').some((seg) => seg !== '' && seg !== '{}')) return [];

  const websocket = call.websocket || n.scheme === 'ws' || n.scheme === 'wss';
  const protocol: Protocol = websocket ? 'websocket' : GRAPHQL_PATH_RE.test(n.pathNorm) ? 'graphql' : 'rest';
  const params = uniqueParams([
    ...n.pathParams.map((name) => ({ name, in: 'path' as const })),
    ...n.queryParams.map((name) => ({ name, in: 'query' as const })),
    ...call.params.filter((p) => !(protocol === 'graphql' && p.in === 'body' && GRAPHQL_ENVELOPE.has(p.name))),
  ]);
  const origins = n.origin !== '' ? [n.origin] : pageOrigins.length > 0 ? pageOrigins.map((o) => (websocket ? toWsOrigin(o) : o)) : [''];
  return origins.map((origin) => ({
    protocol,
    origin,
    method: websocket ? '' : call.method,
    pathNorm: n.pathNorm,
    pathTemplate: n.pathTemplate,
    params,
    startByte: offset + call.startByte,
    endByte: offset + call.endByte,
  }));
}

/** 相対 URL の WebSocket は文書のオリジンのスキームを ws(s) にしたもの */
function toWsOrigin(origin: string): string {
  return origin.replace(/^http(s?):/, 'ws$1:');
}

function uniqueParams(params: EndpointParam[]): EndpointParam[] {
  const seen = new Set<string>();
  return params.filter((p) => {
    const key = `${p.in}\u0000${p.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
