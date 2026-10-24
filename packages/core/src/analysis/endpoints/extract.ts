/**
 * extract_endpoints（design.md §6.2・§7.3、計画書 M2）: 版の JS から api_endpoint / endpoint_sighting を作る。
 * 抽出器ごとに analysis_run を 1 行作り（tool は extract_endpoints/<抽出器>）、sighting の extracted_by に抽出器名を入れる。
 * - ast_url（Babel AST。babel.ts）: いつでも使える
 * - jsluice（Go の外部ツール。jsluice.ts）: 設定（tools.jsluice か SA_TOOLS）があるときだけ。無ければ unavailable に入れる
 * - graphql（Babel AST＋graphql-js。babel.ts）: sighting の extracted_by は graphql_text / graphql_ast / relay。
 *   operation の送信先を、先に書いた ast_url・jsluice の GraphQL のエンドポイントから決めるので最後に書く
 * 正規化・origin の補完・掛け直しの扱いは抽出器に共通（sightings.ts）。
 */
import type { SaContext } from '../../context';
import { getArtifactVersion } from '../../db/repo/artifactVersion';
import { SaError } from '../../errors';
import { runBabel } from './babel';
import { runJsluice } from './jsluice';
import type { ExtractorRun, ExtractorStats } from './sightings';

export type { ExtractorStats } from './sightings';

/** いま実装している抽出器（既定ではこの順にすべて掛ける。graphql の sighting は graphql_text / graphql_ast / relay） */
export const CODE_EXTRACTORS = ['ast_url', 'jsluice', 'graphql'] as const;
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
  const record = (e: CodeExtractor, run: ExtractorRun): void => {
    out.extractors[e] = run.stats;
    out.sightings += run.stats.sightings;
    for (const id of run.endpointIds) endpointIds.add(id);
  };
  // Babel のパースは ast_url と graphql で 1 回にする
  const babel = await runBabel(ctx, version, { astUrl: requested.includes('ast_url'), graphql: requested.includes('graphql') });
  if (babel.writeAstUrl) record('ast_url', babel.writeAstUrl());
  if (requested.includes('jsluice')) {
    if (jsluice) record('jsluice', await runJsluice(ctx, version, jsluice));
    else out.unavailable.push('jsluice');
  }
  if (babel.writeGraphql) record('graphql', babel.writeGraphql());
  out.endpoints = endpointIds.size;
  return out;
}
