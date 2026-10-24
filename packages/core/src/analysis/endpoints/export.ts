/**
 * export_endpoints（design.md §7.3、計画書 M2）: エンドポイントを人間の道具（Burp・Postman・GraphQL クライアント）に渡す形で出す。
 * - REST は OpenAPI 3.0.3。パスは path_template の :name を {name} にし（同じ名前が重なれば番号を付ける）、origin は servers に置く
 *   （同じパス・メソッドの endpoint が複数の origin にあれば 1 つの operation にまとめて servers を並べる）。
 *   パラメータは path（必須）・query・header、本文のパラメータは application/json の object の properties にする（型は分からないので付けない）。
 *   メソッドが分からないものは path item の x-sa-method-unknown に、WebSocket は x-sa-websockets に置く
 * - GraphQL は operation の文書（.graphql）。本文は DB に持たないので sighting の位置から読み直す（graphqlDocs.ts）。
 *   persisted query で本文が無いもの、HAR でしか見ていないものはコメントで出す
 * - スコープ外（in_scope = false）は既定で出さない。判定できないもの（null）は出す
 * 出力は決定的にする（時刻を入れず、並びを固定する）。版間で出力をそのまま diff できるように。
 */
import type { DefinitionNode, FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';
import type { EndpointParam } from '@sa/types';
import type { SaContext } from '../../context';
import { listArtifactVersions } from '../../db/repo/artifactVersion';
import { type SightingLocation, listSightingLocations } from '../../db/repo/endpoint';
import { getTarget } from '../../db/repo/target';
import { SaError } from '../../errors';
import { endpointsWorker } from '../../jobs/workers';
import { moduleRanges } from './babel';
import { definitionsAt, persistedRelayAt, printOperation } from './graphqlDocs';
import { type EndpointListItem, listEndpoints } from './list';

export interface ExportEndpointsOptions {
  targetId: string;
  /** スコープ外（in_scope = false）も出す（既定 false） */
  includeOutOfScope?: boolean;
}

export interface ExportEndpointsResult {
  /** OpenAPI 3.0.3 の文書（JSON にそのまま書ける） */
  openapi: Record<string, unknown>;
  /** GraphQL の operation の文書（.graphql）。operation が無ければ '' */
  graphql: string;
  counts: { rest: number; graphql: number; websocket: number; methodUnknown: number; outOfScope: number };
}

const HTTP_METHODS = new Set(['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE']);
const GRAPHQL_EXTRACTORS = ['graphql_text', 'graphql_ast', 'relay'] as const;

interface Operation {
  endpoints: EndpointListItem[];
  params: EndpointParam[];
}

export async function exportEndpoints(ctx: SaContext, opts: ExportEndpointsOptions): Promise<ExportEndpointsResult> {
  const target = getTarget(ctx, opts.targetId);
  if (!target) throw new SaError('NOT_FOUND', `target not found: ${opts.targetId}`);
  const all = listEndpoints(ctx, { targetId: target.id });
  const endpoints = all.filter((e) => opts.includeOutOfScope === true || e.inScope !== false);
  const counts = { rest: 0, graphql: 0, websocket: 0, methodUnknown: 0, outOfScope: all.length - endpoints.length };

  // REST: パス → メソッド → operation
  const paths = new Map<string, { names: string[]; methods: Map<string, Operation>; unknown: Operation[] }>();
  const websockets: { url: string; endpointIds: string[] }[] = [];
  for (const e of endpoints) {
    if (e.protocol === 'websocket') {
      websockets.push({ url: `${e.origin}${e.pathTemplate ?? e.pathNorm}`, endpointIds: [e.id] });
      counts.websocket++;
      continue;
    }
    if (e.protocol !== 'rest') continue;
    const { path, names } = openApiPath(e.pathTemplate ?? e.pathNorm);
    const item = paths.get(path) ?? { names, methods: new Map<string, Operation>(), unknown: [] as Operation[] };
    paths.set(path, item);
    if (!HTTP_METHODS.has(e.method)) {
      item.unknown.push({ endpoints: [e], params: e.params });
      counts.methodUnknown++;
      continue;
    }
    const op = item.methods.get(e.method) ?? { endpoints: [], params: [] };
    item.methods.set(e.method, op);
    op.endpoints.push(e);
    for (const p of e.params) if (!op.params.some((q) => q.name === p.name && q.in === p.in)) op.params.push(p);
    counts.rest++;
  }

  const origins = [...new Set(endpoints.filter((e) => e.protocol === 'rest' && e.origin !== '').map((e) => e.origin))].sort();
  const versions = listArtifactVersions(ctx, target.id);
  const openapi: Record<string, unknown> = {
    openapi: '3.0.3',
    info: {
      title: `${target.name} (endpoints extracted by sa)`,
      version: versions.at(-1)?.collectedAt ?? 'none',
      description: 'Statically extracted from JavaScript bundles and HAR observations. Parameter types and responses are not known.',
    },
    ...(origins.length > 0 && { servers: origins.map((url) => ({ url })) }),
    paths: Object.fromEntries(
      [...paths.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, item]) => [path, pathItem(path, item.names, item.methods, item.unknown)]),
    ),
    ...(websockets.length > 0 && { 'x-sa-websockets': websockets.sort((a, b) => a.url.localeCompare(b.url)) }),
  };

  const ops = endpoints.filter((e) => e.protocol === 'graphql' && e.operation !== '');
  counts.graphql = ops.length;
  return { openapi, graphql: await graphqlDocument(ctx, target.id, ops), counts };
}

