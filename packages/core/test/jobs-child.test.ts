import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ChildSpec, createJobRunner } from '../src/jobs/runner';
import { useTmpDir } from './helpers';

const tmp = useTmpDir();
const runner = createJobRunner({ maxChildren: 4 });

/** node -e <code> [...args] を子プロセスとして動かす */
function node(code: string, over: Partial<ChildSpec> = {}): ChildSpec {
  return { bin: process.execPath, args: ['-e', code], cwd: tmp(), env: {}, timeoutMs: 10_000, ...over };
}

/** pid のプロセスがもう動いていないか（ゾンビは止まっているものとして扱う） */
function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z') ?? false;
  } catch {
    return true;
  }
}

describe('runChild', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const r = await runner.runChild(node("process.stdout.write('out'); process.stderr.write('err')"));
    expect(r).toMatchObject({ ok: true, value: { exitCode: 0, stdout: 'out', stderr: 'err' } });
  });

  it('passes arguments as an array without a shell', async () => {
    const args = ['$(touch pwned); echo hi', 'a b', '*', '`id`', "'quoted'"];
    const cwd = tmp();
    const code = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const r = await runner.runChild(node(code, { cwd, args: ['-e', code, ...args] }));
    if (!r.ok) throw new Error(r.detail);
    expect(JSON.parse(r.value.stdout)).toEqual(args);
    expect(() => readFileSync(join(cwd, 'pwned'))).toThrow();
  });

  it('runs in the given cwd', async () => {
    const cwd = tmp();
    const r = await runner.runChild(node('process.stdout.write(process.cwd())', { cwd }));
    expect(r).toMatchObject({ ok: true, value: { stdout: cwd } });
  });

  describe('environment', () => {
    beforeEach(() => {
      process.env.SA_TEST_SECRET = 'do-not-leak';
    });
    afterEach(() => {
      delete process.env.SA_TEST_SECRET;
    });

    it('passes only the given environment', async () => {
      const r = await runner.runChild(
        node('process.stdout.write(JSON.stringify([process.env.SA_TEST_SECRET ?? null, process.env.TOOL_FLAG ?? null]))', {
          env: { TOOL_FLAG: 'on' },
        }),
      );
      if (!r.ok) throw new Error(r.detail);
      expect(JSON.parse(r.value.stdout)).toEqual([null, 'on']);
    });
  });

  it('reports an unexpected exit code as tool_error with the stderr tail', async () => {
    const r = await runner.runChild(node("process.stderr.write('fatal: bad input'); process.exit(3)"));
    expect(r).toMatchObject({ ok: false, reason: 'tool_error' });
    if (r.ok) return;
    expect(r.detail).toContain('exit code 3');
    expect(r.detail).toContain('fatal: bad input');
  });

  it('accepts the exit codes the tool documents as normal', async () => {
    const r = await runner.runChild(node('process.exit(1)', { okExitCodes: [0, 1] }));
    expect(r).toMatchObject({ ok: true, value: { exitCode: 1 } });
  });

  it('kills the whole process group at the timeout', async () => {
    const pidFile = join(tmp(), 'grandchild.pid');
    const code = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(process.argv[1], String(g.pid));
      setInterval(() => {}, 1000);
    `;
    const r = await runner.runChild(node(code, { args: ['-e', code, pidFile], timeoutMs: 1000 }));
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    await expect.poll(() => isGone(grandchild), { timeout: 3000 }).toBe(true);
  });

  it('cleans up stray grandchildren when the tool exits', async () => {
    const pidFile = join(tmp(), 'grandchild.pid');
    const code = `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(process.argv[1], String(g.pid));
      g.unref();
    `;
    const r = await runner.runChild(node(code, { args: ['-e', code, pidFile] }));
    expect(r).toMatchObject({ ok: true });
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    await expect.poll(() => isGone(grandchild), { timeout: 3000 }).toBe(true);
  });

  it('stops a tool whose output exceeds the limit', async () => {
    const r = await runner.runChild(node("process.stdout.write('x'.repeat(2 * 1024 * 1024))", { maxOutputBytes: 1024 * 1024 }));
    expect(r).toMatchObject({ ok: false, reason: 'tool_error', detail: expect.stringContaining('stdout exceeded') });
  });

  it('reports a missing binary as tool_error', async () => {
    const r = await runner.runChild(node('', { bin: '/nonexistent/sa-tool' }));
    expect(r).toMatchObject({ ok: false, reason: 'tool_error', detail: expect.stringContaining('failed to run') });
  });

  it('rejects caller errors instead of returning a skip', async () => {
    await expect(runner.runChild(node('', { bin: 'node' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(runner.runChild(node('', { cwd: 'relative/dir' }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(runner.runChild(node('', { timeoutMs: -1 }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
