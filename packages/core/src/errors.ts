/**
 * sa-core の型付きエラー。入口（CLI/MCP）がコードで分岐できるようにする。
 * 書き込み失敗は握りつぶさず SaError として投げる（design.md §6）。
 */
export type SaErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'INVALID_INPUT'
  | 'POLICY_DENIED' // llm_code_policy など（design.md §7.2）
  | 'ILLEGAL_TRANSITION' // 状態遷移の権限違反（design.md §6.3）
  | 'NOT_FOUND'
  | 'DB_ERROR'
  | 'INTEGRITY_ERROR' // blob のハッシュ不一致、移行後の外部キー違反、バックアップの検査失敗
  | 'IO_ERROR' // blob ストアなどファイルの読み書きの失敗
  | 'TOOL_ERROR'; // 外部ツール（CodeQL/Semgrep/jsluice/Babel）の失敗

export class SaError extends Error {
  readonly code: SaErrorCode;
  readonly detail?: unknown;

  constructor(code: SaErrorCode, message: string, detail?: unknown, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SaError';
    this.code = code;
    this.detail = detail;
  }
}

export function isSaError(err: unknown): err is SaError {
  return err instanceof SaError;
}
