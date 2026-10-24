/**
 * analysis_run（実行記録）のリポジトリ関数（design.md §6.1）。SQL はプレースホルダだけで書く。
 * 実行の始めに startAnalysisRun で行を作り、終わりに finishAnalysisRun でファイル数・スキップ・トークン数を書く。
 */
import { LAYERS, RUN_KINDS, type Layer, type RunKind, type SkippedDetail } from '@sa/types';
import { SaError } from '../../errors';
import { newId, nowIso } from '../../ids';
import { type HasDb, dbCall } from '../connection';

export interface NewAnalysisRun {
  /** 版に属さない実行（取り込み前の ingest など）は省く */
  versionId?: string;
  kind: RunKind;
  /** codeql / semgrep / jsluice / babel / extract_endpoints / hunter / refuter ... */
  tool: string;
  toolVersion?: string;
  configHash?: string;
  inputLayer?: Layer;
  /** LLM: 実際に応答したモデル ID（fallback 後の値）。実行時に受け取った値を入れ、ソースに定数で埋めない */
  modelId?: string;
  promptVersion?: string;
}

export interface FinishAnalysisRun {
  filesTotal?: number;
  filesAnalyzed?: number;
  filesSkipped?: number;
  skippedDetail?: SkippedDetail;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

export interface AnalysisRun {
  id: string;
  versionId: string | null;
  kind: RunKind;
  tool: string;
  toolVersion: string | null;
  configHash: string | null;
  inputLayer: Layer | null;
  modelId: string | null;
  promptVersion: string | null;
  filesTotal: number | null;
  filesAnalyzed: number | null;
  filesSkipped: number | null;
  skippedDetail: SkippedDetail | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface AnalysisRunDbRow {
  id: string;
  version_id: string | null;
  kind: string;
  tool: string;
  tool_version: string | null;
  config_hash: string | null;
  input_layer: string | null;
  model_id: string | null;
  prompt_version: string | null;
  files_total: number | null;
  files_analyzed: number | null;
  files_skipped: number | null;
  skipped_detail: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  started_at: string | null;
  finished_at: string | null;
}

/** 実行を始める。started_at は今。返り値は run id */
export function startAnalysisRun(ctx: HasDb, run: NewAnalysisRun): string {
  if (!(RUN_KINDS as readonly string[]).includes(run.kind)) {
    throw new SaError('INVALID_INPUT', `unknown analysis_run.kind: ${run.kind}`);
  }
  if (run.inputLayer !== undefined && !(LAYERS as readonly string[]).includes(run.inputLayer)) {
    throw new SaError('INVALID_INPUT', `unknown layer: ${run.inputLayer}`);
  }
  if (run.tool.trim() === '') throw new SaError('INVALID_INPUT', 'analysis_run.tool must not be empty');

  const id = newId();
  dbCall(() =>
    ctx.db
      .prepare(
        `INSERT INTO analysis_run
           (id, version_id, kind, tool, tool_version, config_hash, input_layer, model_id, prompt_version, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        run.versionId ?? null,
        run.kind,
        run.tool,
        run.toolVersion ?? null,
        run.configHash ?? null,
        run.inputLayer ?? null,
        run.modelId ?? null,
        run.promptVersion ?? null,
        nowIso(),
      ),
  );
  return id;
}

/** 実行を終える。finished_at は今。終わった実行をもう一度終えることはできない */
export function finishAnalysisRun(ctx: HasDb, runId: string, f: FinishAnalysisRun): void {
  for (const [k, v] of Object.entries(f)) {
    if (k === 'skippedDetail' || v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new SaError('INVALID_INPUT', `${k} must be a non-negative number: ${String(v)}`);
    }
  }
  const changes = dbCall(
    () =>
      ctx.db
        .prepare(
          `UPDATE analysis_run SET
             files_total = ?, files_analyzed = ?, files_skipped = ?, skipped_detail = ?,
             tokens_in = ?, tokens_out = ?, cost_usd = ?, finished_at = ?
           WHERE id = ? AND finished_at IS NULL`,
        )
        .run(
          f.filesTotal ?? null,
          f.filesAnalyzed ?? null,
          f.filesSkipped ?? null,
          f.skippedDetail === undefined ? null : JSON.stringify(f.skippedDetail),
          f.tokensIn ?? null,
          f.tokensOut ?? null,
          f.costUsd ?? null,
          nowIso(),
          runId,
        ).changes,
  );
  if (changes === 0) {
    if (getAnalysisRun(ctx, runId)) throw new SaError('INVALID_INPUT', `analysis_run already finished: ${runId}`, { runId });
    throw new SaError('NOT_FOUND', `analysis_run not found: ${runId}`, { runId });
  }
}

export function getAnalysisRun(ctx: HasDb, runId: string): AnalysisRun | undefined {
  const row = dbCall(() => ctx.db.prepare('SELECT * FROM analysis_run WHERE id = ?').get(runId) as AnalysisRunDbRow | undefined);
  if (!row) return undefined;
  return {
    id: row.id,
    versionId: row.version_id,
    kind: row.kind as RunKind,
    tool: row.tool,
    toolVersion: row.tool_version,
    configHash: row.config_hash,
    inputLayer: row.input_layer as Layer | null,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    filesTotal: row.files_total,
    filesAnalyzed: row.files_analyzed,
    filesSkipped: row.files_skipped,
    skippedDetail: row.skipped_detail === null ? null : (JSON.parse(row.skipped_detail) as SkippedDetail),
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
