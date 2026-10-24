/**
 * 設定の解決（docs/architecture.md §3.5）。
 * - home（データの置き場所）: 引数 > 環境変数 SA_HOME > ~/.sa
 * - 設定ファイル: 引数 > 環境変数 SA_CONFIG > <home>/config.json（無ければ既定値だけ）
 * - 設定ファイルのパスは、そのファイルの場所からの相対でもよい
 * - 外部ツール: 設定ファイルの tools > 環境変数 SA_TOOLS が指す tools.json（実行イメージの /opt/sa/tools.json）
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SaConfigFileSchema, type ToolConfigInput, ToolsFileSchema } from '@sa/types';
import { DEFAULT_CONFIG, DEFAULT_TOOL_TIMEOUT_MS, type SaConfig, type ToolConfig, type ToolsConfig } from './context';
import { SaError } from './errors';
import { parseInput } from './validate';

export const CONFIG_FILE_NAME = 'config.json';

export interface ResolveConfigOptions {
  home?: string;
  configPath?: string;
  env?: Record<string, string | undefined>;
}

export interface ResolvedConfig {
  home: string;
  /** 読んだ設定ファイル。無ければ null */
  configFile: string | null;
  config: SaConfig;
}

/** home の下に既定の配置（sa.db / blobs / workspace）を置いた設定 */
export function configForHome(home: string): SaConfig {
  const h = resolve(home);
  return { ...DEFAULT_CONFIG, dbPath: join(h, 'sa.db'), blobDir: join(h, 'blobs'), workspaceDir: join(h, 'workspace') };
}

export function resolveConfig(opts: ResolveConfigOptions = {}): ResolvedConfig {
  const env = opts.env ?? process.env;
  const home = resolve(opts.home ?? nonEmpty(env.SA_HOME) ?? join(homedir(), '.sa'));
  const explicit = opts.configPath ?? nonEmpty(env.SA_CONFIG);
  const configFile = explicit !== undefined ? resolve(explicit) : join(home, CONFIG_FILE_NAME);
  const base = { ...configForHome(home), tools: toolsFromFile(nonEmpty(env.SA_TOOLS)) };

  if (!existsSync(configFile)) {
    if (explicit !== undefined) throw new SaError('INVALID_INPUT', `config file not found: ${configFile}`);
    return { home, configFile: null, config: base };
  }

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(configFile, 'utf8'));
  } catch (err) {
    throw new SaError('INVALID_INPUT', `cannot read config file ${configFile}`, { configFile }, { cause: err });
  }
  const file = parseInput(SaConfigFileSchema, json, `config file ${configFile}`);
  const fromFile = (p: string | undefined, fallback: string) => (p === undefined ? fallback : resolve(dirname(configFile), p));
  return {
    home,
    configFile,
    config: {
      dbPath: fromFile(file.dbPath, base.dbPath),
      blobDir: fromFile(file.blobDir, base.blobDir),
      workspaceDir: fromFile(file.workspaceDir, base.workspaceDir),
      busyTimeoutMs: file.busyTimeoutMs ?? base.busyTimeoutMs,
      ...(file.maxWorkers !== undefined && { maxWorkers: file.maxWorkers }),
      ...(file.maxChildren !== undefined && { maxChildren: file.maxChildren }),
      workerLimits: { ...base.workerLimits, ...file.workerLimits },
      mapCheckThreshold: file.mapCheckThreshold ?? base.mapCheckThreshold,
      tools: {
        ...base.tools,
        ...(file.tools?.jsluice && { jsluice: toolConfig(file.tools.jsluice, dirname(configFile)) }),
      },
    },
  };
}

/** SA_TOOLS が指す tools.json から使うツールを読む。指定が無ければ空 */
function toolsFromFile(file: string | undefined): ToolsConfig {
  if (file === undefined) return {};
  const path = resolve(file);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SaError('INVALID_INPUT', `cannot read the tools file ${path} (SA_TOOLS)`, { path }, { cause: err });
  }
  const tools = parseInput(ToolsFileSchema, json, `tools file ${path}`);
  const jsluice = tools.jsluice;
  return jsluice?.path !== undefined
    ? { jsluice: toolConfig({ path: jsluice.path, ...(jsluice.version !== undefined && { version: jsluice.version }) }, dirname(path)) }
    : {};
}

function toolConfig(t: ToolConfigInput, baseDir: string): ToolConfig {
  return {
    path: resolve(baseDir, t.path),
    ...(t.version !== undefined && { version: t.version }),
    timeoutMs: t.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
  };
}

function nonEmpty(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}
