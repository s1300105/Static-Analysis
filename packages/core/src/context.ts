/**
 * SaContext: 入口が 1 つ作って sa-core の関数に渡す束（docs/architecture.md §3.2）。
 * ここでは型と既定値だけを置く。設定の読み込みと openContext / closeContext は PR-5。
 */
import type { CallerKind } from '@sa/types';
import type { Database } from './db/connection';
import { DEFAULT_WORKER_LIMITS, type JobRunner, type WorkerLimits } from './jobs/runner';
import type { BlobStore } from './store/blob';

export interface SaConfig {
  /** 作業ディレクトリ。ツールが生成するパス（policy/paths）はすべてこの下 */
  workspaceDir: string;
  /** Babel parse など worker で動かす処理の上限 */
  workerLimits: WorkerLimits;
  /** sourcemap の簡易検証の一致率の閾値（design.md §13 で未決。評価で決めるまでの既定値） */
  mapCheckThreshold: number;
}

/**
 * 仮の既定値。webpack 5 の fixture で、正しい map は 0.83〜1.0（小さいチャンクでは webpack が合成した
 * `_x__WEBPACK_IMPORTED_MODULE_0__` などの名前が元ソースに無いぶん下がる）、別ビルド・別チャンクの map は 0.01〜0.25 だった。
 * 評価コーパスで決め直す（design.md §13）。
 */
export const DEFAULT_MAP_CHECK_THRESHOLD = 0.7;

export const DEFAULT_CONFIG: Readonly<Omit<SaConfig, 'workspaceDir'>> = {
  workerLimits: DEFAULT_WORKER_LIMITS,
  mapCheckThreshold: DEFAULT_MAP_CHECK_THRESHOLD,
};

export interface SaContext {
  /** better-sqlite3 の接続（PRAGMA 設定済み・移行済み） */
  db: Database;
  store: BlobStore;
  jobs: JobRunner;
  config: SaConfig;
  /** 権限と公開範囲の判定に使う */
  caller: CallerKind;
}
