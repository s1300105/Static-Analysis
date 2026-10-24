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
