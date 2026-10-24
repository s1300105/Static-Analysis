/**
 * @sa/core の公開 API。
 * いまは errors / ids / db（接続・トランザクション・移行）/ store（blob・バックアップ）/ jobs の型 / context と設定 / artifact。
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
// ジョブ実行器・スキップ記録・作業パスは sa-core の内部で使う（入口は openContext で SaContext.jobs を受け取る）。ここでは型だけ出す
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
  closeContext,
  openContext,
  type OpenContextOptions,
  type SaConfig,
  type SaContext,
} from './context';
export { CONFIG_FILE_NAME, configForHome, resolveConfig, type ResolveConfigOptions, type ResolvedConfig } from './config';
// 対象の管理（scope の書き込みは CLI だけ）
export {
  createTarget,
  describeTarget,
  findTarget,
  listTargets,
  updateTargetScope,
  type Target,
  type TargetDetail,
  type TargetScopePatch,
  type VersionSummary,
} from './target';
// Artifact（取り込み・層の生成。design.md §7.1）。いずれも MCP には出さない（CLI から呼ぶ）
export { loadArtifact, type LoadArtifactResult } from './artifact/load';
export { unpackBundle, type UnpackBundleOptions, type UnpackBundleResult } from './artifact/unpack';
export { importSourcemap, type ImportSourcemapOptions, type ImportSourcemapResult } from './artifact/sourcemap';
export { ingestArtifacts, type IngestOptions, type IngestResult, type SourcemapIngest } from './artifact/ingest';

export { CORE_VERSION } from './version';
