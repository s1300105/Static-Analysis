import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { type Database, type OpenDatabaseOptions, openDatabase } from '@sa/core';

/** テストごとの一時ディレクトリ。afterEach で消す */
export function useTmpDir(): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  return () => {
    const d = mkdtempSync(join(tmpdir(), 'sa-core-test-'));
    dirs.push(d);
    return d;
  };
}

/** openDatabase して、afterEach で閉じる */
export function useDatabases(): (file: string, opts?: OpenDatabaseOptions) => Database {
  const dbs: Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) if (db.open) db.close();
  });
  return (file, opts) => {
    const db = openDatabase(file, opts);
    dbs.push(db);
    return db;
  };
}

/** fn が投げたものを返す。投げなければテストを失敗させる */
export function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected an error');
}
