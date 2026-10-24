/**
 * エンドポイントの一覧（`sa endpoints`。design.md §6.2）。派生値は VIEW api_endpoint_summary、パラメータは sighting の和集合。
 * 並び順の規則（design.md §7.3）と版間差分は diff_versions（PR-13）で足す。
 */
import type { EndpointParam } from '@sa/types';
import type { SaContext } from '../../context';
import { type EndpointSummary, endpointParams, listEndpointSummaries } from '../../db/repo/endpoint';

export type { EndpointSummary } from '../../db/repo/endpoint';

export interface EndpointListItem extends EndpointSummary {
  /** 全版・全抽出器のパラメータの和集合（置き場所・名前の順） */
  params: EndpointParam[];
}

export interface ListEndpointsOptions {
  targetId: string;
  /**
   * 既定では省くものも返す（既定 false）:
   * - sighting が 1 つも無い endpoint（抽出器の掛け直しで消えたもの）
   * - メソッド不明（''）で、同じ protocol・origin・パス・operation にメソッドの分かる endpoint があるもの
   *   （jsluice が文字列リテラルだけで見つけたパスなど。同じ API を重ねて並べない）
   */
  all?: boolean;
}

export function listEndpoints(ctx: SaContext, opts: ListEndpointsOptions): EndpointListItem[] {
  let rows = listEndpointSummaries(ctx, opts.targetId);
  if (opts.all !== true) {
    rows = rows.filter((e) => e.sightings > 0);
    const known = new Set(rows.filter((e) => e.method !== '').map(sameApi));
    rows = rows.filter((e) => e.method !== '' || !known.has(sameApi(e)));
  }
  return rows.map((e) => ({ ...e, params: endpointParams(ctx, e.id) }));
}

function sameApi(e: EndpointSummary): string {
  return JSON.stringify([e.protocol, e.origin, e.pathNorm, e.operation]);
}
