/**
 * ジョブ実行器（design.md §4「重い処理は隔離して動かす」、docs/architecture.md §3.4）。
 * 攻撃者入力をパース・実行する処理はプロセス内で直接呼ばず、すべてここを通す。
 * - worker: worker_threads。resourceLimits（ヒープ・スタック）と wall-clock タイムアウト。Babel parse/generate など
 * - child: 子プロセス。引数は配列で渡し（シェルを通さない。原則8）、env は明示したものだけ、タイムアウトでプロセスグループごと SIGKILL
 * 失敗・タイムアウトは throw せず JobResult で返す。呼び出し側が SkipLog に積み analysis_run.skipped_detail に記録する。
 * throw するのは呼び出し側の誤り（不正な引数など）だけ。
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { SKIP_REASONS, type SkipReason } from '@sa/types';
import { SaError } from '../errors';

export type JobSuccess<O> = { ok: true; value: O; durationMs: number };
export type JobFailure = { ok: false; reason: SkipReason; detail: string; durationMs: number };
export type JobResult<O> = JobSuccess<O> | JobFailure;

/**
 * worker で動かす処理。url は「入力を受けて結果を返す関数」を default export する ES モジュール（file: URL）。
 * 結果は structured clone できる値にする。スキップ理由を指定して失敗させるときは JobSkipError を投げる。
 * I / O は型だけの印（実行時には使わない）。
 */
export interface WorkerSpec<I, O> {
  readonly name: string;
  readonly url: URL;
  /** 型の印。値は持たない */
  readonly __types?: (input: I) => O;
}

export function defineWorker<I, O>(name: string, url: URL): WorkerSpec<I, O> {
  return { name, url };
}

export interface WorkerLimits {
  /** V8 の old generation の上限（MB）。超えると worker は止められ oom になる */
  maxOldGenMb: number;
  /** スレッドのスタック（MB）。深い AST の再帰のため既定より広げる（design.md §4 例 64） */
  stackSizeMb: number;
  timeoutMs: number;
}

export const DEFAULT_WORKER_LIMITS: Readonly<WorkerLimits> = { maxOldGenMb: 2048, stackSizeMb: 64, timeoutMs: 60_000 };

export interface ChildSpec {
  /** 実行ファイルの絶対パス（PATH 探索に頼らない。版を固定したツールを SaConfig から渡す） */
  bin: string;
  /** 引数の配列。シェルは通さない */
  args: string[];
  /** 作業ディレクトリ（絶対パス。policy/paths で作業ディレクトリ配下と確かめたもの） */
  cwd: string;
  /** 子プロセスの環境変数。親の環境は引き継がない（API キー等を外部ツールに渡さない）。PATH 等も要るなら明示する */
  env: Record<string, string>;
  timeoutMs: number;
  /** 正常とみなす終了コード。既定 [0] */
  okExitCodes?: number[];
  /** stdout と stderr それぞれの上限（バイト）。超えたら止めて tool_error。既定 64 MiB */
  maxOutputBytes?: number;
}

export interface ChildOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface JobRunner {
  runWorker<I, O>(worker: WorkerSpec<I, O>, input: I, limits: WorkerLimits): Promise<JobResult<O>>;
  runChild(spec: ChildSpec): Promise<JobResult<ChildOutput>>;
}

export interface JobRunnerOptions {
  /** 同時に動かす worker の数。既定は CPU 数 − 1（最低 1） */
  maxWorkers?: number;
  /** 同時に動かす子プロセスの数。既定 2（CodeQL はメモリを大きく使う） */
  maxChildren?: number;
}

/** worker の中で投げると、その理由のスキップとして返る（例: Babel の構文エラー → parse_failed） */
export class JobSkipError extends Error {
  readonly skipReason: SkipReason;

