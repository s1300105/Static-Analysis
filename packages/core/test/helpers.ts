import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  DEFAULT_CONFIG,
  type Database,
  type OpenDatabaseOptions,
  type SaConfig,
  type SaContext,
  migrate,
  openBlobStore,
  openDatabase,
} from '@sa/core';
import { createJobRunner } from '../src/jobs/runner';

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

/** 一時ディレクトリに DB（移行済み）・blob ストア・作業ディレクトリを持つ SaContext を作る。afterEach で閉じて消す */
export function useContext(): (config?: Partial<SaConfig>) => SaContext {
  const tmp = useTmpDir();
  const openDb = useDatabases();
  return (config = {}) => {
    const dir = tmp();
    const db = openDb(join(dir, 'sa.db'));
    migrate(db);
    const workspaceDir = join(dir, 'workspace');
    mkdirSync(workspaceDir);
    return {
      db,
      store: openBlobStore(join(dir, 'blobs')),
      jobs: createJobRunner({ maxWorkers: 2 }),
      config: { ...DEFAULT_CONFIG, workspaceDir, ...config },
      caller: 'cli',
    };
  };
}
