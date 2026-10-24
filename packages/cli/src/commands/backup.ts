/**
 * sa backup: DB の整合したスナップショット（VACUUM INTO）をとり、検査する（design.md §6.1「バックアップ」）。
 * blob ストアは含まない。DB と blob ストアを暗号化して別媒体に置くのは運用側。
 */
import { backupDatabase, verifyBackup } from '@sa/core';
import type { Command } from 'commander';
import { type CliIo, absolute, emit, withContext } from '../io';

export function registerBackupCommand(program: Command, io: CliIo): void {
  program
    .command('backup')
    .description('DB のスナップショットをとって検査する（既存のファイルは上書きしない。blob ストアは別に保管する）')
    .argument('<dest>', '書き出すファイル')
    .action(async (dest: string, _opts: unknown, cmd: Command) => {
      const r = await withContext(cmd, io, (ctx) => {
        const b = backupDatabase(ctx.db, absolute(io, dest));
        const check = verifyBackup(b.path);
        return { path: b.path, bytes: b.bytes, schemaVersion: check.userVersion, blobDir: ctx.config.blobDir };
      });
      emit(cmd, io, r, () => [
        `backup written: ${r.path} (${r.bytes} bytes, schema version ${r.schemaVersion}, integrity ok)`,
        `the blob store is not included; keep ${r.blobDir} with it (encrypt both and store them on separate media)`,
      ]);
    });
}
