/**
 * 移行の登録簿。番号順に並べ、version は 1 からの連番にする（migrate() が検査する）。
 * 新しい移行は NNNN_<name>.sql を足してここに 1 行追加する。
 */
import init0001 from './0001_init.sql';
import e10002 from './0002_e1.sql';

export interface Migration {
  /** PRAGMA user_version に書く値。1 からの連番 */
  readonly version: number;
  /** ファイル名（拡張子なし）。NNNN_<name> */
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '0001_init', sql: init0001 },
  { version: 2, name: '0002_e1', sql: e10002 },
];
