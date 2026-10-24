import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  type Database,
  type OpenDatabaseOptions,
  type SaConfig,
  type SaContext,
  closeContext,
  configForHome,
  openContext,
  openDatabase,
} from '@sa/core';

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

/** 一時ディレクトリを home にして openContext する（caller は cli）。afterEach で閉じて消す */
export function useContext(): (config?: Partial<SaConfig>) => SaContext {
  const tmp = useTmpDir();
  const contexts: SaContext[] = [];
  afterEach(() => {
    for (const ctx of contexts.splice(0)) closeContext(ctx);
  });
  return (config = {}) => {
    const ctx = openContext({ config: { ...configForHome(tmp()), ...config }, caller: 'cli' });
    contexts.push(ctx);
    return ctx;
  };
}
