/**
 * 実行記録 analysis_run.skipped_detail の形（design.md §6.1・§6.6）。
 * 採点（@sa/eval）もこの形を読むので @sa/types に置く。
 */
import type { SkipReason } from './vocab';

export interface SkipEntry {
  /** スキップしたファイル（artifact_file.id）。files_skipped に数える */
  fileId?: string;
  /** ファイルの一部だけを落としたときの対象（モジュール ID・位置など）。files_skipped には数えない */
  ref?: string;
  detail?: string;
}

export interface SkipBucket {
  /** その理由のスキップの総数 */
  count: number;
  /** 先頭から上限件まで（count より少ないことがある） */
  items: SkipEntry[];
}

/** 理由別のスキップ。出現しなかった理由のキーは持たない */
export type SkippedDetail = Partial<Record<SkipReason, SkipBucket>>;
