/**
 * DB 接続の初期化とトランザクション（design.md §6、docs/architecture.md §3.3）。
 * ドライバは better-sqlite3。将来 node:sqlite に差し替えられるよう、外には Database 型だけを見せる。
 */
import BetterSqlite3 from 'better-sqlite3';
import { SaError } from '../errors';

export type Database = BetterSqlite3.Database;

/** withTxn などが受け取る最小の形。SaContext（PR-5）もこれを満たす */
export interface HasDb {
  readonly db: Database;
}

export const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export interface OpenDatabaseOptions {
  /** 書き込みロックを待つ時間（ms）。既定 5000（design.md §6） */
  busyTimeoutMs?: number;
}

/**
 * DB を開き、接続ごとの PRAGMA を設定する。
 * foreign_keys と busy_timeout は DB に保存されないので、接続を開くたびに必ずここを通す。
 * 移行は掛けない（migrate() を別に呼ぶ）。
 */
export function openDatabase(file: string, opts: OpenDatabaseOptions = {}): Database {
  const busyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new SaError('INVALID_INPUT', `busyTimeoutMs must be a non-negative integer: ${busyTimeoutMs}`);
  }

  let db: Database;
  try {
    db = new BetterSqlite3(file, { timeout: busyTimeoutMs });
  } catch (err) {
    throw new SaError('DB_ERROR', `cannot open database ${file}: ${errorMessage(err)}`, { file }, { cause: err });
  }

  try {
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    if (db.pragma('foreign_keys', { simple: true }) !== 1) {
      throw new SaError('DB_ERROR', 'failed to enable foreign_keys', { file });
    }
    // インメモリ DB は WAL にならない（'memory' のまま）。ファイル DB で WAL にならないのは異常
    if (!db.memory && journalMode !== 'wal') {
      throw new SaError('DB_ERROR', `failed to enable WAL (journal_mode=${String(journalMode)})`, { file });
    }
  } catch (err) {
    db.close();
    throw toDbError(err);
  }
  return db;
}

/**
 * BEGIN IMMEDIATE で fn を実行する。読んでから書く操作（較正の再計算、事実登録＋fact_event、事実の評価）は必ずこれを使う。
 * - 書き込みロックを最初に取るので、読んだ後に他の書き手に割り込まれない（取れなければ busy_timeout まで待つ）
 * - fn が throw したらロールバックして投げ直す。SQLite のエラーは SaError('DB_ERROR') に包む
 * - 入れ子で呼ぶと SAVEPOINT になる
 * - fn は同期関数に限る。CodeQL 実行や LLM 呼び出しをまたいでトランザクションを開いたままにしない（design.md §6）
 */
export function withTxn<T>(ctx: HasDb, fn: () => T): T {
  const txn = ctx.db.transaction(() => {
    const result = fn();
    if (isPromiseLike(result)) {
      throw new SaError('INVALID_INPUT', 'withTxn callback must be synchronous (do not hold a transaction across await)');
    }
    return result;
  });
  try {
    return txn.immediate();
  } catch (err) {
    throw toDbError(err);
  }
}

/** fn を実行し、SQLite のエラーだけを SaError('DB_ERROR') に包んで投げ直す（リポジトリ関数の共通の形） */
export function dbCall<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw toDbError(err);
  }
}

/** better-sqlite3 のエラーを SaError('DB_ERROR') に包む。それ以外（SaError やバグ由来の例外）はそのまま返す */
export function toDbError(err: unknown): unknown {
  if (err instanceof BetterSqlite3.SqliteError) {
    return new SaError('DB_ERROR', err.message, { sqliteCode: err.code }, { cause: err });
  }
  return err;
}

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return (
    (typeof v === 'object' || typeof v === 'function') &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
