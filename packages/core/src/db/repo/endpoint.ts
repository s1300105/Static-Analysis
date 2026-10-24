/**
 * api_endpoint・endpoint_sighting のリポジトリ関数（design.md §6.2）。
 * 派生値（first/last_seen・observed_in_har・in_scope）は VIEW api_endpoint_summary から読む。
 */
import type { EndpointExtractor, EndpointParam, EndpointTriage, Protocol } from '@sa/types';
import { newId } from '../../ids';
import { type HasDb, dbCall } from '../connection';

export interface EndpointKey {
  targetId: string;
  protocol: Protocol;
  /** scheme://host[:port]。不明は '' */
  origin: string;
  /** 大文字。不明は '' */
  method: string;
  pathNorm: string;
  /** GraphQL の operation 名など。無ければ '' */
  operation: string;
}

export interface NewEndpoint extends EndpointKey {
  pathTemplate?: string;
  persistedHash?: string;
}

export interface NewSighting {
  endpointId: string;
  versionId: string;
  /** HAR 由来は省く */
  locationId?: string;
  params: EndpointParam[];
  extractedBy: EndpointExtractor;
  runId?: string;
}

export interface EndpointSummary {
  id: string;
  targetId: string;
  protocol: Protocol;
  origin: string;
  host: string;
  method: string;
  pathNorm: string;
  pathTemplate: string | null;
  operation: string;
  persistedHash: string | null;
  uiGuard: string | null;
  triage: EndpointTriage;
  triagedParamsHash: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  observedInHar: boolean;
  sightings: number;
  /** null は判定できない（origin が不明か allowed_domains が空） */
  inScope: boolean | null;
}

interface SummaryDbRow {
  id: string;
  target_id: string;
  protocol: string;
  origin: string;
  host: string;
  method: string;
  path_norm: string;
  path_template: string | null;
  operation: string;
  persisted_hash: string | null;
  ui_guard: string | null;
  triage: string | null;
  triaged_params_hash: string | null;
  first_seen: string | null;
  last_seen: string | null;
  observed_in_har: number;
  sightings: number;
  in_scope: number | null;
}

/** 同じキーの endpoint があればその ID を返し（表示用の path_template と persisted_hash は空なら埋める）、無ければ作る */
export function upsertEndpoint(ctx: HasDb, e: NewEndpoint): string {
  const row = dbCall(
    () =>
      ctx.db
        .prepare(
          `INSERT INTO api_endpoint (id, target_id, protocol, origin, method, path_norm, path_template, operation, persisted_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (target_id, protocol, origin, method, path_norm, operation) DO UPDATE SET
             path_template = coalesce(api_endpoint.path_template, excluded.path_template),
             persisted_hash = coalesce(api_endpoint.persisted_hash, excluded.persisted_hash)
           RETURNING id`,
        )
        .get(
          newId(),
          e.targetId,
          e.protocol,
          e.origin,
          e.method,
          e.pathNorm,
          e.pathTemplate ?? null,
          e.operation,
          e.persistedHash ?? null,
        ) as { id: string },
  );
  return row.id;
}

/** 同じ endpoint・版・位置・抽出器の sighting は 1 行（掛け直したらパラメータと run を新しいものにする） */
export function upsertSighting(ctx: HasDb, s: NewSighting): void {
  dbCall(() =>
    ctx.db
      .prepare(
        `INSERT INTO endpoint_sighting (id, endpoint_id, version_id, location_id, params, extracted_by, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (endpoint_id, version_id, IFNULL(location_id, ''), extracted_by) DO UPDATE SET
           params = excluded.params, run_id = excluded.run_id`,
      )
      .run(newId(), s.endpointId, s.versionId, s.locationId ?? null, JSON.stringify(s.params), s.extractedBy, s.runId ?? null),
  );
}

/**
 * 抽出器の掛け直しの前に、版の raw ファイル 1 つにある sighting を消す（抽出器の結果を作り直すため）。
 * api_endpoint は triage（人間の判断）を持つので消さない。消した数を返す
 */
export function deleteSightingsInRawFile(ctx: HasDb, q: { versionId: string; rawFileId: string; extractedBy: EndpointExtractor }): number {
  return dbCall(
    () =>
      ctx.db
        .prepare(
          `DELETE FROM endpoint_sighting
           WHERE version_id = ? AND extracted_by = ?
             AND location_id IN (SELECT id FROM code_location WHERE raw_file_id = ?)`,
        )
        .run(q.versionId, q.extractedBy, q.rawFileId).changes,
  );
}

export interface EndpointRow extends EndpointKey {
  id: string;
  persistedHash: string | null;
}

/** 対象の endpoint のキー（import_har の照合に使う。派生値は持たない） */
export function listEndpointRows(ctx: HasDb, targetId: string): EndpointRow[] {
  return dbCall(
    () =>
      ctx.db
        .prepare(
          `SELECT id, target_id AS targetId, protocol, origin, method, path_norm AS pathNorm, operation, persisted_hash AS persistedHash
           FROM api_endpoint WHERE target_id = ? ORDER BY id`,
        )
        .all(targetId) as EndpointRow[],
  );
}

