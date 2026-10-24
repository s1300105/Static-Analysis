/**
 * Babel の AST を使う抽出器（design.md §7.3 extract_endpoints の 2・3）: ast_url（HTTP クライアントの呼び出し）と
 * graphql（graphql_text / graphql_ast / relay）。raw の JS をファイルごと worker（jobs/workers/endpoints.worker.ts）で
 * 1 回だけパースし、両方の結果を受け取る。
 * - unpack が切り出したモジュール（unpacked）の範囲を渡す（ベース URL と変数の値は範囲ごとに扱う）。ファイルごと読むのは、
 *   webpack のランタイムに埋め込まれたエントリ（モジュールマップの外）も読むため
 * - unpack_bundle がパースできなかった raw はスキップに数える（jsluice は tree-sitter なので読める）
 * - 抽出器ごとに analysis_run を作り、書き込みは抽出器ごとに分ける（extract.ts が ast_url → jsluice → graphql の順に書く。
 *   GraphQL の operation の送信先は、それまでに見つかった版の GraphQL のエンドポイントから決めるため）
 * - GraphQL の operation: protocol は graphql、method は operation の種類（QUERY / MUTATION / SUBSCRIPTION）、
 *   パラメータは変数（graphql_var）、Relay の params.id は persisted_hash。送信先（origin とパス）は、版の GraphQL の
 *   エンドポイントのパスが 1 つに決まればそれ（origin が複数ならそれぞれ）、決まらなければ ''
 */
import type { EndpointExtractor, EndpointParam } from '@sa/types';
import type { SaContext } from '../../context';
import { finishAnalysisRun, startAnalysisRun } from '../../db/repo/analysisRun';
import { type ArtifactFile, listArtifactFiles } from '../../db/repo/artifactFile';
import type { ArtifactVersion } from '../../db/repo/artifactVersion';
import { graphqlTransports } from '../../db/repo/endpoint';
import type { JobResult } from '../../jobs/runner';
import { SkipLog } from '../../jobs/skips';
import { BABEL_PARSER_VERSION, GRAPHQL_JS_VERSION, endpointsWorker } from '../../jobs/workers';
import type { EndpointsOutput, GraphqlOperation } from '../../jobs/workers/endpoints.worker';
import { CORE_VERSION } from '../../version';
import { type EndpointCandidate, type ExtractorRun, writeSightings } from './sightings';

const GRAPHQL_EXTRACTORS = ['graphql_text', 'graphql_ast', 'relay'] as const satisfies readonly EndpointExtractor[];

export interface BabelRuns {
  /** ast_url の結果を書く（runAstUrl を頼んだときだけ） */
  writeAstUrl?: () => ExtractorRun;
  /** graphql の結果を書く（頼んだときだけ。ast_url・jsluice を書いた後に呼ぶ） */
  writeGraphql?: () => ExtractorRun;
}

interface Pass {
  raws: ArtifactFile[];
  /** パースできた raw（unpack_bundle が読めなかったものを除く）と worker の結果 */
  readable: { raw: ArtifactFile; result: JobResult<EndpointsOutput> }[];
}

export async function runBabel(ctx: SaContext, version: ArtifactVersion, want: { astUrl: boolean; graphql: boolean }): Promise<BabelRuns> {
  if (!want.astUrl && !want.graphql) return {};
  const start = (extractor: string, toolVersion: string) =>
    startAnalysisRun(ctx, { versionId: version.id, kind: 'engine', tool: `extract_endpoints/${extractor}`, toolVersion, inputLayer: 'raw' });
  const babel = `sa-core ${CORE_VERSION}; @babel/parser ${BABEL_PARSER_VERSION}`;
  const astUrlRun = want.astUrl ? start('ast_url', babel) : undefined;
  const graphqlRun = want.graphql ? start('graphql', `${babel}; graphql ${GRAPHQL_JS_VERSION}`) : undefined;
  const pass = await parse(ctx, version, want);

  const runs: BabelRuns = {};
  if (astUrlRun !== undefined) {
    runs.writeAstUrl = () => {
      const { skips, byRaw, failed } = collect(pass, (out) => out.calls);
      const written = writeSightings(ctx, { versionId: version.id, targetId: version.targetId, extractor: 'ast_url', runId: astUrlRun, raws: byRaw });
      const found = byRaw.reduce((n, r) => n + r.candidates.length, 0);
      finish(astUrlRun, pass, skips);
      return {
        stats: { runId: astUrlRun, inputs: pass.raws.length, found, dropped: written.dropped, sightings: written.sightings, skipped: failed },
        endpointIds: written.endpointIds,
      };
    };
  }
  if (graphqlRun !== undefined) {
    runs.writeGraphql = () => {
      const transports = transportUrls(ctx, version.id);
      const { skips, byRaw, failed } = collect(pass, (out) => out.graphql);
      const stats = { runId: graphqlRun, inputs: pass.raws.length, found: 0, dropped: 0, sightings: 0, skipped: failed };
      const endpointIds = new Set<string>();
      for (const extractor of GRAPHQL_EXTRACTORS) {
        const raws = byRaw.map((r) => ({
          raw: r.raw,
          complete: r.complete,
          candidates: r.candidates.filter((op) => op.extractor === extractor).flatMap((op) => operationCandidates(op, transports)),
        }));
        const written = writeSightings(ctx, { versionId: version.id, targetId: version.targetId, extractor, runId: graphqlRun, raws });
        stats.dropped += written.dropped;
        stats.sightings += written.sightings;
        for (const id of written.endpointIds) endpointIds.add(id);
      }
      stats.found = byRaw.reduce((n, r) => n + r.candidates.length, 0);
      finish(graphqlRun, pass, skips);
      return { stats, endpointIds };
    };
  }
  return runs;

  function finish(runId: string, p: Pass, skips: SkipLog): void {
    const { filesSkipped, skippedDetail } = skips.summary();
    finishAnalysisRun(ctx, runId, { filesTotal: p.raws.length, filesAnalyzed: p.raws.length - filesSkipped, filesSkipped, skippedDetail });
  }
}

