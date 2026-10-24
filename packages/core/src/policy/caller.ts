/**
 * 入口ごとの権限（design.md §4・§7、docs/architecture.md §3.6）。
 * 人間の判断を書く操作（target.scope、判定、事実の登録・取消、ルールの有効化…）は CLI からだけ許す。
 * 「MCP サーバがそのツールを公開しない」ことと合わせた二重防御のうち、sa-core 側の一層。
 */
import type { CallerKind } from '@sa/types';
import { SaError } from '../errors';

export function assertHumanCaller(ctx: { caller: CallerKind }, operation: string): void {
  if (ctx.caller !== 'cli') {
    throw new SaError('POLICY_DENIED', `${operation} is only allowed from the CLI (caller=${ctx.caller})`, {
      operation,
      caller: ctx.caller,
    });
  }
}
