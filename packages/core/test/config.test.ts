import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  DEFAULT_TOOL_TIMEOUT_MS,
  SCHEMA_VERSION,
  type MigrateResult,
  closeContext,
  configForHome,
  openContext,
  resolveConfig,
  userVersion,
} from '@sa/core';
import { catchError, useTmpDir } from './helpers';

const tmp = useTmpDir();
const code = (fn: () => unknown) => (catchError(fn) as { code: string }).code;

describe('resolveConfig', () => {
  it('uses SA_HOME and the default layout when there is no config file', () => {
    const home = tmp();
    expect(resolveConfig({ env: { SA_HOME: home } })).toEqual({
      home,
      configFile: null,
      config: {
        ...DEFAULT_CONFIG,
        dbPath: join(home, 'sa.db'),
        blobDir: join(home, 'blobs'),
        workspaceDir: join(home, 'workspace'),
      },
    });
  });

  it('prefers the home argument over SA_HOME', () => {
    const home = tmp();
    expect(resolveConfig({ home, env: { SA_HOME: tmp() } }).home).toBe(home);
  });

  it('reads <home>/config.json, resolving its paths relative to the file and merging worker limits', () => {
    const home = tmp();
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ workspaceDir: 'ws', blobDir: '/data/blobs', workerLimits: { timeoutMs: 5000 }, maxWorkers: 3, mapCheckThreshold: 0.8 }),
    );
    const r = resolveConfig({ home, env: {} });
    expect(r.configFile).toBe(join(home, 'config.json'));
    expect(r.config).toMatchObject({
      dbPath: join(home, 'sa.db'),
      blobDir: '/data/blobs',
      workspaceDir: join(home, 'ws'),
      maxWorkers: 3,
      mapCheckThreshold: 0.8,
      workerLimits: { ...DEFAULT_CONFIG.workerLimits, timeoutMs: 5000 },
    });
  });

  it('reads an explicit config file from SA_CONFIG', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ dbPath: 'db/x.db' }));
    const r = resolveConfig({ home: tmp(), env: { SA_CONFIG: join(dir, 'other.json') } });
    expect(r.config.dbPath).toBe(join(dir, 'db', 'x.db'));
  });

  it('rejects a missing explicit file, broken JSON and unknown keys', () => {
    const home = tmp();
    expect(code(() => resolveConfig({ home, configPath: join(home, 'missing.json'), env: {} }))).toBe('INVALID_INPUT');
    writeFileSync(join(home, 'config.json'), '{ not json');
    expect(code(() => resolveConfig({ home, env: {} }))).toBe('INVALID_INPUT');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ workspace: 'typo' }));
    expect(code(() => resolveConfig({ home, env: {} }))).toBe('INVALID_INPUT');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ mapCheckThreshold: 2 }));
    expect(code(() => resolveConfig({ home, env: {} }))).toBe('INVALID_INPUT');
  });

  it('takes tools from the image tools file (SA_TOOLS) and lets config.json override them', () => {
    const home = tmp();
    const image = tmp();
    // 実行イメージの /opt/sa/tools.json と同じ形（使わないツールの項目もある）
    writeFileSync(
      join(image, 'tools.json'),
      JSON.stringify({
        codeql: { path: '/opt/codeql/codeql', version: '2.27.3' },
        jsluice: { path: 'bin/jsluice', version: 'v0.0.0-x' },
        node: { version: 'v22' },
      }),
    );
    const env = { SA_TOOLS: join(image, 'tools.json') };
    expect(resolveConfig({ home, env }).config.tools).toEqual({
      jsluice: { path: join(image, 'bin', 'jsluice'), version: 'v0.0.0-x', timeoutMs: DEFAULT_TOOL_TIMEOUT_MS },
    });
    expect(resolveConfig({ home, env: {} }).config.tools).toEqual({});

    writeFileSync(join(home, 'config.json'), JSON.stringify({ tools: { jsluice: { path: './jsluice', timeoutMs: 5000 } } }));
    expect(resolveConfig({ home, env }).config.tools).toEqual({ jsluice: { path: join(home, 'jsluice'), timeoutMs: 5000 } });

    writeFileSync(join(home, 'config.json'), JSON.stringify({ tools: { jsluice: { version: 'x' } } }));
    expect(code(() => resolveConfig({ home, env }))).toBe('INVALID_INPUT');
    writeFileSync(join(home, 'config.json'), '{}');
    expect(code(() => resolveConfig({ home, env: { SA_TOOLS: join(image, 'missing.json') } }))).toBe('INVALID_INPUT');
  });
});

describe('openContext / closeContext', () => {
  it('creates private directories, migrates once and closes', () => {
    const home = join(tmp(), 'nested', 'home');
    const migrations: MigrateResult[] = [];
    const ctx = openContext({ config: configForHome(home), caller: 'cli', onMigrated: (r) => migrations.push(r) });
    expect(userVersion(ctx.db)).toBe(SCHEMA_VERSION);
    expect(migrations).toHaveLength(1);
    for (const dir of [home, join(home, 'blobs'), join(home, 'workspace')]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(ctx.caller).toBe('cli');
    closeContext(ctx);
    expect(ctx.db.open).toBe(false);
    closeContext(ctx); // 二度目は何もしない

    const again = openContext({ config: configForHome(home), caller: 'mcp', onMigrated: (r) => migrations.push(r) });
    expect(migrations).toHaveLength(1);
    closeContext(again);
  });

  it('rejects an unknown caller before touching the filesystem', () => {
    const home = join(tmp(), 'never');
    expect(code(() => openContext({ config: configForHome(home), caller: 'ui' as 'cli' }))).toBe('INVALID_INPUT');
    expect(existsSync(home)).toBe(false);
  });

  it('keeps an existing directory as it is', () => {
    const home = tmp();
    mkdirSync(join(home, 'workspace'), { mode: 0o755 });
    closeContext(openContext({ config: configForHome(home), caller: 'cli' }));
    expect(statSync(join(home, 'workspace')).mode & 0o777).toBe(0o755);
  });
});
