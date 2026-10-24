/**
 * ast_url 抽出器（design.md §7.3 extract_endpoints の 2）: JS の HTTP クライアント呼び出しから候補を作る。
 * - パースと呼び出しの認識は worker（jobs/workers/endpoints.worker.ts）。raw の JS をファイルごと読み、unpack が切り出した
 *   モジュール（unpacked）の範囲を渡す（ベース URL と変数の値は範囲ごとに扱う）。ファイルごと読むのは、webpack の
 *   ランタイムに埋め込まれたエントリ（モジュールマップの外）も読むため
 * - unpack_bundle がパースできなかった raw はスキップに数える（jsluice は tree-sitter なので読める）
 * - 位置は呼び出し式の raw 基準のバイト範囲
 */
import type { SaContext } from '../../context';
import { finishAnalysisRun, startAnalysisRun } from '../../db/repo/analysisRun';
import { listArtifactFiles } from '../../db/repo/artifactFile';
import type { ArtifactVersion } from '../../db/repo/artifactVersion';
import { SkipLog } from '../../jobs/skips';
import { BABEL_PARSER_VERSION, endpointsWorker } from '../../jobs/workers';
import { CORE_VERSION } from '../../version';
import { type ExtractorRun, type RawCandidates, writeSightings } from './sightings';

export async function runAstUrl(ctx: SaContext, version: ArtifactVersion): Promise<ExtractorRun> {
  const skips = new SkipLog();
  const raws = listArtifactFiles(ctx, { versionId: version.id, layer: 'raw', kind: 'js' });
  const readable = raws.filter((raw) => {
    if (raw.parseStatus === 'ok') return true;
    skips.add(raw.parseStatus === 'timeout' ? 'timeout' : 'parse_failed', {
      fileId: raw.id,
      detail: `unpack_bundle could not parse this file (${raw.parseStatus})`,
    });
    return false;
  });
  // raw ごとのモジュールの範囲（unpack を掛けていなければ無し = ファイル全体が 1 つ）
  const modules = new Map<string, { start: number; end: number }[]>();
  for (const u of listArtifactFiles(ctx, { versionId: version.id, layer: 'unpacked', kind: 'js' })) {
    const start = u.rawOffset ?? 0;
    const list = modules.get(u.parentFileId!) ?? [];
    list.push({ start, end: start + ctx.store.sizeOf(u.contentHash) });
    modules.set(u.parentFileId!, list);
  }

  const runId = startAnalysisRun(ctx, {
    versionId: version.id,
    kind: 'engine',
    tool: 'extract_endpoints/ast_url',
    toolVersion: `sa-core ${CORE_VERSION}; @babel/parser ${BABEL_PARSER_VERSION}`,
    inputLayer: 'raw',
  });
  const results = await Promise.all(
    readable.map((raw) =>
      ctx.jobs.runWorker(
        endpointsWorker,
        { bytes: ctx.store.get(raw.contentHash), modules: modules.get(raw.id) ?? [] },
        ctx.config.workerLimits,
      ),
    ),
  );

  let found = 0;
  let failed = 0;
  const byRaw: RawCandidates[] = readable.map((raw, i) => {
    const r = results[i]!;
    if (!skips.record(r, { fileId: raw.id })) {
      failed++;
      return { raw, complete: false, candidates: [] };
    }
    found += r.value.calls.length;
    return { raw, complete: true, candidates: r.value.calls };
  });

  const written = writeSightings(ctx, { versionId: version.id, targetId: version.targetId, extractor: 'ast_url', runId, raws: byRaw });
  const { filesSkipped, skippedDetail } = skips.summary();
  finishAnalysisRun(ctx, runId, { filesTotal: raws.length, filesAnalyzed: raws.length - filesSkipped, filesSkipped, skippedDetail });
  return {
    stats: { runId, inputs: raws.length, found, dropped: written.dropped, sightings: written.sightings, skipped: failed + raws.length - readable.length },
    endpointIds: written.endpointIds,
  };
}
