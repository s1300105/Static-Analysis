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

/**
 * sourcemap の簡易検証の結果（artifact_file.map_check。design.md §6.6）。
 * names 付きのセグメントを抜き取り、生成側の位置が raw のトークン（識別子）の先頭に当たるか、
 * 元側の位置の識別子が names[i] と一致するかを数える。両方を満たした割合 rate が threshold 以上なら original 層を作る。
 */
export interface MapCheck {
  /** 検査した names 付きセグメントの数 */
  sampled: number;
  /** 生成側の位置が識別子の先頭に当たった数 */
  generatedTokenStart: number;
  /** 元側の識別子が names[i] と一致した数 */
  originalNameMatch: number;
  /** 両方を満たした数 */
  matched: number;
  /** matched / sampled（sampled=0 なら 0） */
  rate: number;
  threshold: number;
  accepted: boolean;
}