/** raw ごとに worker でパースする（unpack_bundle が読めなかった raw は掛けない） */
async function parse(ctx: SaContext, version: ArtifactVersion, want: { astUrl: boolean; graphql: boolean }): Promise<Pass> {
  const raws = listArtifactFiles(ctx, { versionId: version.id, layer: 'raw', kind: 'js' });
  const modules = moduleRanges(ctx, version.id);
  const readable = raws.filter((raw) => raw.parseStatus === 'ok');
  const results = await Promise.all(
    readable.map((raw) =>
      ctx.jobs.runWorker(
        endpointsWorker,
        { bytes: ctx.store.get(raw.contentHash), modules: modules.get(raw.id) ?? [], rest: want.astUrl, graphql: want.graphql },
        ctx.config.workerLimits,
      ),
    ),
  );
  return { raws, readable: readable.map((raw, i) => ({ raw, result: results[i]! })) };
}

/** raw ごとの unpack が切り出したモジュールの範囲（raw のバイト位置。unpack を掛けていなければ無し = ファイル全体が 1 つ） */
export function moduleRanges(ctx: SaContext, versionId: string): Map<string, { start: number; end: number }[]> {
  const modules = new Map<string, { start: number; end: number }[]>();
  for (const u of listArtifactFiles(ctx, { versionId, layer: 'unpacked', kind: 'js' })) {
    const start = u.rawOffset ?? 0;
    const list = modules.get(u.parentFileId!) ?? [];
    list.push({ start, end: start + ctx.store.sizeOf(u.contentHash) });
    modules.set(u.parentFileId!, list);
  }
  return modules;
}

/** 実行ごとのスキップ（unpack_bundle が読めなかった raw・worker の失敗）と、raw ごとの結果 */
function collect<T extends { startByte: number; endByte: number }>(
  pass: Pass,
  pick: (out: EndpointsOutput) => T[],
): { skips: SkipLog; byRaw: { raw: ArtifactFile; complete: boolean; candidates: T[] }[]; failed: number } {
  const skips = new SkipLog();
  for (const raw of pass.raws) {
    if (raw.parseStatus === 'ok') continue;
    skips.add(raw.parseStatus === 'timeout' ? 'timeout' : 'parse_failed', {
      fileId: raw.id,
      detail: `unpack_bundle could not parse this file (${raw.parseStatus})`,
    });
  }
  const byRaw = pass.readable.map(({ raw, result }) =>
    skips.record(result, { fileId: raw.id })
      ? { raw, complete: true, candidates: pick(result.value) }
      : { raw, complete: false, candidates: [] as T[] },
  );
  return { skips, byRaw, failed: skips.filesSkipped };
}

/** 版の GraphQL の送信先。パスが 1 つに決まればその origin ごとの URL、決まらなければ [''] */
function transportUrls(ctx: SaContext, versionId: string): string[] {
  const transports = graphqlTransports(ctx, versionId);
  const paths = new Set(transports.map((t) => t.pathNorm));
  return paths.size === 1 ? transports.map((t) => `${t.origin}${t.pathNorm}`) : [''];
}

function operationCandidates(op: GraphqlOperation, transports: string[]): EndpointCandidate[] {
  const params: EndpointParam[] = op.variables.map((name) => ({ name, in: 'graphql_var' }));
  return transports.map((url) => ({
    url,
    method: op.kind.toUpperCase(),
    websocket: false,
    params,
    startByte: op.startByte,
    endByte: op.endByte,
    operation: { name: op.name, persistedHash: op.persistedId },
  }));
}
