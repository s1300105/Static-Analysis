/**
 * 入出力と共通の処理。CLI は sa-core を呼んで結果を整形するだけにする（docs/architecture.md §6.1）。
 */
import { isAbsolute, resolve } from 'node:path';
import {
  type SaContext,
  type SaErrorCode,
  closeContext,
  isSaError,
  openContext,
  resolveConfig,
} from '@sa/core';
import type { Command } from 'commander';

/** テストから差し替えられるように、標準出力・環境変数・カレントディレクトリをまとめて渡す */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
}

export interface GlobalOptions {
  home?: string;
  config?: string;
  json?: boolean;
}

/** SaError のコード → 終了コード。それ以外の失敗は 1 */
export const EXIT_CODES: Partial<Record<SaErrorCode, number>> = {
  INVALID_INPUT: 2,
  NOT_FOUND: 3,
  POLICY_DENIED: 4,
};

export function globals(cmd: Command): GlobalOptions {
  return cmd.optsWithGlobals<GlobalOptions>();
}

/** コマンドラインで受けたパスはカレントディレクトリから解く */
export function absolute(io: CliIo, p: string): string {
  return isAbsolute(p) ? p : resolve(io.cwd, p);
}

/** 設定を解決して SaContext を開き、fn の後で必ず閉じる。caller は cli */
export async function withContext<T>(cmd: Command, io: CliIo, fn: (ctx: SaContext) => Promise<T> | T): Promise<T> {
  const g = globals(cmd);
  const { config } = resolveConfig({
    ...(g.home !== undefined && { home: absolute(io, g.home) }),
    ...(g.config !== undefined && { configPath: absolute(io, g.config) }),
    env: io.env,
  });
  const ctx = openContext({
    config,
    caller: 'cli',
    onMigrated: (r) =>
      io.stderr(`migrated the database schema ${r.from} -> ${r.to}${r.backupPath ? ` (backup: ${r.backupPath})` : ''}\n`),
  });
  try {
    return await fn(ctx);
  } finally {
    closeContext(ctx);
  }
}

/** --json なら data を JSON で、そうでなければ人が読む行を出す */
export function emit(cmd: Command, io: CliIo, data: unknown, human: () => string[]): void {
  if (globals(cmd).json) io.stdout(`${JSON.stringify(data, null, 2)}\n`);
  else io.stdout(`${human().join('\n')}\n`);
}

/** 失敗を人が読むメッセージと終了コードにする */
export function describeFailure(err: unknown): { message: string; exitCode: number } {
  if (isSaError(err)) {
    const lines = [`error: ${err.message} [${err.code}]`];
    const issues = (err.detail as { issues?: { path?: (string | number)[]; message?: string }[] } | undefined)?.issues;
    for (const i of issues ?? []) lines.push(`  - ${i.path && i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message ?? ''}`);
    return { message: `${lines.join('\n')}\n`, exitCode: EXIT_CODES[err.code] ?? 1 };
  }
  return { message: `error: ${err instanceof Error ? err.message : String(err)}\n`, exitCode: 1 };
}
