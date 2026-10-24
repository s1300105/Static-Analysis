/**
 * sa extract-endpoints / sa endpoints / sa diff / sa triage-endpoint（design.md §7.3、計画書 M2）:
 * JS からエンドポイントを抽出し、決定的な並び順で一覧し、版間の差分を出し、人間の triage を記録する。
 */
import {
  CODE_EXTRACTORS,
  type CodeExtractor,
  type DiffResult,
  type EndpointChange,
  type EndpointSummary,
  type ExtractEndpointsResult,
  type OrderRule,
  type RankedEndpoint,
  SaError,
  diffVersions,
  extractEndpoints,
  findTarget,
  findVersion,
  rankEndpoints,
  triageEndpoint,
} from '@sa/core';
import { ENDPOINT_TRIAGES, type EndpointParam, type EndpointTriage } from '@sa/types';
import type { Command } from 'commander';
import { type CliIo, collect, emit, withContext } from '../io';

export function registerEndpointCommands(program: Command, io: CliIo): void {
  program
    .command('extract-endpoints')
    .description('版の JS から API エンドポイントを抽出する（ast_url・GraphQL と、設定があれば jsluice）')
    .argument('<target>', '対象の ID か名前')
    .option('--version-id <id>', '抽出する版（既定: 取得日時が最も新しい版）')
    .option('--extractor <name>', `掛ける抽出器（繰り返し指定。${CODE_EXTRACTORS.join(' / ')}。既定: 使えるものすべて）`, collect)
    .action(async (targetRef: string, opts: { versionId?: string; extractor?: string[] }, cmd: Command) => {
      const extractors = opts.extractor?.map(checkExtractor);
      const r = await withContext(cmd, io, (ctx) => {
        const version = findVersion(ctx, findTarget(ctx, targetRef).id, opts.versionId);
        return extractEndpoints(ctx, { versionId: version.id, ...(extractors && { extractors }) });
      });
      emit(cmd, io, r, () => extractSummary(r));
    });

  program
    .command('endpoints')
    .description('対象のエンドポイントを決定的な並び順で一覧する（* は triage 待ち、! は triage の後にパラメータが増えたもの）')
    .argument('<target>', '対象の ID か名前')
    .option('--all', '既定で省くもの（sighting が無くなったもの、同じパスにメソッドの分かるものがあるメソッド不明のもの）も出す')
    .action(async (targetRef: string, opts: { all?: boolean }, cmd: Command) => {
      const list = await withContext(cmd, io, (ctx) => rankEndpoints(ctx, { targetId: findTarget(ctx, targetRef).id, all: opts.all === true }));
      emit(cmd, io, list, () => (list.length === 0 ? ['no endpoints (run sa extract-endpoints first)'] : list.map(rankedLine)));
    });

  program
    .command('diff')
    .description('2 つの版のエンドポイントの差分（新規・削除・新しいパラメータ、未取得のチャンクによる差は別枠）')
    .argument('<target>', '対象の ID か名前')
    .option('--version-id <id>', '新しい側の版（既定: 取得日時が最も新しい版）')
    .option('--base-version-id <id>', '基準の版（既定: 版の base_version_id か、その直前の版）')
    .action(async (targetRef: string, opts: { versionId?: string; baseVersionId?: string }, cmd: Command) => {
      const d = await withContext(cmd, io, (ctx) => {
        const version = findVersion(ctx, findTarget(ctx, targetRef).id, opts.versionId);
        return diffVersions(ctx, { versionId: version.id, ...(opts.baseVersionId !== undefined && { baseVersionId: opts.baseVersionId }) });
      });
      emit(cmd, io, d, () => diffLines(d));
    });

  program
    .command('triage-endpoint')
    .description(`エンドポイントに人間の判断を付ける（${ENDPOINT_TRIAGES.join(' / ')}）。後でパラメータが増えると再び triage 待ちになる`)
    .argument('<target>', '対象の ID か名前')
    .argument('<endpoint-id>', 'sa endpoints の行末の ID')
    .argument('<triage>', ENDPOINT_TRIAGES.join(' / '))
    .action(async (targetRef: string, endpointId: string, triage: string, _opts: unknown, cmd: Command) => {
      const r = await withContext(cmd, io, (ctx) =>
        triageEndpoint(ctx, { targetId: findTarget(ctx, targetRef).id, endpointId, triage: triage as EndpointTriage }),
      );
      emit(cmd, io, r, () => [`${r.endpointId}: ${r.triage}`]);
    });
}

