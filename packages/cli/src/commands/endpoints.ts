/**
 * sa extract-endpoints / sa endpoints: JS からエンドポイントを抽出し、一覧を出す（design.md §7.3 extract_endpoints、計画書 M2）。
 * 並び順の規則・版間差分・OpenAPI の出力は sa diff / sa export-endpoints（PR-13）で足す。
 */
import { type EndpointListItem, type ExtractEndpointsResult, extractEndpoints, findTarget, findVersion, listEndpoints } from '@sa/core';
import type { Command } from 'commander';
import { type CliIo, emit, withContext } from '../io';

export function registerEndpointCommands(program: Command, io: CliIo): void {
  program
    .command('extract-endpoints')
    .description('版の JS から API エンドポイントを抽出する（ast_url）')
    .argument('<target>', '対象の ID か名前')
    .option('--version-id <id>', '抽出する版（既定: 取得日時が最も新しい版）')
    .action(async (targetRef: string, opts: { versionId?: string }, cmd: Command) => {
      const r = await withContext(cmd, io, async (ctx) => {
        const version = findVersion(ctx, findTarget(ctx, targetRef).id, opts.versionId);
        return { versionId: version.id, ...(await extractEndpoints(ctx, { versionId: version.id })) };
      });
      emit(cmd, io, r, () => extractSummary(r));
    });

  program
    .command('endpoints')
    .description('対象のエンドポイントを一覧する（パラメータの和集合・スコープ・観測した版の数）')
    .argument('<target>', '対象の ID か名前')
    .option('--all', '抽出し直して sighting が無くなったものも出す')
    .action(async (targetRef: string, opts: { all?: boolean }, cmd: Command) => {
      const list = await withContext(cmd, io, (ctx) =>
        listEndpoints(ctx, { targetId: findTarget(ctx, targetRef).id, includeUnseen: opts.all === true }),
      );
      emit(cmd, io, list, () => (list.length === 0 ? ['no endpoints (run sa extract-endpoints first)'] : list.map(endpointLine)));
    });
}

function extractSummary(r: ExtractEndpointsResult & { versionId: string }): string[] {
  return [
    `version ${r.versionId}: ${r.modules} modules, ${r.calls} calls (${r.dropped} without a usable URL), ${r.skipped} skipped`,
    `${r.endpoints} endpoints, ${r.sightings} sightings (run ${r.runId})`,
  ];
}

function endpointLine(e: EndpointListItem): string {
  const head = e.protocol === 'rest' ? (e.method || '?').padEnd(7) : `${e.protocol} ${e.method}`.trim().padEnd(7);
  const params = e.params.map((p) => `${p.in}:${p.name}`).join(' ');
  const scope = e.inScope === null ? 'scope ?' : e.inScope ? 'in scope' : 'OUT OF SCOPE';
  const seen = `${e.sightings} sighting${e.sightings === 1 ? '' : 's'}${e.observedInHar ? ', seen in HAR' : ''}`;
  return `${head} ${e.origin}${e.pathTemplate ?? e.pathNorm}${params ? `  [${params}]` : ''}  (${scope}; ${seen})`;
}
