/**
 * extract_endpoints（design.md §6.2・§7.3、計画書 M2）: 版の JS から api_endpoint / endpoint_sighting を作る。
 * 抽出器ごとに analysis_run を 1 行作り（tool は extract_endpoints/<抽出器>）、sighting の extracted_by に抽出器名を入れる。
 * - ast_url（Babel AST。astUrl.ts）: いつでも使える
 * - jsluice（Go の外部ツール。jsluice.ts）: 設定（tools.jsluice か SA_TOOLS）があるときだけ。無ければ unavailable に入れる
 * GraphQL の抽出器は PR-10 で足す。正規化・origin の補完・掛け直しの扱いは抽出器に共通（sightings.ts）。
 */
import type { EndpointExtractor } from '@sa/types';
import type { SaContext } from '../../context';
import { getArtifactVersion } from '../../db/repo/artifactVersion';
import { SaError } from '../../errors';
import { runAstUrl } from './astUrl';
import { runJsluice } from './jsluice';
import type { ExtractorRun, ExtractorStats } from './sightings';

export type { ExtractorStats } from './sightings';

/** いま実装している抽出器（既定ではこの順にすべて掛ける） */
export const CODE_EXTRACTORS = ['ast_url', 'jsluice'] as const satisfies readonly EndpointExtractor[];
export type CodeExtractor = (typeof CODE_EXTRACTORS)[number];

export interface ExtractEndpointsOptions {
  versionId: string;
  /** 掛ける抽出器。省けば使えるものすべて。明示した抽出器が使えなければ誤り */
  extractors?: CodeExtractor[];
}

export interface ExtractEndpointsResult {
  versionId: string;
  extractors: Partial<Record<CodeExtractor, ExtractorStats>>;
  /** 設定が無くて掛けられなかった抽出器 */
  unavailable: CodeExtractor[];
  /** この実行で sighting を書いた endpoint の数（抽出器をまたいだ異なり） */
  endpoints: number;
  sightings: number;
}

export async function extractEndpoints(ctx: SaContext, opts: ExtractEndpointsOptions): Promise<ExtractEndpointsResult> {
  const version = getArtifactVersion(ctx, opts.versionId);
  if (!version) throw new SaError('NOT_FOUND', `artifact_version not found: ${opts.versionId}`);
  const requested = opts.extractors ?? CODE_EXTRACTORS;
  for (const e of requested) {
    if (!(CODE_EXTRACTORS as readonly string[]).includes(e)) throw new SaError('INVALID_INPUT', `unknown extractor: ${e}`);
  }
  const jsluice = ctx.config.tools.jsluice;
  if (opts.extractors?.includes('jsluice') && !jsluice) {
    throw new SaError('INVALID_INPUT', 'jsluice is not configured (set tools.jsluice in config.json or SA_TOOLS)');
  }

  const out: ExtractEndpointsResult = { versionId: version.id, extractors: {}, unavailable: [], endpoints: 0, sightings: 0 };
  const endpointIds = new Set<string>();
  for (const e of CODE_EXTRACTORS) {
    if (!requested.includes(e)) continue;
    let run: ExtractorRun;
    if (e === 'ast_url') run = await runAstUrl(ctx, version);
    else if (jsluice) run = await runJsluice(ctx, version, jsluice);
    else {
      out.unavailable.push(e);
      continue;
    }
    out.extractors[e] = run.stats;
    out.sightings += run.stats.sightings;
    for (const id of run.endpointIds) endpointIds.add(id);
  }
  out.endpoints = endpointIds.size;
  return out;
}