/** path_template（/users/:id/docs/:param）を OpenAPI のパス（/users/{id}/docs/{param}）にする。同じ名前が重なれば番号を付ける */
function openApiPath(template: string): { path: string; names: string[] } {
  const names: string[] = [];
  const segments = template.split('/').map((seg) => {
    if (!seg.startsWith(':')) return seg;
    const base = seg.slice(1) || 'param';
    let name = base;
    for (let i = 2; names.includes(name); i++) name = `${base}${i}`;
    names.push(name);
    return `{${name}}`;
  });
  return { path: segments.join('/') || '/', names };
}

function pathItem(path: string, names: string[], methods: Map<string, Operation>, unknown: Operation[]): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const [method, op] of [...methods.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    item[method.toLowerCase()] = operation(path, method, names, op);
  }
  if (unknown.length > 0) {
    item['x-sa-method-unknown'] = unknown.map((op) => ({ endpointIds: op.endpoints.map((e) => e.id), parameters: op.params }));
  }
  return item;
}

function operation(path: string, method: string, names: string[], op: Operation): Record<string, unknown> {
  const parameters = [
    ...names.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
    ...op.params
      .filter((p) => p.in === 'query' || p.in === 'header')
      .sort((a, b) => a.in.localeCompare(b.in) || a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, in: p.in, schema: { type: 'string' } })),
  ];
  const body = op.params.filter((p) => p.in === 'body').map((p) => p.name).sort();
  const servers = [...new Set(op.endpoints.map((e) => e.origin).filter((o) => o !== ''))].sort();
  const ids = op.endpoints.map((e) => e.id).sort();
  return {
    operationId: `${method.toLowerCase()}${path.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/, '')}`,
    ...(servers.length > 0 && { servers: servers.map((url) => ({ url })) }),
    ...(parameters.length > 0 && { parameters }),
    ...(body.length > 0 && {
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: Object.fromEntries(body.map((n) => [n, {}])) } } } },
    }),
    responses: { default: { description: 'Not observed (static extraction)' } },
    'x-sa-endpoint-ids': ids,
    'x-sa-observed-in-har': op.endpoints.some((e) => e.observedInHar),
    'x-sa-first-seen': op.endpoints.map((e) => e.firstSeen).filter((t): t is string => t !== null).sort()[0] ?? null,
    'x-sa-last-seen': op.endpoints.map((e) => e.lastSeen).filter((t): t is string => t !== null).sort().at(-1) ?? null,
    'x-sa-triage': [...new Set(op.endpoints.map((e) => e.triage))].sort(),
  };
}

/**
 * GraphQL の operation の文書。fragment は、GraphQL の sighting のある raw ファイル（新しい版を優先）のどこかに定義があれば足す。
 * fragment だけの文書には sighting が無いので、その raw ファイルを worker で読み直して定義の位置を集める
 */
