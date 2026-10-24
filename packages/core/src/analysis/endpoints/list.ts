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
  /** sighting が 1 つも無い endpoint（抽出器の掛け直しで消えたもの）も返す（既定 false） */
  includeUnseen?: boolean;
}

export function listEndpoints(ctx: SaContext, opts: ListEndpointsOptions): EndpointListItem[] {
  return listEndpointSummaries(ctx, opts.targetId)
    .filter((e) => opts.includeUnseen === true || e.sightings > 0)
    .map((e) => ({ ...e, params: endpointParams(ctx, e.id) }));
}
