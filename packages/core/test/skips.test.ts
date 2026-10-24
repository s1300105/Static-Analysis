import { describe, expect, it } from 'vitest';
import { type Database, migrate } from '@sa/core';
import { finishAnalysisRun, getAnalysisRun, startAnalysisRun } from '../src/db/repo/analysisRun';
import { DEFAULT_WORKER_LIMITS, type JobResult, createJobRunner, defineWorker } from '../src/jobs/runner';
import { MAX_SKIP_ITEMS_PER_REASON, SkipLog } from '../src/jobs/skips';
import { catchError, useDatabases } from './helpers';

const openTracked = useDatabases();

function fresh(): Database {
  const db = openTracked(':memory:');
  migrate(db);
  return db;
}

const failure = (reason: 'timeout' | 'parse_failed', detail = 'x'): JobResult<never> => ({ ok: false, reason, detail, durationMs: 1 });

describe('SkipLog', () => {
  it('records failures by reason and ignores successes', () => {
    const log = new SkipLog();
    expect(log.record({ ok: true, value: 1, durationMs: 1 }, { fileId: 'f0' })).toBe(true);
    expect(log.record(failure('timeout', 'babel: exceeded 60000ms'), { fileId: 'f1' })).toBe(false);
    log.record(failure('parse_failed'), { fileId: 'f2' });
    log.record(failure('parse_failed'), { fileId: 'f2' });
    log.add('unresolved_require', { ref: 'n(4821)' });

    expect(log.count).toBe(4);
    // ファイル単位に数えるのは fileId の異なり数だけ（ref は数えない）
    expect(log.filesSkipped).toBe(2);
    expect(log.toJSON()).toEqual({
      parse_failed: { count: 2, items: [{ fileId: 'f2', detail: 'x' }, { fileId: 'f2', detail: 'x' }] },
      timeout: { count: 1, items: [{ fileId: 'f1', detail: 'babel: exceeded 60000ms' }] },
      unresolved_require: { count: 1, items: [{ ref: 'n(4821)' }] },
    });
  });

  it('lists reasons in vocabulary order regardless of insertion order', () => {
    const log = new SkipLog();
    log.add('unmapped', { ref: 'a' });
    log.add('parse_failed', { fileId: 'f' });
    expect(Object.keys(log.toJSON())).toEqual(['parse_failed', 'unmapped']);
  });

  it('caps the stored items per reason but keeps the full count', () => {
    const log = new SkipLog();
    for (let i = 0; i < MAX_SKIP_ITEMS_PER_REASON + 5; i++) log.add('unmapped', { ref: `pos${i}` });
    const bucket = log.toJSON().unmapped;
    expect(bucket?.count).toBe(MAX_SKIP_ITEMS_PER_REASON + 5);
    expect(bucket?.items).toHaveLength(MAX_SKIP_ITEMS_PER_REASON);
  });

  it('returns copies (later changes to the log or the output do not leak)', () => {
    const log = new SkipLog();
    const entry = { fileId: 'f1' };
    log.add('timeout', entry);
    entry.fileId = 'changed';
    const json = log.toJSON();
    json.timeout!.items.push({ fileId: 'injected' });
    expect(log.toJSON()).toEqual({ timeout: { count: 1, items: [{ fileId: 'f1' }] } });
  });
});

