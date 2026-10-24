/**
 * ast_url 抽出器（design.md §7.3 extract_endpoints の 2）: JS の HTTP クライアント呼び出しから候補を作る。
 * - パースと呼び出しの認識は worker（jobs/workers/endpoints.worker.ts）。入力は unpacked のモジュール。
 *   unpack していない raw（境界の検出を掛けていないもの）はファイル全体を 1 つのモジュールとして読む
 * - unpack_bundle がパースできなかった raw はスキップに数える（jsluice は tree-sitter なので読める）
 * - 位置は呼び出し式の raw 基準のバイト範囲（unpacked の raw_offset を足す）
 */
import type { SaContext } from '../../context';
import { finishAnalysisRun, startAnalysisRun } from '../../db/repo/analysisRun';
import { type ArtifactFile, listArtifactFiles } from '../../db/repo/artifactFile';
import type { ArtifactVersion } from '../../db/repo/artifactVersion';
import { SkipLog } from '../../jobs/skips';
import { BABEL_PARSER_VERSION, endpointsWorker } from '../../jobs/workers';
import { CORE_VERSION } from '../../version';
import { type ExtractorRun, type RawCandidates, writeSightings } from './sightings';

interface Module {
  raw: ArtifactFile;
  file: ArtifactFile;
  /** raw の中でのモジュールの開始バイト */
  offset: number;
}

export async function runAstUrl(ctx: SaContext, version: ArtifactVersion): Promise<ExtractorRun> {
  const skips = new SkipLog();
  const modules = collectModules(ctx, version.id, skips);
  // unpack_bundle がパースできなかった raw（collectModules がスキップに積んだもの）
  const unparsed = skips.filesSkipped;
  const runId = startAnalysisRun(ctx, {
    versionId: version.id,
    kind: 'engine',
    tool: 'extract_endpoints/ast_url',
    toolVersion: `sa-core ${CORE_VERSION}; @babel/parser ${BABEL_PARSER_VERSION}`,
    inputLayer: 'unpacked',
  });

  const results = await Promise.all(
    modules.map((m) => ctx.jobs.runWorker(endpointsWorker, { bytes: ctx.store.get(m.file.contentHash) }, ctx.config.workerLimits)),
  );

  let found = 0;
  let failed = 0;
  const byRaw = new Map<string, RawCandidates>();
  modules.forEach((m, i) => {
    const r = results[i]!;
    const entry = byRaw.get(m.raw.id) ?? { raw: m.raw, complete: true, candidates: [] };
    byRaw.set(m.raw.id, entry);
    if (!skips.record(r, { fileId: m.file.id })) {
      entry.complete = false;
      failed++;
      return;
    }
    for (const call of r.value.calls) {
      found++;
      entry.candidates.push({ ...call, startByte: m.offset + call.startByte, endByte: m.offset + call.endByte });
    }
  });

  const written = writeSightings(ctx, { versionId: version.id, targetId: version.targetId, extractor: 'ast_url', runId, raws: byRaw.values() });
  const { filesSkipped, skippedDetail } = skips.summary();
  const filesTotal = modules.length + unparsed;
  finishAnalysisRun(ctx, runId, { filesTotal, filesAnalyzed: filesTotal - filesSkipped, filesSkipped, skippedDetail });
  return {
    stats: { runId, inputs: modules.length, found, dropped: written.dropped, sightings: written.sightings, skipped: failed + unparsed },
    endpointIds: written.endpointIds,
  };
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
