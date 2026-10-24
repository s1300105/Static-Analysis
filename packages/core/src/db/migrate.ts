/**
 * スキーマ移行（design.md §6、docs/architecture.md §3.3）。
 * PRAGMA user_version と番号付きの移行 SQL で管理し、既存スキーマに移行を掛ける前に DB を自動で複製する。
 */
import { existsSync } from 'node:fs';
import { SaError } from '../errors';
import { backupDatabase } from '../store/backup';
import { type Database, withTxn } from './connection';
import { MIGRATIONS, type Migration } from './migrations';

/** このビルドの sa-core が知っている最新のスキーマ版 */
export const SCHEMA_VERSION: number = MIGRATIONS.at(-1)?.version ?? 0;

export interface MigrateOptions {
  /** 適用する移行の一覧。既定は MIGRATIONS（テストで差し替える） */
  migrations?: readonly Migration[];
}

export interface MigrateResult {
  /** 移行前の user_version */
  from: number;
  /** 移行後の user_version */
  to: number;
  /** 適用した移行の名前（番号順） */
  applied: string[];
  /** 移行前の複製（<db>.pre-NNNN.bak）。既存スキーマを持つファイル DB に移行を掛けたときだけ作る */
  backupPath?: string;
}

/**
 * 未適用の移行を番号順に適用する。冪等（最新なら何もしない）。
 * - 未適用分はまとめて 1 つの BEGIN IMMEDIATE トランザクションで適用し、途中で失敗したら全部戻す
 * - 適用の後に foreign_key_check を掛け、違反があれば戻す
 * - DB の版がこのビルドより新しければ拒否する（古い sa-core で新しい DB を書かない）
 * - foreign_keys は ON のまま適用する。表の作り直しが要る移行は SQL 内で PRAGMA defer_foreign_keys = ON を使う
 */
export function migrate(db: Database, opts: MigrateOptions = {}): MigrateResult {
  const migrations = opts.migrations ?? MIGRATIONS;
  assertValidMigrations(migrations);
  const latest = migrations.at(-1)?.version ?? 0;

  const before = userVersion(db);
  assertNotNewer(before, latest);
  const firstPending = migrations.find((m) => m.version > before);
  if (!firstPending) return { from: before, to: before, applied: [] };

  // user_version=0 は作ったばかりの空 DB なので守るものが無い。複製は既存スキーマがあるときだけ
  const backupPath =
    before > 0 && !db.memory
      ? backupDatabase(db, uniqueBackupPath(db.name, firstPending.version)).path
      : undefined;

  const result = withTxn({ db }, () => {
    // 書き込みロックを取ってから読み直す（並行して別プロセスが移行を済ませた場合に二重適用しない）
    const from = userVersion(db);
    assertNotNewer(from, latest);
    const applied: string[] = [];
    for (const m of migrations) {
      if (m.version <= from) continue;
      try {
        db.exec(m.sql);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SaError('DB_ERROR', `migration ${m.name} failed: ${message}`, { migration: m.name, backupPath }, { cause: err });
      }
      // version は assertValidMigrations で 1 からの連番（整数）と確かめてある
      db.pragma(`user_version = ${m.version}`);
      applied.push(m.name);
    }
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new SaError('INTEGRITY_ERROR', 'foreign_key_check failed after migration', {
        violations: violations.slice(0, 20),
        backupPath,
      });
    }
    return { from, to: latest, applied };
  });
  return backupPath === undefined ? result : { ...result, backupPath };
}

export function userVersion(db: Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function assertValidMigrations(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    const expected = i + 1;
    if (m.version !== expected) {
      throw new SaError('INVALID_INPUT', `migration versions must be contiguous from 1: ${m.name} has ${m.version}, expected ${expected}`);
    }
    if (!m.name.startsWith(`${pad4(m.version)}_`)) {
      throw new SaError('INVALID_INPUT', `migration name must start with ${pad4(m.version)}_: ${m.name}`);
    }
  });
}

function assertNotNewer(current: number, latest: number): void {
  if (current > latest) {
    throw new SaError('DB_ERROR', `database schema version ${current} is newer than this sa-core supports (${latest})`, {
      userVersion: current,
      supported: latest,
    });
  }
}

/** <db>.pre-NNNN.bak。既にあれば（前回の失敗した移行の複製など）消さずに .1.bak, .2.bak … と番号を足す */
function uniqueBackupPath(dbFile: string, version: number): string {
  const base = `${dbFile}.pre-${pad4(version)}`;
  let candidate = `${base}.bak`;
  for (let n = 1; existsSync(candidate); n++) candidate = `${base}.${n}.bak`;
  return candidate;
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}
