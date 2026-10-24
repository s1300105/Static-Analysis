/**
 * unpack_bundle（design.md §6.6・§7.1、計画書 M1）: raw の JS からモジュール境界を検出し、unpacked 層を作る。
 * - パースは worker（jobs/workers/unpack.worker.ts）。失敗したファイルは parse_status を付けて raw 層だけ残し、スキップに数える
 * - unpacked は raw の部分範囲をそのまま切り出す（コードは書き換えない）。raw への逆写像は raw_offset の加算だけ
 * - 境界の無い形式（ESM の出力）と認識できない形式は、ファイル全体を 1 つの unpacked にする（raw_offset=0）。
 *   認識できなかったものは no_module_boundary として記録する
 * 冪等: まだ unpack していない raw（bundler が空で parse_status=ok）だけを処理する。版にファイルを足したら掛け直せばよい。
 */
import type { Bundler, ParseStatus } from '@sa/types';
import type { SaContext } from '../context';
import { withTxn } from '../db/connection';
import { finishAnalysisRun, startAnalysisRun } from '../db/repo/analysisRun';
import { type ArtifactFile, insertArtifactFile, listArtifactFiles, updateArtifactFile } from '../db/repo/artifactFile';
import { getArtifactVersion } from '../db/repo/artifactVersion';
import { SaError } from '../errors';
import { newId } from '../ids';
import { CORE_VERSION } from '../version';
import { SkipLog } from '../jobs/skips';
import { BABEL_PARSER_VERSION, unpackWorker } from '../jobs/workers';
import { generateWorkPath } from '../policy/paths';

export interface UnpackBundleResult {
  runId: string;
  /** 処理した raw ファイルの数 */
  files: number;
  /** 作った unpacked の数 */
  moduleCount: number;
  /** バンドラ別のファイル数 */
  bundlers: Partial<Record<Bundler, number>>;
  /** 境界を検出できず、ファイル全体を 1 つにしたファイルの数 */
  noBoundaryCount: number;
  /** パースに失敗・タイムアウトしたファイルの数 */
  skipped: number;
}

export interface UnpackBundleOptions {
  versionId: string;
  /** 前回 parse_failed / timeout になったファイルも掛け直す（上限を上げたときなど） */
  retryFailed?: boolean;
}

export async function unpackBundle(ctx: SaContext, opts: UnpackBundleOptions): Promise<UnpackBundleResult> {
  if (!getArtifactVersion(ctx, opts.versionId)) throw new SaError('NOT_FOUND', `artifact_version not found: ${opts.versionId}`);

  const pending = listArtifactFiles(ctx, { versionId: opts.versionId, layer: 'raw', kind: 'js' }).filter(
    (f) => f.bundler === null && (f.parseStatus === 'ok' || opts.retryFailed === true),
  );
  const runId = startAnalysisRun(ctx, {
    versionId: opts.versionId,
    kind: 'engine',
    tool: 'unpack_bundle',
    toolVersion: `sa-core ${CORE_VERSION}; @babel/parser ${BABEL_PARSER_VERSION}`,
    inputLayer: 'raw',
  });

  const results = await Promise.all(
    pending.map((f) => ctx.jobs.runWorker(unpackWorker, { bytes: ctx.store.get(f.contentHash) }, ctx.config.workerLimits)),
  );

  const skips = new SkipLog();
  const out: UnpackBundleResult = { runId, files: pending.length, moduleCount: 0, bundlers: {}, noBoundaryCount: 0, skipped: 0 };
  pending.forEach((raw, i) => {
    const r = results[i]!;
    if (!skips.record(r, { fileId: raw.id })) {
      // 失敗はファイルの性質（構文・大きさ）として残す。tool_error（環境の問題）は残さず次の実行で掛け直す
      const status: ParseStatus | undefined =
        r.reason === 'timeout' ? 'timeout' : r.reason === 'parse_failed' || r.reason === 'oom' ? 'parse_failed' : undefined;
      if (status) updateArtifactFile(ctx, raw.id, { parseStatus: status });
      out.skipped++;
      return;
    }
    const { bundler, chunkIds, modules } = r.value;
    const bytes = ctx.store.get(raw.contentHash);
    const pieces =
      modules.length > 0
        ? modules.map((m) => ({ moduleId: m.moduleId, offset: m.startByte, data: bytes.subarray(m.startByte, m.endByte) }))
        : [{ moduleId: undefined, offset: 0, data: bytes }];
    // 中身は blob に先に置く（content_hash 名なので、後で失敗しても害が無い）
    const stored = pieces.map((p) => ({ ...p, hash: ctx.store.put(p.data).hash }));

    withTxn(ctx, () => {
      for (const p of stored) insertUnpacked(ctx, raw, p.offset, p.hash, p.moduleId);
      updateArtifactFile(ctx, raw.id, {
        bundler,
        parseStatus: 'ok',
        ...(raw.chunkKey === null && chunkIds.length > 0 && { chunkKey: chunkIds.join(',') }),
      });
    });
    out.moduleCount += stored.length;
    out.bundlers[bundler] = (out.bundlers[bundler] ?? 0) + 1;
    if (bundler === 'unknown') {
      // ファイル自体は unpacked にしたのでスキップには数えない（ref で示す）
      skips.add('no_module_boundary', { ref: raw.id, detail: 'no webpack module map found; the whole file is one unpacked module' });
      out.noBoundaryCount++;
    }
  });

  const { filesSkipped, skippedDetail } = skips.summary();
  finishAnalysisRun(ctx, runId, {
    filesTotal: pending.length,
    filesAnalyzed: pending.length - filesSkipped,
    filesSkipped,
    skippedDetail,
  });
  return out;
}

function insertUnpacked(ctx: SaContext, raw: ArtifactFile, offset: number, hash: string, moduleId: string | undefined): void {
  const id = newId();
  insertArtifactFile(ctx, {
    id,
    versionId: raw.versionId,
    layer: 'unpacked',
    kind: 'js',
    path: generateWorkPath(ctx.config.workspaceDir, { versionId: raw.versionId, layer: 'unpacked', fileId: id }).relPath,
    // モジュール ID（表示用。design.md §6.1 の orig_name はモジュール名も置く列）
    ...(moduleId !== undefined && { origName: moduleId }),
    contentHash: hash,
    parentFileId: raw.id,
    rawOffset: offset,
    ...(raw.ownership !== null && { ownership: raw.ownership }),
  });
}
