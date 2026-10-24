/**
 * import_sourcemap（design.md §6.6・§7.1、計画書 M1）: sourcemap を簡易検証し、通れば original 層を作る。
 * - 検証は worker（jobs/workers/sourcemap.worker.ts）。一致率を map の行の map_check に記録する
 * - 一致率が閾値（SaConfig.mapCheckThreshold）未満なら original 層を作らない（別ビルドの map の可能性。人間に返す）
 * - original は sources[i] ごとに 1 行。親は map の生成元の raw、position_map_hash は map 自身の content_hash。
 *   パスは sources 名を正規化して <version_id>/original/<map_file_id>/ の下に置き、相対構造を保つ（原則8・§6.6）
 * - sourcesContent の無い sources は作れない（no_source_content）。正規化できない名前は path_excluded として記録する
 * 冪等: 同じ map から作った original が既にあれば作り直さずに返す。
 */
import type { MapCheck, Ownership } from '@sa/types';
import type { SaContext } from '../context';
import { withTxn } from '../db/connection';
import { finishAnalysisRun, startAnalysisRun } from '../db/repo/analysisRun';
import {
  type ArtifactFile,
  getArtifactFile,
  insertArtifactFile,
  listArtifactFiles,
  updateArtifactFile,
} from '../db/repo/artifactFile';
import { getArtifactVersion } from '../db/repo/artifactVersion';
import { SaError, isSaError } from '../errors';
import { newId } from '../ids';
import { SkipLog } from '../jobs/skips';
import { sourcemapWorker } from '../jobs/workers';
import { assertWithinWorkspace, generateOriginalSourcePath } from '../policy/paths';
import { CORE_VERSION } from '../version';

/** 簡易検証で調べる names 付きセグメントの数の上限 */
const SAMPLE_LIMIT = 500;

export interface ImportSourcemapOptions {
  versionId: string;
  /** raw 層の sourcemap ファイル */
  mapFileId: string;
  /** map の生成元の raw JS。省けば sourceMappingURL かファイル名（<name>.map と <name>）で探す */
  generatedFileId?: string;
}

export interface ImportSourcemapResult {
  /** 既存の original を返しただけのときは無い */
  runId?: string;
  generatedFileId: string;
  /** map を読めなかったときは null */
  mapCheck: MapCheck | null;
  accepted: boolean;
  originalFileIds: string[];
}

export async function importSourcemap(ctx: SaContext, opts: ImportSourcemapOptions): Promise<ImportSourcemapResult> {
  if (!getArtifactVersion(ctx, opts.versionId)) throw new SaError('NOT_FOUND', `artifact_version not found: ${opts.versionId}`);
  const map = getArtifactFile(ctx, opts.mapFileId);
  if (!map || map.versionId !== opts.versionId) throw new SaError('NOT_FOUND', `sourcemap file not found in the version: ${opts.mapFileId}`);
  if (map.layer !== 'raw' || map.kind !== 'sourcemap') throw new SaError('INVALID_INPUT', `${opts.mapFileId} is not a raw sourcemap file`);
  const generated = resolveGenerated(ctx, map, opts.generatedFileId);

  const existing = listArtifactFiles(ctx, { versionId: opts.versionId, layer: 'original', parentFileId: generated.id }).filter(
    (f) => f.positionMapHash === map.contentHash,
  );
  if (existing.length > 0) {
    return { generatedFileId: generated.id, mapCheck: map.mapCheck, accepted: true, originalFileIds: existing.map((f) => f.id) };
  }

  const runId = startAnalysisRun(ctx, {
    versionId: opts.versionId,
    kind: 'ingest',
    tool: 'import_sourcemap',
    toolVersion: `sa-core ${CORE_VERSION}`,
    inputLayer: 'raw',
  });
  const skips = new SkipLog();
  const finish = (originalFileIds: string[], mapCheck: MapCheck | null): ImportSourcemapResult => {
    const { filesSkipped, skippedDetail } = skips.summary();
    finishAnalysisRun(ctx, runId, { filesTotal: 1, filesAnalyzed: 1 - filesSkipped, filesSkipped, skippedDetail });
    return { runId, generatedFileId: generated.id, mapCheck, accepted: mapCheck?.accepted ?? false, originalFileIds };
  };

  const r = await ctx.jobs.runWorker(
    sourcemapWorker,
    { map: ctx.store.get(map.contentHash), generated: ctx.store.get(generated.contentHash), sampleLimit: SAMPLE_LIMIT },
    ctx.config.workerLimits,
  );
  if (!skips.record(r, { fileId: map.id })) {
    if (r.reason === 'parse_failed') updateArtifactFile(ctx, map.id, { parseStatus: 'parse_failed' });
    return finish([], null);
  }

  const { check, sources } = r.value;
  const threshold = ctx.config.mapCheckThreshold;
  const rate = check.sampled === 0 ? 0 : Math.round((check.matched / check.sampled) * 10_000) / 10_000;
  const mapCheck: MapCheck = { ...check, rate, threshold, accepted: check.sampled > 0 && rate >= threshold };
  if (!mapCheck.accepted) {
    updateArtifactFile(ctx, map.id, { mapCheck });
    return finish([], mapCheck);
  }

  // パスを決めて中身を blob に置くまではトランザクションの外
  const byPath = new Map<string, { hash: string; name: string; ownership: Ownership }>();
  for (const s of sources) {
    const label = s.name === '' ? `sources[${s.index}]` : s.name;
    if (s.content === null) {
      skips.add('no_source_content', { ref: label });
      continue;
    }
    let relPath: string;
    try {
      relPath = generateOriginalSourcePath(ctx.config.workspaceDir, {
        versionId: opts.versionId,
        mapFileId: map.id,
        sourceName: s.name,
      }).relPath;
    } catch (err) {
      if (isSaError(err) && (err.code === 'INVALID_INPUT' || err.code === 'POLICY_DENIED')) {
        skips.add('path_excluded', { ref: label, detail: err.message });
        continue;
      }
      throw err;
    }
    const { hash } = ctx.store.put(Buffer.from(s.content, 'utf8'));
    const ownership: Ownership =
      s.ignored || /(^|\/)node_modules\//.test(relPath) ? 'vendored_lib' : (generated.ownership ?? 'unknown');
    const path = uniquePath(ctx.config.workspaceDir, relPath, hash, byPath);
    if (path !== undefined) byPath.set(path, { hash, name: s.name, ownership });
  }

  const originalFileIds = withTxn(ctx, () => {
    const ids = [...byPath].map(([path, f]) => {
      const id = newId();
      insertArtifactFile(ctx, {
        id,
        versionId: opts.versionId,
        layer: 'original',
        kind: 'js',
        path,
        origName: f.name,
        contentHash: f.hash,
        parentFileId: generated.id,
        positionMapHash: map.contentHash,
        ownership: f.ownership,
      });
      return id;
    });
    updateArtifactFile(ctx, map.id, { mapCheck });
    return ids;
  });
  return finish(originalFileIds, mapCheck);
}

