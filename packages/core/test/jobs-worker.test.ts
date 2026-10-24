import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKER_LIMITS, JobSkipError, createJobRunner, defineWorker } from '../src/jobs/runner';

const fixture = (name: string) => new URL(`./fixtures/workers/${name}.mjs`, import.meta.url);
const limits = (over: Partial<typeof DEFAULT_WORKER_LIMITS> = {}) => ({ ...DEFAULT_WORKER_LIMITS, timeoutMs: 10_000, ...over });

describe('runWorker', () => {
  const runner = createJobRunner({ maxWorkers: 4 });

  it('returns the value of the job module default export', async () => {
    const r = await runner.runWorker(defineWorker<{ n: number }, { doubled: number }>('double', fixture('double')), { n: 21 }, limits());
    expect(r).toMatchObject({ ok: true, value: { doubled: 42 } });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('maps a JobSkipError-shaped throw to its skip reason', async () => {
    const r = await runner.runWorker(defineWorker('skip', fixture('skip')), { reason: 'parse_failed', message: 'Unexpected token (1:5)' }, limits());
    expect(r).toMatchObject({ ok: false, reason: 'parse_failed', detail: 'skip: Unexpected token (1:5)' });
  });

  it('treats an unknown skip reason and other errors as tool_error', async () => {
    expect(await runner.runWorker(defineWorker('skip', fixture('skip')), { reason: 'bogus', message: 'x' }, limits())).toMatchObject({
      ok: false,
      reason: 'tool_error',
    });
    expect(await runner.runWorker(defineWorker('throw', fixture('throw')), {}, limits())).toMatchObject({
      ok: false,
      reason: 'tool_error',
      detail: 'throw: something broke',
    });
  });

  it('reports broken job modules as tool_error', async () => {
    for (const name of ['no-default', 'missing-module']) {
      expect(await runner.runWorker(defineWorker(name, fixture(name)), {}, limits())).toMatchObject({ ok: false, reason: 'tool_error' });
    }
    expect(await runner.runWorker(defineWorker('uncloneable', fixture('uncloneable')), {}, limits())).toMatchObject({
      ok: false,
      reason: 'tool_error',
      detail: expect.stringContaining('not cloneable'),
    });
  });

  it('stops a runaway job at the wall-clock timeout', async () => {
    const r = await runner.runWorker(defineWorker('spin', fixture('spin')), {}, limits({ timeoutMs: 300 }));
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(r.durationMs).toBeGreaterThanOrEqual(300);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it('stops a job that exceeds the heap limit as oom', async () => {
    const r = await runner.runWorker(defineWorker('grow', fixture('grow')), {}, limits({ maxOldGenMb: 32 }));
    expect(r).toMatchObject({ ok: false, reason: 'oom' });
  });

  it('applies stackSizeMb', async () => {
    const depth = defineWorker<object, number>('depth', fixture('depth'));
    const small = await runner.runWorker(depth, {}, limits({ stackSizeMb: 4 }));
    const large = await runner.runWorker(depth, {}, limits({ stackSizeMb: 64 }));
    if (!small.ok || !large.ok) throw new Error('depth job failed');
    expect(large.value).toBeGreaterThan(small.value * 4);
  });

  describe('environment', () => {
    beforeEach(() => {
      process.env.SA_TEST_SECRET = 'do-not-leak';
    });
    afterEach(() => {
      delete process.env.SA_TEST_SECRET;
    });

    it('does not expose the parent environment to the job', async () => {
      expect(await runner.runWorker(defineWorker('env', fixture('env')), {}, limits())).toMatchObject({ ok: true, value: null });
    });
  });

  it('rejects caller errors instead of returning a skip', async () => {
    await expect(runner.runWorker(defineWorker('http', new URL('https://example.com/x.mjs')), {}, limits())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(runner.runWorker(defineWorker('double', fixture('double')), {}, limits({ timeoutMs: 0 }))).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(runner.runWorker(defineWorker('double', fixture('double')), { fn: () => 1 }, limits())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('limits concurrency and starts the timeout only when the job starts', async () => {
    const serial = createJobRunner({ maxWorkers: 1 });
    const sleep = defineWorker<{ ms: number }, { start: number; end: number }>('sleep', fixture('sleep'));
    const [a, b, c] = await Promise.all([
      serial.runWorker(sleep, { ms: 300 }, limits()),
      // 待ち行列にいる間は数えないので、300ms 待たされても 200ms のタイムアウトに掛からない
      serial.runWorker(sleep, { ms: 10 }, limits({ timeoutMs: 200 })),
      serial.runWorker(sleep, { ms: 10 }, limits()),
    ]);
    if (!a?.ok || !b?.ok || !c?.ok) throw new Error('sleep job failed');
    expect(b.value.start).toBeGreaterThanOrEqual(a.value.end);
    expect(c.value.start).toBeGreaterThanOrEqual(b.value.end);
  });
});

describe('JobSkipError', () => {
  it('carries the skip reason the worker host reads', () => {
    const err = new JobSkipError('parse_failed', 'Unexpected token');
    expect(err).toBeInstanceOf(Error);
    expect(err.skipReason).toBe('parse_failed');
    expect(err.message).toBe('Unexpected token');
  });
});
