/**
 * 座標。唯一の基準座標は「raw ファイル＋バイト範囲」（design.md §6.6）。
 * line:col は表示用の派生値で、基準には使わない。
 */
export interface RawRange {
  /** raw 層の artifact_file.id */
  rawFileId: string;
  /** 開始バイト（含む） */
  startByte: number;
  /** 終了バイト（含まない） */
  endByte: number;
}

/** 表示用の派生位置。証拠の基準には使わない */
export interface DisplayPosition {
  line: number;
  col: number;
  /** sourcemap があれば 元ファイル:行:列（表示用） */
  origRef?: string;
}
