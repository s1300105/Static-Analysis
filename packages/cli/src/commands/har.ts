/**
 * sa import-har: 人間が取得した HAR から許可リストの項目だけを取り込む（design.md §7.1 import_har）。HAR は保存しない。
 * HAR にある JS・sourcemap は raw 層に入れ、sa load と同じく unpack と sourcemap の取り込みまで掛ける。
 * API の呼び出しは取り込む時点の endpoint と照合するので、先に sa extract-endpoints を掛けておく。
 */
import { type HarIngestResult, findTarget, ingestHar } from '@sa/core';
import type { Command } from 'commander';
import { type CliIo, absolute, emit, parseJsonObject, withContext } from '../io';
import { afterLoadLines } from './load';

interface ImportHarOptions {
  versionId?: string;
  baseVersionId?: string;
  label?: string;
  collectedAt?: string;
  notes?: string;
  unpack: boolean;
  sourcemaps: boolean;
}

export function registerImportHarCommand(program: Command, io: CliIo): void {
  program
    .command('import-har')
    .description('HAR から許可リストの項目（メソッド・パス・パラメータ名・セキュリティヘッダ・JS）だけを取り込む。HAR は保存しない')
    .argument('<target>', '対象の ID か名前')
    .argument('<har>', 'HAR ファイル')
    .option('--version-id <id>', '既存の版に足す（省けば新しい版を作る）')
    .option('--base-version-id <id>', '比較の基準にする版（新しい版を作るときだけ）')
    .option('--label <label>', '版のラベル（新しい版を作るときだけ）')
    .option('--collected-at <datetime>', '取得日時（ISO 8601 か now。新しい版を作るとき、省けば HAR の最初の記録の日時）')
    .option('--notes <json>', '収集条件のメモ（JSON オブジェクト。ログイン有無・ロールなど）')
    .option('--no-unpack', 'HAR から取り込んだ JS に unpack_bundle を掛けない')
    .option('--no-sourcemaps', 'HAR から取り込んだ sourcemap に import_sourcemap を掛けない')
    .action(async (targetRef: string, harPath: string, opts: ImportHarOptions, cmd: Command) => {
      const collectedAt = opts.collectedAt === 'now' ? new Date().toISOString() : opts.collectedAt;
      const r = await withContext(cmd, io, (ctx) =>
        ingestHar(
          ctx,
          {
            targetId: findTarget(ctx, targetRef).id,
            harPath: absolute(io, harPath),
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

function summary(r: HarIngestResult): string[] {
  const { har } = r;
  return [
    `version ${har.versionId}${har.createdVersion ? ' (new)' : ''}: ${har.entries} entries (${har.invalid} unreadable, ${har.ignored} ignored)`,
    `scripts: ${har.scripts.fileIds.length} files, ${har.scripts.added} added, ${har.scripts.withoutBody} without a body in the HAR`,
    `api: ${har.api.requests} requests, ${har.api.matched} matched extracted endpoints, ${har.api.harOnly} only in the HAR (run ${har.runId})`,
    `pages: ${har.pages} documents with security headers`,
    ...afterLoadLines(r),
  ];
}
