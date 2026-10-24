import { Command, CommanderError } from 'commander';
import { registerBackupCommand } from './commands/backup';
import { registerMissingChunksCommand } from './commands/chunks';
import { registerEndpointCommands } from './commands/endpoints';
import { registerImportHarCommand } from './commands/har';
import { registerLoadCommand } from './commands/load';
import { registerTargetCommands } from './commands/target';
import { type CliIo, describeFailure } from './io';

export type { CliIo } from './io';

/** CLI 版。後で package.json と同期する */
export const CLI_VERSION = '0.0.0';

/**
 * `sa` コマンドを組み立てる。入口は sa-core を呼ぶだけの薄い層にする（docs/architecture.md §6.1）。
 * 判定・事実・target.scope を書けるのはこの入口だけ（sa-core は caller='cli' のときだけ許す）。
 */
export function buildProgram(io: CliIo): Command {
  const program = new Command();
  // 出力先と終了の扱いは、後から足すサブコマンドにも引き継がれる
  program
    .configureOutput({ writeOut: (s) => io.stdout(s), writeErr: (s) => io.stderr(s) })
    .exitOverride()
    .name('sa')
    .description('Static analysis for JS/TS bundles (Bug Bounty, no target traffic). See docs/design.md.')
    .version(CLI_VERSION)
    .option('--home <dir>', 'データの置き場所（既定: $SA_HOME か ~/.sa）')
    .option('--config <file>', '設定ファイル（既定: $SA_CONFIG か <home>/config.json）')
    .option('--json', '結果を JSON で出す');

  registerTargetCommands(program, io);
  registerLoadCommand(program, io);
  registerImportHarCommand(program, io);
  registerMissingChunksCommand(program, io);
  registerEndpointCommands(program, io);
  registerBackupCommand(program, io);
  return program;
}

/** argv（process.argv の形）を実行し、終了コードを返す */
export async function run(argv: string[], io: CliIo): Promise<number> {
  try {
    await buildProgram(io).parseAsync(argv);
    return 0;
  } catch (err) {
    // 使い方の誤り・--help・--version は commander が出力済み
    if (err instanceof CommanderError) return err.exitCode;
    const { message, exitCode } = describeFailure(err);
    io.stderr(message);
    return exitCode;
  }
}
