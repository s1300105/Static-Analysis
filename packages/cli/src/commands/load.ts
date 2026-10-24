/**
 * sa load: 人間が取得した JS・sourcemap・HTML を取り込み、unpack と sourcemap の取り込みまで掛ける（design.md §7.1・§8「収集」）。
 * ファイルごとの配信 URL などはマニフェスト（LoadArtifactFile の配列の JSON）で渡す。
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { type IngestResult, SaError, findTarget, ingestArtifacts } from '@sa/core';
import type { LoadArtifactFile } from '@sa/types';
import type { Command } from 'commander';
import { type CliIo, absolute, emit, withContext } from '../io';

interface LoadOptions {
  versionId?: string;
  baseVersionId?: string;
  label?: string;
  collectedAt?: string;
  notes?: string;
  manifest?: string;
  unpack: boolean;
  sourcemaps: boolean;
}

export function registerLoadCommand(program: Command, io: CliIo): void {
  program
    .command('load')
    .description('raw 層として取り込み、unpack と sourcemap の取り込みまで掛ける（HAR は受けない）')
    .argument('<target>', '対象の ID か名前')
    .argument('[files...]', '取り込むファイル')
    .option('--version-id <id>', '既存の版に足す（省けば新しい版を作る）')
    .option('--base-version-id <id>', '比較の基準にする版（新しい版を作るときだけ）')
    .option('--label <label>', '版のラベル（新しい版を作るときだけ）')
    .option('--collected-at <datetime>', '人間が取得した日時（ISO 8601 か now。新しい版を作るときは必須）')
    .option('--notes <json>', '収集条件のメモ（JSON オブジェクト。ログイン有無・ロールなど）')
    .option('--manifest <file>', 'ファイルごとの情報（path・sourceUrls・loadedByOrigins・ownership・chunkKey）の JSON 配列')
    .option('--no-unpack', 'unpack_bundle を掛けない')
    .option('--no-sourcemaps', '取り込んだ sourcemap に import_sourcemap を掛けない')
    .action(async (targetRef: string, paths: string[], opts: LoadOptions, cmd: Command) => {
      const files: LoadArtifactFile[] = [
        ...paths.map((p) => ({ path: absolute(io, p) })),
        ...(opts.manifest !== undefined ? readManifest(absolute(io, opts.manifest)) : []),
      ];
      if (files.length === 0) throw new SaError('INVALID_INPUT', 'no files to load (give paths or --manifest)');
      const collectedAt = opts.collectedAt === 'now' ? new Date().toISOString() : opts.collectedAt;

      const r = await withContext(cmd, io, (ctx) =>
        ingestArtifacts(
          ctx,
          {
            targetId: findTarget(ctx, targetRef).id,
            files,
            ...(opts.versionId !== undefined && { versionId: opts.versionId }),
            ...(opts.baseVersionId !== undefined && { baseVersionId: opts.baseVersionId }),
            ...(opts.label !== undefined && { label: opts.label }),
            ...(collectedAt !== undefined && { collectedAt }),
            ...(opts.notes !== undefined && { collectionNotes: parseJsonObject(opts.notes, '--notes') }),
          },
          { unpack: opts.unpack, sourcemaps: opts.sourcemaps },
        ),
      );
      emit(cmd, io, r, () => summary(r));
    });
}

function summary(r: IngestResult): string[] {
  const { load, unpack } = r;
  const lines = [
    `version ${load.versionId}${load.createdVersion ? ' (new)' : ''}: ${load.fileIds.length} files, ${load.added} added`,
  ];
  if (unpack) {
    const bundlers = Object.entries(unpack.bundlers)
      .map(([b, n]) => `${b} ${n}`)
      .join(', ');
    lines.push(
      `unpack: ${unpack.files} files, ${unpack.moduleCount} modules${bundlers ? ` (${bundlers})` : ''}, ` +
        `${unpack.skipped} skipped, ${unpack.noBoundaryCount} without module boundaries (run ${unpack.runId})`,
    );
  }
  for (const s of r.sourcemaps) {
    const name = s.origName ?? s.mapFileId;
    if (s.error) lines.push(`sourcemap ${name}: not imported - ${s.error.message}`);
    else if (s.result?.accepted) {
      lines.push(`sourcemap ${name}: accepted (rate ${s.result.mapCheck?.rate}), ${s.result.originalFileIds.length} original files`);
    } else {
      const rate = s.result?.mapCheck ? `rate ${s.result.mapCheck.rate} < ${s.result.mapCheck.threshold}` : 'unreadable';
      lines.push(`sourcemap ${name}: rejected (${rate}; possibly from a different build), no original layer`);
    }
  }
  return lines;
}

/** マニフェストを読む。中身の検証は sa-core（LoadArtifactInputSchema）が行う。path はマニフェストの場所から解く */
function readManifest(file: string): LoadArtifactFile[] {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new SaError('INVALID_INPUT', `cannot read manifest ${file}`, { file }, { cause: err });
  }
  if (!Array.isArray(json)) throw new SaError('INVALID_INPUT', `manifest must be a JSON array: ${file}`);
  return json.map((entry: unknown) => {
    const e = entry as LoadArtifactFile;
    return typeof e?.path === 'string' && !isAbsolute(e.path) ? { ...e, path: resolve(dirname(file), e.path) } : e;
  });
}

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new SaError('INVALID_INPUT', `${what} must be JSON`, undefined, { cause: err });
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SaError('INVALID_INPUT', `${what} must be a JSON object`);
  return v as Record<string, unknown>;
}
