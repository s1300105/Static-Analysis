/**
 * DB のバックアップ（design.md §6.1「成果物ストア」）。
 * 稼働中の DB ファイルはコピーせず、VACUUM INTO で整合したスナップショットをとる。
 * 暗号化して別媒体に置くのは `sa backup` の運用側（ここでは平文のスナップショットを作るだけ）。
 */
import { existsSync, statSync } from 'node:fs';
import BetterSqlite3 from 'better-sqlite3';
import { type Database, toDbError } from '../db/connection';
import { SaError } from '../errors';

export interface BackupResult {
  path: string;
  bytes: number;
}

/**
 * db の整合したスナップショットを destPath に書く。WAL 上の未チェックポイントの変更も含む。
 * 既存ファイルは上書きしない。トランザクションの中からは呼べない（SQLite の制約）。
 */
export function backupDatabase(db: Database, destPath: string): BackupResult {
  if (db.inTransaction) {
    throw new SaError('INVALID_INPUT', 'cannot back up the database inside a transaction');
  }
  if (existsSync(destPath)) {
    throw new SaError('INVALID_INPUT', `backup destination already exists: ${destPath}`, { destPath });
  }
  try {
    db.prepare('VACUUM INTO ?').run(destPath);
  } catch (err) {
    throw toDbError(err);
  }
  return { path: destPath, bytes: statSync(destPath).size };
}

export interface BackupCheck {
  /** スナップショットのスキーマ版（PRAGMA user_version） */
  userVersion: number;
}

/**
 * バックアップを読み取り専用で開き、integrity_check と foreign_key_check を通す。
 * 導入時の復元確認（design.md §6.1）と、作ったスナップショットの検査に使う。
 */
export function verifyBackup(path: string): BackupCheck {
  let db: Database;
  try {
    db = new BetterSqlite3(path, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new SaError('DB_ERROR', `cannot open backup ${path}`, { path }, { cause: err });
  }
  try {
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new SaError('INTEGRITY_ERROR', `backup failed integrity_check: ${path}`, {
        path,
        problems: integrity.slice(0, 20).map((r) => r.integrity_check),
      });
    }
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (violations.length > 0) {
      throw new SaError('INTEGRITY_ERROR', `backup failed foreign_key_check: ${path}`, {
        path,
        violations: violations.slice(0, 20),
      });
    }
    return { userVersion: db.pragma('user_version', { simple: true }) as number };
  } catch (err) {
    throw toDbError(err);
  } finally {
    db.close();
  }
}