function checkExtractor(name: string): CodeExtractor {
  if (!(CODE_EXTRACTORS as readonly string[]).includes(name)) {
    throw new SaError('INVALID_INPUT', `unknown extractor: ${name} (use ${CODE_EXTRACTORS.join(' or ')})`);
  }
  return name as CodeExtractor;
}

function extractSummary(r: ExtractEndpointsResult): string[] {
  const lines = [`version ${r.versionId}: ${r.endpoints} endpoints, ${r.sightings} sightings`];
  for (const [name, s] of Object.entries(r.extractors)) {
    lines.push(
      `  ${name}: ${s.inputs} inputs, ${s.found} found, ${s.dropped} dropped, ${s.sightings} sightings, ${s.skipped} skipped (run ${s.runId})`,
    );
  }
  for (const name of r.unavailable) {
    lines.push(`  ${name}: not configured (set tools.${name} in config.json or SA_TOOLS)`);
  }
  return lines;
}

const RULE_TAGS: Record<OrderRule, string> = {
  new_in_latest: 'new',
  not_in_har: 'no-har',
  state_changing: 'write',
  admin_guard: 'admin',
  id_param: 'id',
};

/** 並び順の 1 行: triage の印・エンドポイント・当たった規則・ID */
function rankedLine(e: RankedEndpoint): string {
  const mark = e.paramsChangedSinceTriage ? '!' : e.needsTriage ? '*' : ' ';
  const rules = e.rules.map((r) => RULE_TAGS[r]).join(',');
  return `${mark} ${endpointLine(e, e.params)}${rules ? `  {${rules}}` : ''}  ${e.id}`;
}

/** 1 行: メソッド（GraphQL は protocol と operation の種類）・送信先・operation 名・persisted query の id・パラメータ・スコープ */
function endpointLine(e: EndpointSummary, params: EndpointParam[]): string {
  const head = e.protocol === 'rest' ? (e.method || '?').padEnd(7) : `${e.protocol} ${e.method}`.trim().padEnd(7);
  const target = `${e.origin}${e.pathTemplate ?? e.pathNorm}` || '?';
  const operation = `${e.operation ? ` ${e.operation}` : ''}${e.persistedHash ? ` #${e.persistedHash.slice(0, 12)}` : ''}`;
  const p = params.map((x) => `${x.in}:${x.name}`).join(' ');
  const scope = e.inScope === null ? 'scope ?' : e.inScope ? 'in scope' : 'OUT OF SCOPE';
  const seen = `${e.sightings} sighting${e.sightings === 1 ? '' : 's'}${e.observedInHar ? ', seen in HAR' : ''}`;
  return `${head} ${target}${operation}${p ? `  [${p}]` : ''}  (${scope}; ${seen})`;
}

function diffLines(d: DiffResult): string[] {
  const change = (c: EndpointChange) => `  ${endpointLine(c.endpoint, c.params)}  chunks ${c.chunks.join(',')}`;
  const section = (title: string, xs: EndpointChange[]) => (xs.length === 0 ? [] : [`${title} (${xs.length}):`, ...xs.map(change)]);
  return [
    `version ${d.versionId} against ${d.baseVersionId}`,
    ...section('added', d.added),
    ...section('removed', d.removed),
    ...(d.newParams.length === 0
      ? []
      : [`new parameters (${d.newParams.length}):`, ...d.newParams.map((n) => `  ${endpointLine(n.endpoint, n.params)}`)]),
    ...section('added in chunks the base version did not fetch', d.uncollected.added),
    ...section('removed in chunks this version did not fetch', d.uncollected.removed),
  ];
}
