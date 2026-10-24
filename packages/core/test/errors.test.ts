import { describe, expect, it } from 'vitest';
import { CORE_VERSION, SaError, isSaError } from '@sa/core';

describe('SaError', () => {
  it('carries a code and detail', () => {
    const err = new SaError('POLICY_DENIED', 'llm_code_policy=deny', { targetId: 't1' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SaError');
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.detail).toEqual({ targetId: 't1' });
    expect(isSaError(err)).toBe(true);
    expect(isSaError(new Error('plain'))).toBe(false);
  });

  it('exposes a version string', () => {
    expect(CORE_VERSION).toBe('0.0.0');
  });
});
