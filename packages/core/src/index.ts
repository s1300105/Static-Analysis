/**
 * @sa/core の公開 API。
 * いまは errors / ids / db（接続・トランザクション・移行）/ store（blob・バックアップ）。
 * 以降の PR で context / jobs / policy / artifact / intel / analysis / findings を足していく（docs/architecture.md §3）。
 */
export * from './errors';
export * from './ids';
export {
  DEFAULT_BUSY_TIMEOUT_MS,
  openDatabase,
  withTxn,
  type Database,
  type HasDb,
  type OpenDatabaseOptions,
} from './db/connection';
export { SCHEMA_VERSION, migrate, userVersion, type MigrateOptions, type MigrateResult } from './db/migrate';
export { MIGRATIONS, type Migration } from './db/migrations';
export { openBlobStore, sha256Hex, type BlobPutResult, type BlobStore } from './store/blob';
export { backupDatabase, verifyBackup, type BackupCheck, type BackupResult } from './store/backup';

/** パッケージ版。実行記録 analysis_run.tool_version の一部に使う予定 */
export const CORE_VERSION = '0.0.0';
