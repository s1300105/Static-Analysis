import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type Database,
  MIGRATIONS,
  type Migration,
  SCHEMA_VERSION,
  SaError,
  migrate,
  userVersion,
  verifyBackup,
} from '@sa/core';
import { catchError, useDatabases, useTmpDir } from './helpers';

const tmp = useTmpDir();
const openTracked = useDatabases();

function tableNames(db: Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

const pad4 = (n: number) => String(n).padStart(4, '0');
/** 既存の移行の後ろに足すテスト用の移行 */
const extra = (sql: string, offset = 1): Migration => {
  const version = MIGRATIONS.length + offset;
  return { version, name: `${pad4(version)}_test_${offset}`, sql };
};

const T0 = '2026-01-01T00:00:00.000Z';

describe('migration registry', () => {
  it('registers every .sql file in src/db/migrations, in order', () => {
    const dir = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => f.replace(/\.sql$/, ''));
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(files.map((_, i) => i + 1));
    expect(SCHEMA_VERSION).toBe(files.length);
  });

  it('rejects a registry with a gap', () => {
    const db = openTracked(':memory:');
    const err = catchError(() => migrate(db, { migrations: [...MIGRATIONS, extra('SELECT 1', 2)] }));
    expect((err as SaError).code).toBe('INVALID_INPUT');
    expect(userVersion(db)).toBe(0);
  });
});

describe('migrate', () => {
  it('brings a fresh database to the latest version without making a backup', () => {
    const dir = tmp();
    const db = openTracked(join(dir, 'sa.db'));
    const r = migrate(db);
    expect(r).toEqual({ from: 0, to: SCHEMA_VERSION, applied: MIGRATIONS.map((m) => m.name) });
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(readdirSync(dir).filter((f) => f.endsWith('.bak'))).toEqual([]);
  });

  it('is idempotent', () => {
    const db = openTracked(':memory:');
    migrate(db);
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [] });
  });

  it('backs up an existing database before migrating it', () => {
    const file = join(tmp(), 'sa.db');
    const db = openTracked(file);
    migrate(db);
    db.prepare('INSERT INTO target (id, name) VALUES (?, ?)').run('t1', 'keep me');

    const next = extra('CREATE TABLE extra (x TEXT)');
    const r = migrate(db, { migrations: [...MIGRATIONS, next] });
    expect(r.applied).toEqual([next.name]);
    expect(r.backupPath).toBe(`${file}.pre-${pad4(next.version)}.bak`);
    expect(userVersion(db)).toBe(next.version);

    // 複製は移行前の状態（版と行）を持つ
    expect(verifyBackup(r.backupPath!).userVersion).toBe(SCHEMA_VERSION);
    const bak = openTracked(r.backupPath!);
    expect(tableNames(bak)).not.toContain('extra');
    expect(bak.prepare('SELECT name FROM target').all()).toEqual([{ name: 'keep me' }]);
  });

  it('never overwrites an earlier backup', () => {
    const file = join(tmp(), 'sa.db');
    const db = openTracked(file);
    migrate(db);
    const next = extra('CREATE TABLE extra (x TEXT)');
    const first = `${file}.pre-${pad4(next.version)}.bak`;
    writeFileSync(first, 'earlier backup');

    const r = migrate(db, { migrations: [...MIGRATIONS, next] });
    expect(r.backupPath).toBe(`${file}.pre-${pad4(next.version)}.1.bak`);
    expect(existsSync(first)).toBe(true);
  });

  it('applies pending migrations atomically: a failure rolls back the whole batch', () => {
    const file = join(tmp(), 'sa.db');
    const db = openTracked(file);
    migrate(db);
    const ok = extra('CREATE TABLE extra (x TEXT)', 1);
    const broken = extra('CREATE TABLE extra2 (; nonsense', 2);

    const err = catchError(() => migrate(db, { migrations: [...MIGRATIONS, ok, broken] }));
    expect(err).toBeInstanceOf(SaError);
    expect((err as SaError).code).toBe('DB_ERROR');
    expect((err as SaError).message).toContain(broken.name);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(tableNames(db)).not.toContain('extra');
    expect(existsSync(`${file}.pre-${pad4(ok.version)}.bak`)).toBe(true);
  });

  it('rolls back when a migration leaves a foreign key violation', () => {
    const db = openTracked(':memory:');
    migrate(db);
    const bad = extra(
      `PRAGMA defer_foreign_keys = ON;
       INSERT INTO artifact_version (id, target_id, collected_at) VALUES ('v1', 'no-such-target', '${T0}');`,
    );
    const err = catchError(() => migrate(db, { migrations: [...MIGRATIONS, bad] }));
    expect((err as SaError).code).toBe('INTEGRITY_ERROR');
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT count(*) AS n FROM artifact_version').get()).toEqual({ n: 0 });
  });

  it('refuses a database newer than this build', () => {
    const db = openTracked(':memory:');
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    const err = catchError(() => migrate(db));
    expect((err as SaError).code).toBe('DB_ERROR');
    expect(userVersion(db)).toBe(SCHEMA_VERSION + 1);
  });
});

