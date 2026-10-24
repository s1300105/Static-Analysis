/**
 * code_location のリポジトリ関数（design.md §6.1・§6.6）。位置は raw 基準のバイト範囲で持つ。
 * 作るのは resolve_location とエンジン出力の取り込み（抽出器など）だけ（docs/architecture.md §8）。
 */
import { SaError } from '../../errors';
import { newId } from '../../ids';
import { type HasDb, dbCall } from '../connection';

export interface NewCodeLocation {
  rawFileId: string;
  startByte: number;
  endByte: number;
  /** 表示用の派生値（1 始まりの行、0 始まりの列） */
  line?: number;
  col?: number;
}

/** 同じ raw の同じ範囲は 1 行にまとめる（UNIQUE (raw_file_id, start_byte, end_byte)）。行の ID を返す */
export function ensureCodeLocation(ctx: HasDb, l: NewCodeLocation): string {
  if (!Number.isInteger(l.startByte) || !Number.isInteger(l.endByte) || l.startByte < 0 || l.endByte < l.startByte) {
    throw new SaError('INVALID_INPUT', `invalid byte range ${l.startByte}-${l.endByte}`);
  }
  const row = dbCall(
    () =>
      ctx.db
        .prepare(
          `INSERT INTO code_location (id, raw_file_id, start_byte, end_byte, line, col) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (raw_file_id, start_byte, end_byte)
           DO UPDATE SET line = coalesce(code_location.line, excluded.line), col = coalesce(code_location.col, excluded.col)
           RETURNING id`,
        )
        .get(newId(), l.rawFileId, l.startByte, l.endByte, l.line ?? null, l.col ?? null) as { id: string },
  );
  return row.id;
}
