/**
 * 入口から来た値を @sa/types の zod スキーマで検証する（docs/architecture.md §4・§9）。
 * ドメイン関数も入口で一度検証済みの値を受ける前提にせず、ここを通して SaError('INVALID_INPUT') にそろえる。
 */
import { SaError } from './errors';

interface SafeParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } };
}

export function parseInput<T>(schema: SafeParser<T>, input: unknown, what: string): T {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw new SaError('INVALID_INPUT', `invalid ${what} input`, { issues: r.error.issues });
}
