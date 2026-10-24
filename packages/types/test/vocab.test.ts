import { describe, expect, it } from 'vitest';
import {
  EXPAND_FACT_TYPES,
  FACT_META,
  FACT_TYPES,
  SUPPRESS_FACT_TYPES,
  TargetScopeSchema,
  polarityOf,
} from '@sa/types';

describe('fact vocabulary', () => {
  it('FACT_META covers every fact type exactly once', () => {
    expect(Object.keys(FACT_META).sort()).toEqual([...FACT_TYPES].sort());
  });

  it('polarity grouping is consistent with FACT_META', () => {
    for (const ft of EXPAND_FACT_TYPES) expect(FACT_META[ft].polarity).toBe('expand');
    for (const ft of SUPPRESS_FACT_TYPES) expect(FACT_META[ft].polarity).toBe('suppress');
    expect(polarityOf('tainted_source')).toBe('expand');
    expect(polarityOf('unreachable')).toBe('suppress');
  });

  it('server-dependent facts match design.md §6.4', () => {
    expect(FACT_META.tainted_source.serverDependent).toBe(true);
    expect(FACT_META.not_controllable.serverDependent).toBe(true);
    expect(FACT_META.fake_sanitizer.serverDependent).toBe(false);
  });
});

describe('TargetScopeSchema', () => {
  it('defaults llm_code_policy to deny and rejects unknown keys', () => {
    const parsed = TargetScopeSchema.parse({});
    expect(parsed.llm_code_policy).toBe('deny');
    expect(parsed.allowed_domains).toEqual([]);
    expect(() => TargetScopeSchema.parse({ bogus: 1 })).toThrow();
  });
});
