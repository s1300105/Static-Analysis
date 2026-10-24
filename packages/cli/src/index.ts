import { SaError } from '@sa/core';
import { Command } from 'commander';

/** CLI 版。後で package.json と同期する */
export const CLI_VERSION = '0.0.0';

const notImplemented = (name: string) => () => {
  throw new SaError('NOT_IMPLEMENTED', `sa ${name} is not implemented yet`);
};

/**
 * `sa` コマンドを組み立てる。入口は sa-core を呼ぶだけの薄い層にする（docs/architecture.md §6.1）。
 * いまは骨格だけで、各サブコマンドは未実装。手順1以降で中身を足す。
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('sa')
    .description('Static analysis for JS/TS bundles (Bug Bounty, no target traffic). See docs/design.md.')
    .version(CLI_VERSION);

  program
    .command('target')
    .description('対象とスコープ（llm_code_policy を含む）の管理（未実装）')
    .action(notImplemented('target'));

  program
    .command('load')
    .description('raw 層として成果物を取り込む（未実装）')
    .action(notImplemented('load'));

  return program;
}
