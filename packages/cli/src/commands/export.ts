/**
 * sa export-endpoints: エンドポイントを人間の道具に渡す形でファイルに書く（design.md §7.3 export_endpoints）。
 * REST は OpenAPI 3（openapi.json）、GraphQL は operation の文書（operations.graphql）。スコープ外は既定で出さない。
 * 書き出し先は人間が指定したディレクトリ。既にあるファイルは --force が無ければ上書きしない。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SaError, exportEndpoints, findTarget } from '@sa/core';
import type { Command } from 'commander';
import { type CliIo, absolute, emit, withContext } from '../io';

interface ExportOptions {
  out: string;
  includeOutOfScope?: boolean;
  force?: boolean;
}

export function registerExportCommand(program: Command, io: CliIo): void {
  program
    .command('export-endpoints')
    .description('エンドポイントを OpenAPI 3（openapi.json）と GraphQL の operation の文書（operations.graphql）に書き出す')
    .argument('<target>', '対象の ID か名前')
    .requiredOption('--out <dir>', '書き出すディレクトリ（無ければ作る）')
    .option('--include-out-of-scope', 'スコープ外のホストのエンドポイントも出す')
    .option('--force', '既にあるファイルを上書きする')
    .action(async (targetRef: string, opts: ExportOptions, cmd: Command) => {
      const dir = absolute(io, opts.out);
      const r = await withContext(cmd, io, (ctx) =>
        exportEndpoints(ctx, { targetId: findTarget(ctx, targetRef).id, includeOutOfScope: opts.includeOutOfScope === true }),
      );
      const files: { path: string; content: string }[] = [{ path: join(dir, 'openapi.json'), content: `${JSON.stringify(r.openapi, null, 2)}\n` }];
      if (r.graphql !== '') files.push({ path: join(dir, 'operations.graphql'), content: r.graphql });
      if (opts.force !== true) {
        for (const f of files) if (existsSync(f.path)) throw new SaError('INVALID_INPUT', `${f.path} already exists (use --force to overwrite)`);
      }
      mkdirSync(dir, { recursive: true });
      for (const f of files) writeFileSync(f.path, f.content);
      const summary = { files: files.map((f) => f.path), counts: r.counts };
      emit(cmd, io, summary, () => [
        ...files.map((f) => `wrote ${f.path}`),
        `${r.counts.rest} REST operations, ${r.counts.graphql} GraphQL operations, ${r.counts.websocket} WebSockets, ` +
          `${r.counts.methodUnknown} with an unknown method, ${r.counts.outOfScope} out of scope left out`,
      ]);
    });
}
