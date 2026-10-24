/**
 * @sa/core の公開 API。
 * いまは骨格だけ（errors）。手順1以降で context / db / store / jobs / policy /
 * artifact / intel / analysis / findings を足していく（docs/architecture.md §3）。
 */
export * from './errors';

/** パッケージ版。実行記録 analysis_run.tool_version の一部に使う予定 */
export const CORE_VERSION = '0.0.0';
