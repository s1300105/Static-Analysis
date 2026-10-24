/**
 * スコープの判定（design.md §6.1 target.scope、§6.2 in_scope、§7.1 find_missing_chunks の host_in_scope）。
 * VIEW api_endpoint_summary（0002_e1.sql）の in_scope と同じ規則（テストで一致を確かめる）:
 * - "example.com" はそのホストだけ、"*.example.com" はサブドメインだけ（example.com 自体は含まない）
 * - out_of_scope に当たれば対象外。allowed_domains に当たれば対象。どちらにも当たらなければ対象外
 * - ホストが分からない（origin が空）か、allowed_domains が空なら判定しない（null）
 */
import type { TargetScope } from '@sa/types';

/** origin（scheme://host[:port] か //host）からホストを取り出す（小文字）。無ければ '' */
export function hostOfOrigin(origin: string): string {
  const i = origin.indexOf('://');
  const hostport = i >= 0 ? origin.slice(i + 3) : origin.replace(/^\/+/, '');
  const colon = hostport.indexOf(':');
  return (colon >= 0 ? hostport.slice(0, colon) : hostport).toLowerCase();
}

export function matchesHostPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (h === p) return true;
  return p.startsWith('*.') && h.length > p.length - 1 && h.endsWith(p.slice(1));
}

export function originInScope(origin: string, scope: TargetScope | null): boolean | null {
  const host = hostOfOrigin(origin);
  if (host === '' || !scope || scope.allowed_domains.length === 0) return null;
  if (scope.out_of_scope.some((p) => matchesHostPattern(host, p))) return false;
  return scope.allowed_domains.some((p) => matchesHostPattern(host, p));
}