  constructor(reason: SkipReason, message: string) {
    super(message);
    this.name = 'JobSkipError';
    this.skipReason = reason;
  }
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;

/**
 * worker の中で動く固定の起動コード。ジョブのモジュールを import して default export を呼び、結果か失敗を 1 通だけ送る。
 * 文字列（eval）にしておくと、src（テスト）と dist（ビルド後）で起動ファイルの置き場所を気にしなくてよい。
 */
const WORKER_HOST = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  let message;
  try {
    const mod = await import(workerData.moduleUrl);
    if (typeof mod.default !== 'function') throw new Error('job module has no default export function');
    message = { ok: true, value: await mod.default(workerData.input) };
  } catch (err) {
    const reason = err && typeof err.skipReason === 'string' ? err.skipReason : undefined;
    message = { ok: false, reason, detail: err && err.message ? String(err.message) : String(err) };
  }
  try {
    parentPort.postMessage(message);
  } catch (err) {
    parentPort.postMessage({ ok: false, detail: 'job result is not cloneable: ' + (err && err.message) });
  }
})();
`;

type HostMessage = { ok: true; value: unknown } | { ok: false; reason?: string; detail: string };

export function createJobRunner(opts: JobRunnerOptions = {}): JobRunner {
  const workerSlots = createLimiter(positiveInt('maxWorkers', opts.maxWorkers ?? Math.max(1, availableParallelism() - 1)));
  const childSlots = createLimiter(positiveInt('maxChildren', opts.maxChildren ?? 2));
  return {
    // 引数の誤りも reject で返す（呼び出し側の await で一様に扱えるように）
    runWorker: async (worker, input, limits) => {
      validateWorker(worker, limits);
      return workerSlots(() => runWorkerNow(worker, input, limits));
    },
    runChild: async (spec) => {
      validateChild(spec);
      return childSlots(() => runChildNow(spec));
    },
  };
}

function runWorkerNow<I, O>(spec: WorkerSpec<I, O>, input: I, limits: WorkerLimits): Promise<JobResult<O>> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const fail = (reason: SkipReason, detail: string): JobFailure => ({
    ok: false,
    reason,
    detail: `${spec.name}: ${detail}`,
    durationMs: elapsed(),
  });

  let worker: Worker;
  try {
    worker = new Worker(WORKER_HOST, {
      eval: true,
      workerData: { moduleUrl: spec.url.href, input },
      resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenMb, stackSizeMb: limits.stackSizeMb },
      // 攻撃者入力を扱うコードに親の環境変数（API キー等）を見せない。同一プロセスなので隔離の境界ではなく衛生のため
      env: {},
    });
  } catch (err) {
    // 入力が structured clone できない等、呼び出し側の誤り
    throw new SaError('INVALID_INPUT', `cannot start worker ${spec.name}: ${errorMessage(err)}`, { worker: spec.name }, { cause: err });
  }

  return new Promise((resolve) => {
    let settled = false;
    // 結果を返すのは worker を止め終えてから（返った時点で動いている worker を残さない）
    const finish = (r: JobResult<O>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().then(
        () => resolve(r),
        () => resolve(r),
      );
    };
    const timer = setTimeout(() => finish(fail('timeout', `exceeded ${limits.timeoutMs}ms`)), limits.timeoutMs);

    worker.on('message', (m: HostMessage) => {
      if (m.ok) finish({ ok: true, value: m.value as O, durationMs: elapsed() });
      else finish(fail(toSkipReason(m.reason), m.detail));
    });
    worker.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') finish(fail('oom', err.message));
      else finish(fail('tool_error', err.message));
    });
    worker.on('exit', (code) => finish(fail('tool_error', `worker exited (code ${code}) without a result`)));
  });
}

function runChildNow(spec: ChildSpec): Promise<JobResult<ChildOutput>> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const name = spec.bin;
  const okExitCodes = spec.okExitCodes ?? [0];
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: JobResult<ChildOutput>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const fail = (reason: SkipReason, detail: string) =>
      settle({ ok: false, reason, detail: `${name}: ${detail}`, durationMs: elapsed() });

    // detached: 子を新しいプロセスグループの先頭にする。タイムアウト時に孫（CodeQL の java など）までまとめて止めるため
    const child = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // 既にいない
      }
    };

    const timer = setTimeout(() => {
      killGroup();
      fail('timeout', `exceeded ${spec.timeoutMs}ms`);
    }, spec.timeoutMs);

    const collect = (stream: NodeJS.ReadableStream, chunks: Buffer[], label: string) => {
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxOutputBytes) {
          killGroup();
          fail('tool_error', `${label} exceeded ${maxOutputBytes} bytes`);
          return;
        }
        chunks.push(chunk);
      });
    };
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    collect(child.stdout, out, 'stdout');
    collect(child.stderr, err, 'stderr');

    child.on('error', (e) => fail('tool_error', `failed to run: ${e.message}`));
    // 終了したら、グループに残った孫も止める（残っていると stdout が閉じず close が来ない）
    child.on('exit', () => killGroup());
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === null) {
        fail('tool_error', `killed by ${signal ?? 'unknown signal'}${stderrTail(stderr)}`);
      } else if (!okExitCodes.includes(code)) {
        fail('tool_error', `exit code ${code}${stderrTail(stderr)}`);
      } else {
        settle({ ok: true, value: { exitCode: code, stdout, stderr }, durationMs: elapsed() });
      }
    });
  });
}

/**
 * 同時実行数の上限。空きが無ければ待たせ、終わった枠は待っている次のジョブにそのまま渡す
 * （いったん空けると、待ち手が動く前に割り込んだ呼び出しで上限を超えることがあるため）。
 * タイムアウトは枠を得てから数える。
 */
function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise((r) => waiting.push(r));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function toSkipReason(reason: string | undefined): SkipReason {
  return reason !== undefined && (SKIP_REASONS as readonly string[]).includes(reason) ? (reason as SkipReason) : 'tool_error';
}

function validateWorker(worker: Pick<WorkerSpec<unknown, unknown>, 'name' | 'url'>, limits: WorkerLimits): void {
  if (!(worker.url instanceof URL) || worker.url.protocol !== 'file:') {
    throw new SaError('INVALID_INPUT', `worker ${worker.name} must be a file: URL`, { worker: worker.name });
  }
  positiveInt('maxOldGenMb', limits.maxOldGenMb);
  positiveInt('stackSizeMb', limits.stackSizeMb);
  positiveInt('timeoutMs', limits.timeoutMs);
}

function validateChild(spec: ChildSpec): void {
  if (!isAbsolute(spec.bin)) throw new SaError('INVALID_INPUT', `bin must be an absolute path: ${spec.bin}`);
  if (!isAbsolute(spec.cwd)) throw new SaError('INVALID_INPUT', `cwd must be an absolute path: ${spec.cwd}`);
  if (!Array.isArray(spec.args) || !spec.args.every((a) => typeof a === 'string')) {
    throw new SaError('INVALID_INPUT', 'args must be an array of strings');
  }
  if (!Object.values(spec.env).every((v) => typeof v === 'string')) {
    throw new SaError('INVALID_INPUT', 'env values must be strings');
  }
  positiveInt('timeoutMs', spec.timeoutMs);
  if (spec.maxOutputBytes !== undefined) positiveInt('maxOutputBytes', spec.maxOutputBytes);
}

function positiveInt(name: string, v: number): number {
  if (!Number.isInteger(v) || v <= 0) throw new SaError('INVALID_INPUT', `${name} must be a positive integer: ${v}`);
  return v;
}

function stderrTail(stderr: string): string {
  const t = stderr.trim();
  if (t === '') return '';
  return `; stderr: ${t.length > STDERR_TAIL_CHARS ? `…${t.slice(-STDERR_TAIL_CHARS)}` : t}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
