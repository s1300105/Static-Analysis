// JobSkipError と同じ形（skipReason プロパティ）の例外を投げる
export default function ({ reason, message }) {
  throw Object.assign(new Error(message), { skipReason: reason });
}
