/**
 * 取り込みの一連の流れ（`sa load`）: load_artifact → unpack_bundle → 取り込んだ sourcemap ごとに import_sourcemap。
 * `sa import-har` も import_har の後に同じ流れを掛ける（HAR から取り込んだ JS・sourcemap）。
 * design.md §7.1「version_id を渡せば既存の版へファイルを追加し、その版で unpack 以降をやり直す」に当たる。
 * 入口にロジックを書かないため、並びはここで持つ。
 */
import type { ImportHarInput, LoadArtifactInput } from '@sa/types';
import type { SaContext } from '../context';
import { getArtifactFile } from '../db/repo/artifactFile';
import { type SaErrorCode, isSaError } from '../errors';
import { type ImportHarResult, importHar } from './har';
import { type LoadArtifactResult, loadArtifact } from './load';
import { type ImportSourcemapResult, importSourcemap } from './sourcemap';
import { type UnpackBundleResult, unpackBundle } from './unpack';

export interface IngestOptions {
  /** unpack_bundle を掛ける（既定 true） */
  unpack?: boolean;
  /** 取り込んだ sourcemap に import_sourcemap を掛ける（既定 true） */
  sourcemaps?: boolean;
}

export interface SourcemapIngest {
  mapFileId: string;
  /** map の表示用の名前（取り込んだファイル名） */
  origName: string | null;
  result?: ImportSourcemapResult;
  /** 生成元が決まらないなど、その map だけ取り込めなかった理由 */
  error?: { code: SaErrorCode; message: string };
}

export interface IngestResult {
  load: LoadArtifactResult;
  unpack?: UnpackBundleResult;
  sourcemaps: SourcemapIngest[];
}

export async function ingestArtifacts(ctx: SaContext, input: LoadArtifactInput, opts: IngestOptions = {}): Promise<IngestResult> {
  const load = loadArtifact(ctx, input);
  return { load, ...(await afterLoad(ctx, load.versionId, load.fileIds, opts)) };
}

export interface HarIngestResult {
  har: ImportHarResult;
  unpack?: UnpackBundleResult;
  sourcemaps: SourcemapIngest[];
}

/** import_har → HAR から取り込んだ JS の unpack_bundle → sourcemap の import_sourcemap（`sa import-har`） */
export async function ingestHar(ctx: SaContext, input: ImportHarInput, opts: IngestOptions = {}): Promise<HarIngestResult> {
  const har = importHar(ctx, input);
  return { har, ...(await afterLoad(ctx, har.versionId, har.scripts.fileIds, opts)) };
}

/** 取り込んだ版に unpack を掛け、取り込んだ sourcemap を読む */
async function afterLoad(
  ctx: SaContext,
  versionId: string,
  fileIds: string[],
  opts: IngestOptions,
): Promise<{ unpack?: UnpackBundleResult; sourcemaps: SourcemapIngest[] }> {
  const unpack = opts.unpack === false ? undefined : await unpackBundle(ctx, { versionId });

  const sourcemaps: SourcemapIngest[] = [];
  if (opts.sourcemaps !== false) {
    const maps = [...new Set(fileIds)].map((id) => getArtifactFile(ctx, id)!).filter((f) => f.kind === 'sourcemap');
    for (const map of maps) {
      const base = { mapFileId: map.id, origName: map.origName };
      try {
        sourcemaps.push({ ...base, result: await importSourcemap(ctx, { versionId, mapFileId: map.id }) });
      } catch (err) {
        // 生成元が決まらない map は、その map だけ飛ばして続ける（後で generatedFileId を指定して掛け直せる）
        if (isSaError(err) && err.code === 'INVALID_INPUT') {
          sourcemaps.push({ ...base, error: { code: err.code, message: err.message } });
          continue;
        }
        throw err;
      }
    }
  }
  return { ...(unpack && { unpack }), sourcemaps };
}
