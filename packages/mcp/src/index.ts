import { SaError } from '@sa/core';

/**
 * 薄い MCP サーバ。design.md §7 で「MCP ○」のツールだけを公開し、
 * 人間の判定を書く操作（verdict / 事実 / target.scope など）は登録しない（design.md §4）。
 * いまは骨格だけ。手順2（E1 の読み取りツール）から中身を足す。
 */
export function createMcpServer(): never {
  throw new SaError('NOT_IMPLEMENTED', 'sa-mcp server is not implemented yet');
}