/** 位置の無い sighting（HAR 由来）のパラメータ。無ければ undefined */
export function unlocatedSightingParams(
  ctx: HasDb,
  q: { endpointId: string; versionId: string; extractedBy: EndpointExtractor },
): EndpointParam[] | undefined {
  const row = dbCall(
    () =>
      ctx.db
        .prepare(
          `SELECT params FROM endpoint_sighting
           WHERE endpoint_id = ? AND version_id = ? AND location_id IS NULL AND extracted_by = ?`,
        )
        .get(q.endpointId, q.versionId, q.extractedBy) as { params: string | null } | undefined,
  );
  return row ? ((row.params === null ? [] : JSON.parse(row.params)) as EndpointParam[]) : undefined;
}

/** 人間の判断（triage）と、その時点のパラメータの集合のハッシュを書く。行が無ければ false */
export function setEndpointTriage(ctx: HasDb, endpointId: string, triage: EndpointTriage, paramsHash: string): boolean {
  return (
    dbCall(
      () =>
        ctx.db
          .prepare('UPDATE api_endpoint SET triage = ?, triaged_params_hash = ? WHERE id = ?')
          .run(triage, paramsHash, endpointId).changes,
    ) > 0
  );
}

/** 版ごとの、位置のある（静的な抽出器の）sighting。diff_versions が使う */
export interface StaticSighting {
  endpointId: string;
  params: EndpointParam[];
  /** sighting の raw の chunk_key（push のチャンク ID。カンマ区切り）。無ければ null */
  chunkKey: string | null;
}

export function listStaticSightings(ctx: HasDb, versionId: string): StaticSighting[] {
  const rows = dbCall(
    () =>
      ctx.db
        .prepare(
          `SELECT s.endpoint_id AS endpointId, s.params AS params, f.chunk_key AS chunkKey
           FROM endpoint_sighting s
           JOIN code_location l ON l.id = s.location_id
           JOIN artifact_file f ON f.id = l.raw_file_id
           WHERE s.version_id = ? AND s.extracted_by <> 'har'
           ORDER BY s.endpoint_id, s.id`,
        )
        .all(versionId) as { endpointId: string; params: string | null; chunkKey: string | null }[],
  );
  return rows.map((r) => ({
    endpointId: r.endpointId,
    params: r.params === null ? [] : (JSON.parse(r.params) as EndpointParam[]),
    chunkKey: r.chunkKey,
  }));
}

/** endpoint ごとの、静的な抽出器が最初に見つけた版の取得日時（HAR を除く） */
export function firstStaticSeen(ctx: HasDb, targetId: string): Map<string, string> {
  const rows = dbCall(
    () =>
      ctx.db
        .prepare(
          `SELECT s.endpoint_id AS endpointId, min(v.collected_at) AS firstSeen
           FROM endpoint_sighting s
           JOIN api_endpoint e ON e.id = s.endpoint_id
           JOIN artifact_version v ON v.id = s.version_id
           WHERE e.target_id = ? AND s.extracted_by <> 'har'
           GROUP BY s.endpoint_id`,
        )
        .all(targetId) as { endpointId: string; firstSeen: string }[],
  );
  return new Map(rows.map((r) => [r.endpointId, r.firstSeen]));
}

/** 版に sighting がある GraphQL のエンドポイント（operation の無い、送信先そのもの）の origin とパス */
export function graphqlTransports(ctx: HasDb, versionId: string): { origin: string; pathNorm: string }[] {
  return dbCall(
    () =>
      ctx.db
        .prepare(
          `SELECT DISTINCT e.origin AS origin, e.path_norm AS pathNorm
           FROM api_endpoint e JOIN endpoint_sighting s ON s.endpoint_id = e.id
           WHERE s.version_id = ? AND e.protocol = 'graphql' AND e.operation = ''
           ORDER BY e.path_norm, e.origin`,
        )
        .all(versionId) as { origin: string; pathNorm: string }[],
  );
}

/** 対象の endpoint を派生値つきで返す（path_norm・method・origin・operation の順） */
export function listEndpointSummaries(ctx: HasDb, targetId: string): EndpointSummary[] {
  const rows = dbCall(
    () =>
      ctx.db
        .prepare('SELECT * FROM api_endpoint_summary WHERE target_id = ? ORDER BY path_norm, method, origin, operation, protocol')
        .all(targetId) as SummaryDbRow[],
  );
  return rows.map((r) => ({
    id: r.id,
    targetId: r.target_id,
    protocol: r.protocol as Protocol,
    origin: r.origin,
    host: r.host,
    method: r.method,
    pathNorm: r.path_norm,
    pathTemplate: r.path_template,
    operation: r.operation,
    persistedHash: r.persisted_hash,
    uiGuard: r.ui_guard,
    triage: (r.triage ?? 'untested') as EndpointTriage,
    triagedParamsHash: r.triaged_params_hash,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    observedInHar: r.observed_in_har === 1,
    sightings: r.sightings,
    inScope: r.in_scope === null ? null : r.in_scope === 1,
  }));
}

/** endpoint ごとのパラメータの和集合（全版・全抽出器。名前と置き場所の組で重複を除く） */
export function endpointParams(ctx: HasDb, endpointId: string): EndpointParam[] {
  const rows = dbCall(
    () =>
      ctx.db
        .prepare(
          `SELECT DISTINCT json_extract(p.value, '$.name') AS name, json_extract(p.value, '$.in') AS loc
           FROM endpoint_sighting s, json_each(s.params) p WHERE s.endpoint_id = ? ORDER BY loc, name`,
        )
        .all(endpointId) as { name: string; loc: EndpointParam['in'] }[],
  );
  return rows.map((r) => ({ name: r.name, in: r.loc }));
}
