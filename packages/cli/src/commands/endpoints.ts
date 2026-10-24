/**
 * sa extract-endpoints / sa endpoints: JS からエンドポイントを抽出し、一覧を出す（design.md §7.3 extract_endpoints、計画書 M2）。
 * 並び順の規則・版間差分・OpenAPI の出力は sa diff / sa export-endpoints（PR-13）で足す。
 */
import {
  CODE_EXTRACTORS,
  type CodeExtractor,
  type EndpointListItem,
  type ExtractEndpointsResult,
  SaError,
  extractEndpoints,
  findTarget,
  findVersion,
  listEndpoints,
} from '@sa/core';
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
    .description('対象のエンドポイントを一覧する（パラメータの和集合・スコープ・sighting の数）')
    .argument('<target>', '対象の ID か名前')
    .option('--all', '既定で省くもの（sighting が無くなったもの、同じパスにメソッドの分かるものがあるメソッド不明のもの）も出す')
    .action(async (targetRef: string, opts: { all?: boolean }, cmd: Command) => {
      const list = await withContext(cmd, io, (ctx) =>
        listEndpoints(ctx, { targetId: findTarget(ctx, targetRef).id, all: opts.all === true }),
      );
      emit(cmd, io, list, () => (list.length === 0 ? ['no endpoints (run sa extract-endpoints first)'] : list.map(endpointLine)));
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

/** 1 行: メソッド（GraphQL は protocol と operation の種類）・送信先・operation 名・persisted query の id・パラメータ・スコープ */
function endpointLine(e: EndpointListItem): string {
  const head = e.protocol === 'rest' ? (e.method || '?').padEnd(7) : `${e.protocol} ${e.method}`.trim().padEnd(7);
  const target = `${e.origin}${e.pathTemplate ?? e.pathNorm}` || '?';
  const operation = `${e.operation ? ` ${e.operation}` : ''}${e.persistedHash ? ` #${e.persistedHash.slice(0, 12)}` : ''}`;
  const params = e.params.map((p) => `${p.in}:${p.name}`).join(' ');
  const scope = e.inScope === null ? 'scope ?' : e.inScope ? 'in scope' : 'OUT OF SCOPE';
  const seen = `${e.sightings} sighting${e.sightings === 1 ? '' : 's'}${e.observedInHar ? ', seen in HAR' : ''}`;
  return `${head} ${target}${operation}${params ? `  [${params}]` : ''}  (${scope}; ${seen})`;
}
