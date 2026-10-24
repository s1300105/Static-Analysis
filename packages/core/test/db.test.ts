import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Database, SaError, openDatabase, withTxn } from '@sa/core';
import { catchError, useDatabases, useTmpDir } from './helpers';

const tmp = useTmpDir();
const openTracked = useDatabases();

function count(db: Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('openDatabase', () => {
  it('sets the per-connection PRAGMAs on a file database', () => {
    const db = openTracked(join(tmp(), 'sa.db'));
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('honours a custom busy timeout', () => {
    const db = openTracked(join(tmp(), 'sa.db'), { busyTimeoutMs: 250 });
    expect(db.pragma('busy_timeout', { simple: true })).toBe(250);
  });

  it('works in memory (journal_mode stays memory)', () => {
    const db = openTracked(':memory:');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
  });

  it('rejects an invalid busy timeout', () => {
    const err = catchError(() => openDatabase(':memory:', { busyTimeoutMs: -1 }));
    expect(err).toBeInstanceOf(SaError);
    expect((err as SaError).code).toBe('INVALID_INPUT');
  });

  it('wraps open failures as DB_ERROR', () => {
    const err = catchError(() => openDatabase(join(tmp(), 'missing-dir', 'sa.db')));
    expect(err).toBeInstanceOf(SaError);
    expect((err as SaError).code).toBe('DB_ERROR');
  });
});

describe('withTxn', () => {
  function setup(file = ':memory:'): Database {
    const db = openTracked(file);
    db.exec('CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id));');
    return db;
  }

  it('commits and returns the callback value', () => {
    const db = setup();
    const n = withTxn({ db }, () => db.prepare('INSERT INTO parent VALUES (?)').run('p1').changes);
    expect(n).toBe(1);
    expect(db.inTransaction).toBe(false);
    expect(count(db, 'parent')).toBe(1);
  });

  it('rolls back and rethrows the original error', () => {
    const db = setup();
    const boom = new Error('boom');
    const err = catchError(() =>
      withTxn({ db }, () => {
        db.prepare('INSERT INTO parent VALUES (?)').run('p1');
        throw boom;
      }),
    );
    expect(err).toBe(boom);
    expect(count(db, 'parent')).toBe(0);
  });

  it('wraps SQLite errors (e.g. a foreign key violation) as DB_ERROR', () => {
    const db = setup();
    const err = catchError(() => withTxn({ db }, () => db.prepare('INSERT INTO child VALUES (?, ?)').run('c1', 'nope')));
    expect(err).toBeInstanceOf(SaError);
    expect((err as SaError).code).toBe('DB_ERROR');
    expect((err as SaError).detail).toEqual({ sqliteCode: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
  });

  it('rejects an async callback and rolls back', () => {
    const db = setup();
    const err = catchError(() =>
      withTxn({ db }, async () => {
        db.prepare('INSERT INTO parent VALUES (?)').run('p1');
      }),
    );
    expect((err as SaError).code).toBe('INVALID_INPUT');
    expect(count(db, 'parent')).toBe(0);
  });

  it('nests as a savepoint: an inner failure caught by the outer callback rolls back only the inner part', () => {
    const db = setup();
    withTxn({ db }, () => {
      db.prepare('INSERT INTO parent VALUES (?)').run('outer');
      catchError(() =>
        withTxn({ db }, () => {
          db.prepare('INSERT INTO parent VALUES (?)').run('inner');
          throw new Error('inner failed');
        }),
      );
    });
    expect(db.prepare('SELECT id FROM parent').all()).toEqual([{ id: 'outer' }]);
  });

  it('takes the write lock at BEGIN (IMMEDIATE), while readers still proceed under WAL', () => {
    const file = join(tmp(), 'sa.db');
    const a = setup(file);
    const b = openTracked(file, { busyTimeoutMs: 0 });
    withTxn({ db: a }, () => {
      // a はまだ何も書いていないが、書き込みロックは既に a が持っている
      const err = catchError(() => withTxn({ db: b }, () => b.prepare('INSERT INTO parent VALUES (?)').run('b')));
      expect((err as SaError).code).toBe('DB_ERROR');
      expect((err as SaError).detail).toEqual({ sqliteCode: 'SQLITE_BUSY' });
      expect(count(b, 'parent')).toBe(0);
      a.prepare('INSERT INTO parent VALUES (?)').run('a');
    });
    expect(count(b, 'parent')).toBe(1);
  });
});
