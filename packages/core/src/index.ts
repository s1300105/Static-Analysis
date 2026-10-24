/**
 * @sa/core の公開 API。
 * いまは errors / ids / db（接続・トランザクション・移行）/ store（blob・バックアップ）/ jobs の型 / context の型 / artifact。
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
// ジョブ実行器は SaContext.jobs を作るために出す。スキップ記録・作業パスは sa-core の内部で使う
export { createJobRunner, type JobRunnerOptions } from './jobs/runner';
export type {
  ChildOutput,
  ChildSpec,
  JobFailure,
  JobResult,
  JobRunner,
  JobSuccess,
  WorkerLimits,
  WorkerSpec,
} from './jobs/runner';
export {
  DEFAULT_CONFIG,
  DEFAULT_MAP_CHECK_THRESHOLD,
  type SaConfig,
  type SaContext,
} from './context';
// Artifact（取り込み・層の生成。design.md §7.1）。いずれも MCP には出さない（CLI から呼ぶ）
export { loadArtifact, type LoadArtifactResult } from './artifact/load';
export { unpackBundle, type UnpackBundleOptions, type UnpackBundleResult } from './artifact/unpack';
export { importSourcemap, type ImportSourcemapOptions, type ImportSourcemapResult } from './artifact/sourcemap';

export { CORE_VERSION } from './version';