describe('analysis_run repository', () => {
  it('starts and finishes a run', () => {
    const db = fresh();
    const id = startAnalysisRun({ db }, { kind: 'engine', tool: 'babel', toolVersion: '7.x', inputLayer: 'raw' });
    expect(getAnalysisRun({ db }, id)).toMatchObject({
      id,
      versionId: null,
      kind: 'engine',
      tool: 'babel',
      toolVersion: '7.x',
      inputLayer: 'raw',
      finishedAt: null,
      skippedDetail: null,
    });

    finishAnalysisRun({ db }, id, {
      filesTotal: 3,
      filesAnalyzed: 2,
      filesSkipped: 1,
      skippedDetail: { timeout: { count: 1, items: [{ fileId: 'f1' }] } },
    });
    const run = getAnalysisRun({ db }, id);
    expect(run).toMatchObject({
      filesTotal: 3,
      filesAnalyzed: 2,
      filesSkipped: 1,
      skippedDetail: { timeout: { count: 1, items: [{ fileId: 'f1' }] } },
    });
    expect(run?.startedAt).toMatch(/Z$/);
    expect(run?.finishedAt).toMatch(/Z$/);
  });

  it('records LLM usage', () => {
    const db = fresh();
    const id = startAnalysisRun({ db }, { kind: 'llm', tool: 'hunter', modelId: 'model-from-runtime', promptVersion: 'p1' });
    finishAnalysisRun({ db }, id, { tokensIn: 1200, tokensOut: 300, costUsd: 0.0123 });
    expect(getAnalysisRun({ db }, id)).toMatchObject({ modelId: 'model-from-runtime', tokensIn: 1200, tokensOut: 300, costUsd: 0.0123 });
  });

  it('refuses to finish a run twice or a run that does not exist', () => {
    const db = fresh();
    const id = startAnalysisRun({ db }, { kind: 'ingest', tool: 'load_artifact' });
    finishAnalysisRun({ db }, id, {});
    expect((catchError(() => finishAnalysisRun({ db }, id, {})) as { code: string }).code).toBe('INVALID_INPUT');
    expect((catchError(() => finishAnalysisRun({ db }, 'missing', {})) as { code: string }).code).toBe('NOT_FOUND');
  });

  it('validates its input', () => {
    const db = fresh();
    const bad = [
      () => startAnalysisRun({ db }, { kind: 'bogus' as 'engine', tool: 'x' }),
      () => startAnalysisRun({ db }, { kind: 'engine', tool: ' ' }),
      () => startAnalysisRun({ db }, { kind: 'engine', tool: 'x', inputLayer: 'nope' as 'raw' }),
      () => finishAnalysisRun({ db }, startAnalysisRun({ db }, { kind: 'engine', tool: 'x' }), { filesTotal: -1 }),
    ];
    for (const fn of bad) expect((catchError(fn) as { code: string }).code).toBe('INVALID_INPUT');
    // 存在しない版への実行記録は外部キーで弾かれる
    expect((catchError(() => startAnalysisRun({ db }, { kind: 'engine', tool: 'x', versionId: 'missing' })) as { code: string }).code).toBe(
      'DB_ERROR',
    );
  });
});

describe('recording job failures into analysis_run', () => {
  it('stores per-file worker failures as skipped_detail by reason', async () => {
    const db = fresh();
    const runner = createJobRunner({ maxWorkers: 2 });
    const fixture = (name: string) => new URL(`./fixtures/workers/${name}.mjs`, import.meta.url);
    const jobs = [
      { fileId: 'f-ok', spec: defineWorker('double', fixture('double')), input: { n: 1 } },
      { fileId: 'f-bad', spec: defineWorker('skip', fixture('skip')), input: { reason: 'parse_failed', message: 'Unexpected token' } },
      { fileId: 'f-slow', spec: defineWorker('spin', fixture('spin')), input: {} },
    ];

    const runId = startAnalysisRun({ db }, { kind: 'engine', tool: 'babel', inputLayer: 'raw' });
    const skips = new SkipLog();
    const results = await Promise.all(
      jobs.map((j) => runner.runWorker(j.spec, j.input, { ...DEFAULT_WORKER_LIMITS, timeoutMs: 500 })),
    );
    results.forEach((r, i) => skips.record(r, { fileId: jobs[i]!.fileId }));
    const { filesSkipped, skippedDetail } = skips.summary();
    finishAnalysisRun({ db }, runId, { filesTotal: jobs.length, filesAnalyzed: jobs.length - filesSkipped, filesSkipped, skippedDetail });

    expect(getAnalysisRun({ db }, runId)).toMatchObject({
      filesTotal: 3,
      filesAnalyzed: 1,
      filesSkipped: 2,
      skippedDetail: {
        parse_failed: { count: 1, items: [{ fileId: 'f-bad', detail: 'skip: Unexpected token' }] },
        timeout: { count: 1, items: [{ fileId: 'f-slow', detail: 'spin: exceeded 500ms' }] },
      },
    });
  });
});
