/**
 * SaContext: 入口が 1 つ作って sa-core の関数に渡す束（docs/architecture.md §3.2）。
 * 入口は openContext で作り、終わったら closeContext で閉じる。設定の解決は config.ts。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CALLER_KINDS, type CallerKind } from '@sa/types';
import { DEFAULT_BUSY_TIMEOUT_MS, type Database, openDatabase } from './db/connection';
import { type MigrateResult, migrate } from './db/migrate';
import { SaError } from './errors';
import { DEFAULT_WORKER_LIMITS, type JobRunner, type WorkerLimits, createJobRunner } from './jobs/runner';
import { type BlobStore, openBlobStore } from './store/blob';

export interface SaConfig {
  /** SQLite の DB ファイル */
  dbPath: string;
  /** blob ストアのルート */
  blobDir: string;
  /** 作業ディレクトリ。ツールが生成するパス（policy/paths）はすべてこの下 */
  workspaceDir: string;
  busyTimeoutMs: number;
  /** 同時に動かす worker の数。省けば CPU 数 − 1 */
  maxWorkers?: number;
  /** 同時に動かす子プロセスの数。省けば 2 */
  maxChildren?: number;
  /** Babel parse など worker で動かす処理の上限 */
  workerLimits: WorkerLimits;
  /** sourcemap の簡易検証の一致率の閾値（design.md §13 で未決。評価で決めるまでの既定値） */
  mapCheckThreshold: number;
}

/**
 * 仮の既定値。webpack 5 の fixture で、正しい map は 0.83〜1.0（小さいチャンクでは webpack が合成した
 * `_x__WEBPACK_IMPORTED_MODULE_0__` などの名前が元ソースに無いぶん下がる）、別ビルド・別チャンクの map は 0.01〜0.25 だった。
 * 評価コーパスで決め直す（design.md §13）。
 */
export const DEFAULT_MAP_CHECK_THRESHOLD = 0.7;

/** パス以外の既定値 */
export const DEFAULT_CONFIG: Readonly<Omit<SaConfig, 'dbPath' | 'blobDir' | 'workspaceDir'>> = {
  busyTimeoutMs: DEFAULT_BUSY_TIMEOUT_MS,
  workerLimits: DEFAULT_WORKER_LIMITS,
  mapCheckThreshold: DEFAULT_MAP_CHECK_THRESHOLD,
};

export interface SaContext {
  /** better-sqlite3 の接続（PRAGMA 設定済み・移行済み） */
  db: Database;
  store: BlobStore;
  jobs: JobRunner;
  config: SaConfig;
  /** 権限と公開範囲の判定に使う（人間の判定・target.scope を書けるのは cli だけ。policy/caller.ts） */
  caller: CallerKind;
}

export interface OpenContextOptions {
  config: SaConfig;
  caller: CallerKind;
  /** 移行を適用したときに呼ぶ（入口が移行前の複製の場所を人間に伝えるため） */
  onMigrated?: (result: MigrateResult) => void;
}

/**
 * DB・blob ストア・作業ディレクトリを用意して SaContext を作る。
 * ディレクトリは無ければ所有者だけが読めるモード（0700）で作る（DB と raw 層はターゲットの成果物を含む）。
 * DB は開いた直後に移行を掛ける。
 */
export function openContext(opts: OpenContextOptions): SaContext {
  if (!(CALLER_KINDS as readonly string[]).includes(opts.caller)) {
    throw new SaError('INVALID_INPUT', `unknown caller: ${opts.caller}`);
  }
  const { config } = opts;
  for (const dir of [dirname(config.dbPath), config.blobDir, config.workspaceDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = openDatabase(config.dbPath, { busyTimeoutMs: config.busyTimeoutMs });
  try {
    const migrated = migrate(db);
    if (migrated.applied.length > 0) opts.onMigrated?.(migrated);
    return {
      db,
      store: openBlobStore(config.blobDir),
      jobs: createJobRunner({
        ...(config.maxWorkers !== undefined && { maxWorkers: config.maxWorkers }),
        ...(config.maxChildren !== undefined && { maxChildren: config.maxChildren }),
      }),
      config,
      caller: opts.caller,
    };
  } catch (err) {
    db.close();
    throw err;
  }
}

export function closeContext(ctx: SaContext): void {
  if (ctx.db.open) ctx.db.close();
}
