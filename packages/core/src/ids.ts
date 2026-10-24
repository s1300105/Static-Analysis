/**
 * ID と時刻（docs/architecture.md §9）。ID は ULID、時刻は ISO 8601 UTC。
 */
import { monotonicFactory } from 'ulid';

const nextUlid = monotonicFactory();

/** 新しい ULID。同じミリ秒内でも単調増加するので、ID の辞書順が作成順になる */
export function newId(): string {
  return nextUlid();
}

/** 現在時刻の ISO 8601 UTC 文字列（例 2026-10-24T03:14:45.123Z） */
export function nowIso(): string {
  return new Date().toISOString();
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** newId() が作る形（Crockford base32 の 26 文字）か。パスに埋める ID の検査に使う（原則8） */
export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}
