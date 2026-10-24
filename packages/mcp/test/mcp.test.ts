import { describe, expect, it } from 'vitest';
import { createMcpServer } from '@sa/mcp';

describe('sa-mcp', () => {
  it('is a skeleton that reports NOT_IMPLEMENTED for now', () => {
    expect(() => createMcpServer()).toThrowError(/not implemented/i);
  });
});