async function graphqlDocument(ctx: SaContext, targetId: string, ops: EndpointListItem[]): Promise<string> {
  if (ops.length === 0) return '';
  const locations = listSightingLocations(ctx, { targetId, extractedBy: [...GRAPHQL_EXTRACTORS] });
  const blobs = new Map<string, Uint8Array>();
  const parsed = new Map<string, DefinitionNode[]>();
  const definitions = (l: SightingLocation): DefinitionNode[] => {
    const key = `${l.rawFileId}:${l.startByte}:${l.endByte}:${l.extractedBy}`;
    let defs = parsed.get(key);
    if (!defs) {
      defs = definitionsAt({ extractedBy: l.extractedBy as (typeof GRAPHQL_EXTRACTORS)[number], snippet: snippet(l) });
      parsed.set(key, defs);
    }
    return defs;
  };
  const snippet = (l: SightingLocation): Uint8Array => {
    let bytes = blobs.get(l.contentHash);
    if (!bytes) {
      bytes = ctx.store.get(l.contentHash);
      blobs.set(l.contentHash, bytes);
    }
    return bytes.subarray(l.startByte, l.endByte);
  };

  const fragments = new Map<string, FragmentDefinitionNode>();
  const raws = [...new Map(locations.map((l) => [l.rawFileId, l])).values()];
  const ranges = new Map<string, Map<string, { start: number; end: number }[]>>();
  const results = await Promise.all(
    raws.map((l) => {
      let byRaw = ranges.get(l.versionId);
      if (!byRaw) ranges.set(l.versionId, (byRaw = moduleRanges(ctx, l.versionId)));
      const input = { bytes: ctx.store.get(l.contentHash), modules: byRaw.get(l.rawFileId) ?? [], rest: false, graphql: true };
      return ctx.jobs.runWorker(endpointsWorker, input, ctx.config.workerLimits);
    }),
  );
  raws.forEach((l, i) => {
    const r = results[i]!;
    if (!r.ok) return;
    for (const f of r.value.graphqlFragments) {
      if (fragments.has(f.name)) continue;
      const at = { ...l, extractedBy: f.extractor, startByte: f.startByte, endByte: f.endByte };
      const def = definitions(at).find((d): d is FragmentDefinitionNode => d.kind === 'FragmentDefinition' && d.name.value === f.name);
      if (def) fragments.set(f.name, def);
    }
  });

  const blocks: string[] = [];
  const sorted = [...ops].sort((a, b) => a.operation.localeCompare(b.operation) || a.method.localeCompare(b.method) || a.origin.localeCompare(b.origin));
  for (const e of sorted) {
    const where = `${e.origin}${e.pathNorm}` || 'endpoint unknown';
    const head = `# ${e.method || 'OPERATION'} ${e.operation} (${where}${e.persistedHash ? `, persisted ${e.persistedHash}` : ''})`;
    const mine = locations.filter((l) => l.endpointId === e.id);
    let block: string | undefined;
    for (const l of mine) {
      const op = definitions(l).find(
        (d): d is OperationDefinitionNode => d.kind === 'OperationDefinition' && d.name?.value === e.operation,
      );
      if (op) {
        const { text, missingFragments } = printOperation(op, fragments);
        block = [head, ...(missingFragments.length > 0 ? [`# fragments not found in the bundle: ${missingFragments.join(', ')}`] : []), text].join('\n');
        break;
      }
      const persisted = persistedRelayAt({ extractedBy: l.extractedBy as (typeof GRAPHQL_EXTRACTORS)[number], snippet: snippet(l) });
      if (persisted) {
        const vars = persisted.variables.map((v) => `$${v}`).join(', ');
        block = [head, `# persisted query: the text is not in the bundle (id ${persisted.id ?? 'unknown'})`, ...(vars ? [`# variables: ${vars}`] : [])].join('\n');
        break;
      }
    }
    if (!block) {
      const vars = e.params.filter((p) => p.in === 'graphql_var').map((p) => `$${p.name}`).join(', ');
      block = [head, mine.length > 0 ? '# the text could not be read back from the bundle' : '# observed in a HAR only', ...(vars ? [`# variables: ${vars}`] : [])].join('\n');
    }
    blocks.push(block);
  }
  return `${blocks.join('\n\n')}\n`;
}
