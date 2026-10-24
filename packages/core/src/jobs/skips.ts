/**
 * スキップの記録（design.md §6.6「すべて実行ごとに analysis_run.skipped_detail に理由別で記録する」）。
 * 1 回の実行（analysis_run 1 行）につき 1 つ作り、終わったら summary() を finishAnalysisRun に渡す。
 */
import { SKIP_REASONS, type SkipBucket, type SkipEntry, type SkipReason, type SkippedDetail } from '@sa/types';
import type { JobResult, JobSuccess } from './runner';

/** 理由ごとに残す明細の上限。総数は count に必ず残る（unmapped 等で明細が膨らみすぎないように） */
export const MAX_SKIP_ITEMS_PER_REASON = 1000;

export interface SkipSummary {
  /** スキップしたファイルの数（fileId の異なり数） */
  filesSkipped: number;
  skippedDetail: SkippedDetail;
}

export class SkipLog {
  readonly #buckets = new Map<SkipReason, SkipBucket>();
  readonly #files = new Set<string>();

  add(reason: SkipReason, entry: SkipEntry): void {
    let bucket = this.#buckets.get(reason);
    if (!bucket) {
      bucket = { count: 0, items: [] };
      this.#buckets.set(reason, bucket);
    }
    bucket.count++;
    if (bucket.items.length < MAX_SKIP_ITEMS_PER_REASON) bucket.items.push({ ...entry });
    if (entry.fileId !== undefined) this.#files.add(entry.fileId);
  }

  /**
   * ジョブの結果を見て、失敗ならそのファイルのスキップとして積む。成功したかを返す（成功なら value を使える）。
   * fileId を渡さなければファイル単位には数えない（ref で対象を示す）。
   */
  record<O>(result: JobResult<O>, target: { fileId?: string; ref?: string } = {}): result is JobSuccess<O> {
    if (result.ok) return true;
    this.add(result.reason, { ...target, detail: result.detail });
    return false;
  }

  /** 全理由のスキップ総数 */
  get count(): number {
    let n = 0;
    for (const b of this.#buckets.values()) n += b.count;
    return n;
  }

  get filesSkipped(): number {
    return this.#files.size;
  }

  /** 理由の並びは SKIP_REASONS の順（出力を決定的にする） */
  toJSON(): SkippedDetail {
    const out: SkippedDetail = {};
    for (const reason of SKIP_REASONS) {
      const b = this.#buckets.get(reason);
      if (b) out[reason] = { count: b.count, items: b.items.map((e) => ({ ...e })) };
    }
    return out;
  }

  summary(): SkipSummary {
    return { filesSkipped: this.filesSkipped, skippedDetail: this.toJSON() };
  }
}
