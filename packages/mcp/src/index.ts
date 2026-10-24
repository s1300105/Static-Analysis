/**
 * 薄い MCP サーバ（docs/architecture.md §6.2）。design.md §7 で「MCP ○」のツールだけを公開し、
 * 人間の判定を書く操作（verdict / 事実 / target.scope / api_endpoint.triage など）は登録しない（design.md §4）。
 * 各ツールは「zod で入力検証 → sa-core の関数 → 結果を整形」だけ。sa-core は caller='mcp' で開いた SaContext で呼ぶ
 * （人間の判断を書く関数は caller で拒否する。二重防御のもう一層）。
 *
 * 手順2（計画書 M2）の公開範囲: extract_endpoints / diff_versions / find_missing_chunks。
 * 返すのは名前・URL・パラメータ名・件数だけで、コード本文は返さない（llm_code_policy の対象外）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CODE_EXTRACTORS,
  type EndpointSummary,
  type SaContext,
  diffVersions,
  extractEndpoints,
  findMissingChunks,
  findTarget,
  findVersion,
  isSaError,
  rankEndpoints,
} from '@sa/core';
import type { EndpointParam } from '@sa/types';
import { z } from 'zod';

export const MCP_SERVER_NAME = 'sa-mcp';
export const MCP_SERVER_VERSION = '0.0.0';

/** 公開するツール（design.md §7 の「MCP ○」のうち手順2の分） */
export const MCP_TOOLS = ['extract_endpoints', 'diff_versions', 'find_missing_chunks'] as const;

/** extract_endpoints の結果に付ける並び順の上位の件数 */
const MAX_ENDPOINTS = 200;

const target = z.string().min(1).describe('対象の ID か名前');
const versionId = z.string().min(1).optional().describe('版の ID（省けば取得日時が最も新しい版）');

export function createMcpServer(ctx: SaContext): McpServer {
  if (ctx.caller !== 'mcp') throw new Error(`sa-mcp needs a context opened with caller=mcp (got ${ctx.caller})`);
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  server.registerTool(
    'extract_endpoints',
    {
      title: 'Extract API endpoints',
      description:
        '版の JS から API エンドポイントを抽出し（ast_url・GraphQL と、設定があれば jsluice）、決定的な並び順の上位を返す。' +
        'rules は当たった並び順の規則、needsTriage は人間の確認待ち。',
      inputSchema: { target, versionId, extractors: z.array(z.enum(CODE_EXTRACTORS)).optional().describe('掛ける抽出器（省けば使えるものすべて）') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      respond(async () => {
        const t = findTarget(ctx, args.target);
        const v = findVersion(ctx, t.id, args.versionId);
        const result = await extractEndpoints(ctx, { versionId: v.id, ...(args.extractors && { extractors: args.extractors }) });
        const ranked = rankEndpoints(ctx, { targetId: t.id });
        return {
          ...result,
          endpointsTotal: ranked.length,
          endpoints: ranked.slice(0, MAX_ENDPOINTS).map((e) => ({ ...compact(e, e.params), rules: e.rules, needsTriage: e.needsTriage })),
        };
      }),
  );

  server.registerTool(
    'diff_versions',
    {
      title: 'Diff endpoints between versions',
      description:
        '2 つの版のエンドポイントの差分（新規・削除・既存のエンドポイントの新しいパラメータ）。' +
        'uncollected は片方の版で取得していないチャンクにだけある差（取得すれば消えるかもしれない）。',
      inputSchema: { target, versionId, baseVersionId: z.string().min(1).optional().describe('基準の版（省けば base_version_id か直前の版）') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      respond(async () => {
        const v = findVersion(ctx, findTarget(ctx, args.target).id, args.versionId);
        const d = await diffVersions(ctx, { versionId: v.id, ...(args.baseVersionId !== undefined && { baseVersionId: args.baseVersionId }) });
        const change = (c: { endpoint: EndpointSummary; params: EndpointParam[]; chunks: string[] }) => ({ ...compact(c.endpoint, c.params), chunks: c.chunks });
        return {
          versionId: d.versionId,
          baseVersionId: d.baseVersionId,
          added: d.added.map(change),
          removed: d.removed.map(change),
          newParams: d.newParams.map((n) => compact(n.endpoint, n.params)),
          uncollected: { added: d.uncollected.added.map(change), removed: d.uncollected.removed.map(change) },
        };
      }),
  );

  server.registerTool(
    'find_missing_chunks',
    {
      title: 'Find chunks that are referenced but not loaded',
      description:
        '版の JS が参照しているのに取り込んでいないチャンク・sourcemap・LICENSE を一覧する（通信しない。取りに行くのは人間）。' +
        'hostInScope が false のものは対象外のホスト。',
      inputSchema: { target, versionId },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) =>
      respond(async () => {
        const v = findVersion(ctx, findTarget(ctx, args.target).id, args.versionId);
        const r = await findMissingChunks(ctx, { versionId: v.id });
        return {
          versionId: v.id,
          missing: r.missing,
          skipped: r.skipped,
          chunks: r.chunks.map(({ referencedFrom: _at, ...c }) => c),
        };
      }),
  );

  return server;
}

/** エンドポイントの、LLM に渡す形（ID・プロトコル・メソッド・URL・operation・パラメータ名・スコープ・HAR での観測） */
function compact(e: EndpointSummary, params: EndpointParam[]) {
  return {
    id: e.id,
    protocol: e.protocol,
    method: e.method,
    origin: e.origin,
    path: e.pathTemplate ?? e.pathNorm,
    ...(e.operation !== '' && { operation: e.operation }),
    ...(e.persistedHash !== null && { persistedHash: e.persistedHash }),
    params,
    inScope: e.inScope,
    observedInHar: e.observedInHar,
  };
}

/** 結果を JSON のテキストで返す。sa-core の誤りはツールの誤り（isError）として返す */
async function respond(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await fn(), null, 2) }] };
  } catch (err) {
    if (isSaError(err)) return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
    throw err;
  }
}