/**
 * 違う sources 名が同じパスに正規化されたとき（a.vue?type=script と ?type=template など）:
 * 中身も同じなら 1 つにまとめ（undefined を返す）、違えば name~2.ext, name~3.ext … と名前を変える。
 */
function uniquePath(
  workspaceDir: string,
  relPath: string,
  hash: string,
  taken: Map<string, { hash: string }>,
): string | undefined {
  const slash = relPath.lastIndexOf('/');
  const dot = relPath.lastIndexOf('.');
  const [stem, ext] = dot > slash + 1 ? [relPath.slice(0, dot), relPath.slice(dot)] : [relPath, ''];
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? relPath : `${stem}~${n}${ext}`;
    const prev = taken.get(candidate);
    if (prev === undefined) {
      if (n > 1) assertWithinWorkspace(workspaceDir, candidate);
      return candidate;
    }
    if (prev.hash === hash) return undefined;
  }
}

/** map の生成元の raw JS を決める。明示されなければ sourceMappingURL、次にファイル名で探し、一意に決まらなければ指定を求める */
function resolveGenerated(ctx: SaContext, map: ArtifactFile, generatedFileId: string | undefined): ArtifactFile {
  if (generatedFileId !== undefined) {
    const g = getArtifactFile(ctx, generatedFileId);
    if (!g || g.versionId !== map.versionId || g.layer !== 'raw' || g.kind !== 'js') {
      throw new SaError('INVALID_INPUT', `${generatedFileId} is not a raw JS file in the version`);
    }
    return g;
  }
  const mapName = map.origName ?? '';
  const candidates = listArtifactFiles(ctx, { versionId: map.versionId, layer: 'raw', kind: 'js' });
  const byUrl = candidates.filter((c) => {
    const url = sourceMappingUrlOf(ctx.store.get(c.contentHash));
    return url !== undefined && lastSegment(url) === mapName;
  });
  const matches = byUrl.length > 0 ? byUrl : candidates.filter((c) => mapName.endsWith('.map') && c.origName === mapName.slice(0, -4));
  if (matches.length === 1) return matches[0]!;
  throw new SaError(
    'INVALID_INPUT',
    matches.length === 0
      ? `cannot find the generated file for ${mapName}; pass generatedFileId`
      : `several files reference ${mapName}; pass generatedFileId`,
    { mapFileId: map.id, candidates: matches.map((m) => m.id) },
  );
}

/** ファイル末尾の //# sourceMappingURL=... （/*# ... *\/ も）を返す */
function sourceMappingUrlOf(bytes: Uint8Array): string | undefined {
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.byteLength - 4096))).toString('utf8');
  return /[#@]\s*sourceMappingURL=([^\s'"*]+)\s*(?:\*\/)?\s*$/.exec(tail)?.[1];
}

function lastSegment(url: string): string {
  const path = url.replace(/[?#].*$/s, '');
  return path.slice(path.lastIndexOf('/') + 1);
}
