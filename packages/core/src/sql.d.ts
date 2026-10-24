// 移行 SQL はビルド時に文字列として埋め込む（tsup の --loader .sql=text、vitest は vitest.config.ts のプラグイン）
declare module '*.sql' {
  const sql: string;
  export default sql;
}
