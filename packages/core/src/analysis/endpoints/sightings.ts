/**
 * 抽出器に共通の後半（design.md §6.2）: 呼び出しの候補（URL・メソッド・パラメータ・raw のバイト範囲）を path_norm に正規化し、
 * raw ファイルごとに code_location / api_endpoint / endpoint_sighting へ書く。
 * - URL は normalizeEndpointUrl で path_norm にする。パスに固定の部分が無く origin も無いもの、http(s)・ws(s) 以外は捨てる（dropped）
 * - 相対 URL の origin は、その script を読み込んだ文書のオリジン（raw の loaded_by_origins）で補う。
 *   複数あればそれぞれの origin の endpoint にする。分からなければ ''。相対の WebSocket は ws(s) にする
 * - 掛け直し: その抽出器が raw を全部読めたら、その raw にある同じ抽出器の sighting を作り直す（消えた呼び出しを残さない）。
 *   読めなかった部分があれば前回の sighting を消さずに足すだけにする。api_endpoint（triage を持つ）は消さない
 */
import type { EndpointExtractor, EndpointParam, Protocol } from '@sa/types';
import { displayPositions } from '../../artifact/position';
import type { SaContext } from '../../context';
import { withTxn } from '../../db/connection';
import type { ArtifactFile } from '../../db/repo/artifactFile';
import { ensureCodeLocation } from '../../db/repo/codeLocation';
import { deleteSightingsInRawFile, upsertEndpoint, upsertSighting } from '../../db/repo/endpoint';
import { normalizeEndpointUrl } from './normalize';

/** 抽出器が見つけた呼び出し 1 つ（位置は raw 基準） */
export interface EndpointCandidate {
  /** normalizeEndpointUrl に渡す形（可変部分は {name}・{}・EXPR） */
  url: string;
  /** 大文字。不明は '' */
  method: string;
  websocket: boolean;
  params: EndpointParam[];
  startByte: number;
  endByte: number;
}

/** raw ファイル 1 つ分の抽出結果 */
export interface RawCandidates {
  raw: ArtifactFile;
  /** 抽出器がこの raw を全部読めたか（false なら前回の sighting を残す） */
  complete: boolean;
  candidates: EndpointCandidate[];
}

export interface WriteResult {
  sightings: number;
  /** URL を正規化できずに捨てた候補の数 */
  dropped: number;
  endpointIds: Set<string>;
}

export interface ExtractorStats {
  runId: string;
  /** 読んだ入力の数（ast_url はモジュール、jsluice は raw ファイル） */
  inputs: number;
  /** 見つけた呼び出し・一致の数 */
  found: number;
  /** URL を使えずに捨てた数 */
  dropped: number;
  /** 書いた sighting の数 */
  sightings: number;
  /** 読めなかった入力の数 */
  skipped: number;
}

/** 抽出器 1 つの実行結果（astUrl.ts・jsluice.ts が返す） */
export interface ExtractorRun {
  stats: ExtractorStats;
  endpointIds: Set<string>;
}

/** 書き込みの単位（同じ候補から origin ごとに複数できることがある） */
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

export function writeSightings(
  ctx: SaContext,
  w: { versionId: string; targetId: string; extractor: EndpointExtractor; runId: string; raws: Iterable<RawCandidates> },
): WriteResult {
  const out: WriteResult = { sightings: 0, dropped: 0, endpointIds: new Set() };
  for (const { raw, complete, candidates } of w.raws) {
    const origins = pageOrigins(raw);
    const sightings: Sighting[] = [];
    for (const c of candidates) {
      const s = toSightings(c, origins);
      if (s.length === 0) out.dropped++;
      sightings.push(...s);
    }
    // 位置の行・列は raw を 1 回走査して求める
    const positions =
      sightings.length > 0 ? displayPositions(ctx.store.get(raw.contentHash), sightings.map((s) => s.startByte)) : new Map();
    withTxn(ctx, () => {
      if (complete) deleteSightingsInRawFile(ctx, { versionId: w.versionId, rawFileId: raw.id, extractedBy: w.extractor });
      for (const s of sightings) {
        const { line, col } = positions.get(s.startByte)!;
        const locationId = ensureCodeLocation(ctx, { rawFileId: raw.id, startByte: s.startByte, endByte: s.endByte, line, col });
        const endpointId = upsertEndpoint(ctx, {
          targetId: w.targetId,
          protocol: s.protocol,
          origin: s.origin,
          method: s.method,
          pathNorm: s.pathNorm,
          pathTemplate: s.pathTemplate,
          operation: '',
        });
        upsertSighting(ctx, { endpointId, versionId: w.versionId, locationId, params: s.params, extractedBy: w.extractor, runId: w.runId });
        out.endpointIds.add(endpointId);
      }
    });
    out.sightings += sightings.length;
  }
  return out;
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

function toSightings(c: EndpointCandidate, pageOrigins: string[]): Sighting[] {
  const n = normalizeEndpointUrl(c.url);
  if (!n) return [];
  // パスに固定の部分が 1 つも無く、origin も分からないものは手掛かりにならない（fetch(base + "/") など）
  if (n.origin === '' && !n.pathNorm.split('/').some((seg) => seg !== '' && seg !== '{}')) return [];

  const websocket = c.websocket || n.scheme === 'ws' || n.scheme === 'wss';
  const protocol: Protocol = websocket ? 'websocket' : GRAPHQL_PATH_RE.test(n.pathNorm) ? 'graphql' : 'rest';
  const params = uniqueParams([
    ...n.pathParams.map((name) => ({ name, in: 'path' as const })),
    ...n.queryParams.map((name) => ({ name, in: 'query' as const })),
    ...c.params.filter((p) => !(protocol === 'graphql' && p.in === 'body' && GRAPHQL_ENVELOPE.has(p.name))),
  ]);
  const origins = n.origin !== '' ? [n.origin] : pageOrigins.length > 0 ? pageOrigins.map((o) => (websocket ? toWsOrigin(o) : o)) : [''];
  return origins.map((origin) => ({
    protocol,
    origin,
    method: websocket ? '' : c.method,
    pathNorm: n.pathNorm,
    pathTemplate: n.pathTemplate,
    params,
    startByte: c.startByte,
    endByte: c.endByte,
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