describe('schema (0001_init, 0002_e1)', () => {
  function fresh(): Database {
    const db = openTracked(':memory:');
    migrate(db);
    return db;
  }

  function seed(db: Database): void {
    db.prepare('INSERT INTO target (id, name, scope, created_at) VALUES (?, ?, ?, ?)').run(
      't1',
      'example',
      JSON.stringify({ allowed_domains: ['example.com'], llm_code_policy: 'deny' }),
      T0,
    );
    db.prepare('INSERT INTO artifact_version (id, target_id, collected_at) VALUES (?, ?, ?)').run('v1', 't1', T0);
    db.prepare('INSERT INTO artifact_file (id, version_id, layer, path, content_hash) VALUES (?, ?, ?, ?, ?)').run(
      'f1',
      'v1',
      'raw',
      'v1/raw/f1.js',
      'a'.repeat(64),
    );
  }

  it('creates the M1 and E1 tables', () => {
    expect(tableNames(fresh())).toEqual([
      'analysis_run',
      'api_endpoint',
      'artifact_file',
      'artifact_version',
      'code_location',
      'endpoint_sighting',
      'expected_chunk',
      'page_context',
      'target',
    ]);
  });

  it('enforces foreign keys', () => {
    const db = fresh();
    const err = catchError(() =>
      db.prepare('INSERT INTO artifact_version (id, target_id, collected_at) VALUES (?, ?, ?)').run('v1', 'missing', T0),
    );
    expect((err as { code?: string }).code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('stores rows with the documented defaults and uniqueness', () => {
    const db = fresh();
    seed(db);
    expect(db.prepare('SELECT parse_status FROM artifact_file WHERE id = ?').get('f1')).toEqual({ parse_status: 'ok' });

    db.prepare('INSERT INTO code_location (id, raw_file_id, start_byte, end_byte) VALUES (?, ?, ?, ?)').run('l1', 'f1', 0, 10);
    expect(
      (catchError(() =>
        db.prepare('INSERT INTO code_location (id, raw_file_id, start_byte, end_byte) VALUES (?, ?, ?, ?)').run('l2', 'f1', 0, 10),
      ) as { code?: string }).code,
    ).toBe('SQLITE_CONSTRAINT_UNIQUE');

    db.prepare('INSERT INTO expected_chunk (version_id, chunk_key, referenced_from_location_id, status) VALUES (?, ?, ?, ?)').run(
      'v1',
      '123',
      'l1',
      'missing',
    );
    expect(
      (catchError(() =>
        db.prepare('INSERT INTO expected_chunk (version_id, chunk_key, status) VALUES (?, ?, ?)').run('v1', '123', 'fetched'),
      ) as { code?: string }).code,
    ).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');

    // 版に属さない実行記録（取り込み前の ingest など）も持てる
    db.prepare('INSERT INTO analysis_run (id, kind, tool) VALUES (?, ?, ?)').run('r1', 'ingest', 'load_artifact');
    expect(db.prepare('SELECT version_id FROM analysis_run').get()).toEqual({ version_id: null });
  });

  it('round-trips JSON columns as text', () => {
    const db = fresh();
    seed(db);
    const row = db.prepare('SELECT scope FROM target WHERE id = ?').get('t1') as { scope: string };
    expect(JSON.parse(row.scope)).toEqual({ allowed_domains: ['example.com'], llm_code_policy: 'deny' });
  });

  // design.md §6: 外部キーの子側の列には索引を張る。UNIQUE / PK の自動索引と重なる索引は張らない。
  // 移行を足すたびにこの検査が全表に掛かる
  describe('index rules (all tables)', () => {
    interface IndexInfo {
      name: string;
      origin: string;
      columns: string[];
    }
    function indexes(db: Database, table: string): IndexInfo[] {
      return (db.prepare('SELECT name, origin FROM pragma_index_list(?)').all(table) as { name: string; origin: string }[]).map(
        (ix) => ({
          ...ix,
          columns: (db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(ix.name) as { name: string }[]).map(
            (c) => c.name,
          ),
        }),
      );
    }

    it('every foreign key child column leads some index', () => {
      const db = fresh();
      const missing: string[] = [];
      for (const table of tableNames(db)) {
        const leading = new Set(indexes(db, table).map((ix) => ix.columns[0]));
        const fks = db.prepare('SELECT "from" AS col, "table" AS parent FROM pragma_foreign_key_list(?)').all(table) as {
          col: string;
          parent: string;
        }[];
        for (const fk of fks) if (!leading.has(fk.col)) missing.push(`${table}(${fk.col}) -> ${fk.parent}`);
      }
      expect(missing).toEqual([]);
    });

    it('no explicit index duplicates a prefix of a UNIQUE / PRIMARY KEY index', () => {
      const db = fresh();
      const redundant: string[] = [];
      for (const table of tableNames(db)) {
        const all = indexes(db, table);
        const auto = all.filter((ix) => ix.origin !== 'c');
        for (const ix of all.filter((i) => i.origin === 'c')) {
          const dup = auto.find((a) => ix.columns.every((c, i) => a.columns[i] === c));
          if (dup) redundant.push(`${ix.name} duplicates ${dup.name}`);
        }
      }
      expect(redundant).toEqual([]);
    });
  });
});
