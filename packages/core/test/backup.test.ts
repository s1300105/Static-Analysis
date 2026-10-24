import { copyFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Database,
  SCHEMA_VERSION,
  SaError,
  backupDatabase,
  migrate,
  verifyBackup,
  withTxn,
} from '@sa/core';
import { catchError, useDatabases, useTmpDir } from './helpers';

const tmp = useTmpDir();
const openTracked = useDatabases();

function seeded(dir: string): Database {
  const db = openTracked(join(dir, 'sa.db'));
  migrate(db);
  db.prepare('INSERT INTO target (id, name) VALUES (?, ?)').run('t1', 'example');
  return db;
}

describe('backupDatabase', () => {
  it('takes a consistent snapshot that includes changes still in the WAL', () => {
    const dir = tmp();
    const db = seeded(dir);
    // まだチェックポイントされていない（WAL にしか無い）変更
    expect(statSync(join(dir, 'sa.db-wal')).size).toBeGreaterThan(0);

    const dest = join(dir, 'snapshot.db');
    const r = backupDatabase(db, dest);
    expect(r.path).toBe(dest);
    expect(r.bytes).toBe(statSync(dest).size);
    expect(verifyBackup(dest)).toEqual({ userVersion: SCHEMA_VERSION });
  });

  it('can be restored: a copy of the snapshot opens, migrates as a no-op and has the data', () => {
    const dir = tmp();
    const dest = join(dir, 'snapshot.db');
    backupDatabase(seeded(dir), dest);

    const restored = join(dir, 'restored.db');
    copyFileSync(dest, restored);
    const db = openTracked(restored);
    expect(migrate(db).applied).toEqual([]);
    expect(db.prepare('SELECT id, name FROM target').all()).toEqual([{ id: 't1', name: 'example' }]);
  });

  it('never overwrites an existing file', () => {
    const dir = tmp();
    const dest = join(dir, 'snapshot.db');
    writeFileSync(dest, 'precious');
    const err = catchError(() => backupDatabase(seeded(dir), dest));
    expect((err as SaError).code).toBe('INVALID_INPUT');
  });

  it('refuses to run inside a transaction', () => {
    const dir = tmp();
    const db = seeded(dir);
    const err = catchError(() => withTxn({ db }, () => backupDatabase(db, join(dir, 'snapshot.db'))));
    expect((err as SaError).code).toBe('INVALID_INPUT');
  });
});

describe('verifyBackup', () => {
  it('rejects a file that is not a database', () => {
    const p = join(tmp(), 'garbage.db');
    writeFileSync(p, 'this is not sqlite'.repeat(100));
    const err = catchError(() => verifyBackup(p));
    expect(err).toBeInstanceOf(SaError);
    expect((err as SaError).code).toBe('DB_ERROR');
  });

  it('rejects a missing file', () => {
    expect((catchError(() => verifyBackup(join(tmp(), 'nope.db'))) as SaError).code).toBe('DB_ERROR');
  });
});
