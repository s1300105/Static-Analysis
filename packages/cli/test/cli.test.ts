import { describe, expect, it } from 'vitest';
import { CLI_VERSION, buildProgram } from '@sa/cli';

describe('sa cli', () => {
  it('reports its version', async () => {
    const program = buildProgram().exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await expect(program.parseAsync(['node', 'sa', '--version'])).rejects.toMatchObject({
      code: 'commander.version',
    });
    expect(CLI_VERSION).toBe('0.0.0');
  });

  it('registers the expected placeholder commands', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toEqual(['load', 'target']);
  });
});
