import { describe, expect, it } from 'vitest';
import { newId, nowIso } from '@sa/core';

describe('ids', () => {
  it('newId returns a ULID', () => {
    expect(newId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('newId is unique and sorts in creation order, even within the same millisecond', () => {
    const ids = Array.from({ length: 1000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it('nowIso returns ISO 8601 UTC', () => {
    const s = nowIso();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(s).toISOString()).toBe(s);
  });
});
