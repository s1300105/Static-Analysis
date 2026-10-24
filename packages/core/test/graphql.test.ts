import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type SaContext, createTarget, extractEndpoints, listEndpoints, loadArtifact, unpackBundle } from '@sa/core';
import type { LoadArtifactFile } from '@sa/types';
import { getAnalysisRun } from '../src/db/repo/analysisRun';
import extractFromJs from '../src/jobs/workers/endpoints.worker';
import { useContext } from './helpers';

const makeCtx = useContext();
const bundle = new URL('./fixtures/webpack5-graphql/output/main.d30a92cb.js', import.meta.url).pathname;

/** GraphQL だけを拾い、比べやすい形にする */
function ops(code: string, modules?: { start: number; end: number }[]): string[] {
  const out = extractFromJs({ bytes: Buffer.from(code), ...(modules && { modules }), rest: false, graphql: true });
  expect(out.calls).toEqual([]);
  return out.graphql.map((o) => {
    const vars = o.variables.length > 0 ? ` (${o.variables.join(',')})` : '';
    return `${o.extractor} ${o.kind} ${o.name || '-'}${vars}${o.persistedId ? ` #${o.persistedId}` : ''}`;
  });
}

describe('GraphQL in the worker', () => {
  it('reads tagged templates whatever the tag is called, dropping ${} and fragment-only documents', () => {
    expect(
      ops(`
        const F = r.Ps\`fragment F on User { id }\`;
        const Q = (0, r.Ps)\`query Me($full: Boolean) { me { ...F } } \${F}\`;
        const M = gql\`
          # a comment
          mutation Rename($id: ID!, $name: String!) { rename(id: $id, name: $name) { id } }
        \`;
        const two = gql\`query A { a } query B($x: Int) { b(x: $x) }\`;
      `),
    ).toEqual(['graphql_text query Me (full)', 'graphql_text mutation Rename (id,name)', 'graphql_text query A', 'graphql_text query B (x)']);
  });

  it('reads the shorthand { ... } form only under a gql / graphql tag', () => {
    expect(ops('const a = gql`{ viewer { id } }`; const b = x`{ viewer { id } }`; const c = "{ viewer { id } }";')).toEqual([
      'graphql_text query -',
    ]);
  });

  it('reads plain strings and transpiled tagged templates (an array of strings) once', () => {
    expect(
      ops(`
        fetch("/graphql", { body: JSON.stringify({ query: "query Search($q: String!) { search(q: $q) { id } }" }) });
        var t = _taggedTemplateLiteral(["\\n  query Feed($first: Int) {\\n    feed(first: $first) { ...P }\\n  }\\n  ", "\\n"]);
      `),
    ).toEqual(['graphql_text query Search (q)', 'graphql_text query Feed (first)']);
  });

  it('ignores strings that only look like GraphQL', () => {
    expect(ops('x = ["query string is too long", "mutation observer started", "{ \\"query\\": 1 }", "subscription"];')).toEqual([]);
  });

  it('evaluates precompiled DocumentNode literals, following concat and variables', () => {
    const def = (op: string, name: string, vars: string[]) =>
      `{kind:"OperationDefinition",operation:"${op}",name:{kind:"Name",value:"${name}"},variableDefinitions:[${vars
        .map((v) => `{kind:"VariableDefinition",variable:{kind:"Variable",name:{kind:"Name",value:"${v}"}}}`)
        .join(',')}],selectionSet:{kind:"SelectionSet",selections:[]}}`;
    expect(
      ops(`
        var frag = {kind:"Document",definitions:[{kind:"FragmentDefinition",name:{kind:"Name",value:"P"}}]};
        var d = {kind:"Document",definitions:[${def('query', 'Posts', ['after'])}].concat(frag.definitions, unknown())};
        var defs = [${def('mutation', 'Like', ['postId'])}];
        var e = {kind:"Document",definitions:defs};
        var withBody = {kind:"Document",definitions:[],loc:{start:0,end:9,source:{body:"subscription Ping { ping }"}}};
      `),
    ).toEqual(['graphql_ast query Posts (after)', 'graphql_ast mutation Like (postId)', 'graphql_ast subscription Ping']);
  });

  it('reads Relay artifacts from their text, or from the argument definitions when persisted', () => {
    expect(
      ops(`
        var a = {kind:"Request",fragment:{},params:{cacheID:"c1",id:null,metadata:{},name:"ViewerQuery",operationKind:"query",
          text:"query ViewerQuery($size: Int) { viewer { avatar(size: $size) } }"}};
        var b = (function(){ var v0 = [{defaultValue:null,kind:"LocalArgument",name:"postId"}];
          return {fragment:{argumentDefinitions:v0},kind:"Request",operation:{argumentDefinitions:v0},
            params:{id:"abc123",metadata:{},name:"LikeMutation",operationKind:"mutation",text:null}}; })();
        var c = {kind:"PreloadableConcreteRequest",params:{id:"p9",metadata:{},name:"FeedQuery",operationKind:"query"}};
      `),
    ).toEqual([
      'relay query ViewerQuery (size)',
      'relay mutation LikeMutation (postId) #abc123',
      'relay query FeedQuery #p9',
    ]);
  });

  it('returns byte ranges of the expression', () => {
    const code = 'const s = "日本😀"; const q = gql`query Q { a }`;';
    const [op] = extractFromJs({ bytes: Buffer.from(code), rest: false, graphql: true }).graphql;
    expect(Buffer.from(code).subarray(op!.startByte, op!.endByte).toString()).toBe('gql`query Q { a }`');
  });
});

async function loadFixture(
  ctx: SaContext,
  file: Partial<LoadArtifactFile> = {},
): Promise<{ targetId: string; versionId: string }> {
  const { id: targetId } = createTarget(ctx, { name: 'example' });
  const { versionId } = loadArtifact(ctx, { targetId, collectedAt: '2026-10-01T09:00:00Z', files: [{ path: bundle, ...file }] });
  await unpackBundle(ctx, { versionId });
  return { targetId, versionId };
}

function rows(ctx: SaContext, versionId: string) {
  return ctx.db
    .prepare(
      `SELECT s.extracted_by, e.method, e.operation, e.origin, e.path_norm, e.persisted_hash, s.params, l.start_byte, l.end_byte
       FROM endpoint_sighting s JOIN api_endpoint e ON e.id = s.endpoint_id JOIN code_location l ON l.id = s.location_id
       WHERE s.version_id = ? AND e.operation <> '' ORDER BY l.start_byte, e.operation, e.origin`,
    )
    .all(versionId) as {
    extracted_by: string;
    method: string;
    operation: string;
    origin: string;
    path_norm: string;
    persisted_hash: string | null;
    params: string;
    start_byte: number;
    end_byte: number;
  }[];
}

describe('extractEndpoints: graphql', () => {
  it('writes one endpoint per operation, sent to the GraphQL endpoint ast_url found', async () => {
    const ctx = makeCtx();
    const { targetId, versionId } = await loadFixture(ctx);
    const r = await extractEndpoints(ctx, { versionId });
    expect(r.extractors.graphql).toMatchObject({ inputs: 1, found: 7, dropped: 0, sightings: 7, skipped: 0 });
    expect(r.extractors.ast_url).toMatchObject({ found: 1 });
    expect(r.endpoints).toBe(8);

    const got = rows(ctx, versionId).map((s) => ({
      by: s.extracted_by,
      op: `${s.method} ${s.operation}`,
      at: `${s.origin}${s.path_norm}`,
      vars: (JSON.parse(s.params) as { name: string; in: string }[]).map((p) => `${p.in}:${p.name}`),
      hash: s.persisted_hash,
    }));
    expect(got).toEqual([
      {
        by: 'relay',
        op: 'QUERY UserProfileQuery',
        at: '/graphql',
        vars: ['graphql_var:userId', 'graphql_var:withPosts'],
        hash: '7f3a9c2e1b4d6f8a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a',
      },
      { by: 'graphql_text', op: 'QUERY GetFeed', at: '/graphql', vars: ['graphql_var:first', 'graphql_var:after'], hash: null },
      { by: 'graphql_text', op: 'MUTATION DeletePost', at: '/graphql', vars: ['graphql_var:id', 'graphql_var:reason'], hash: null },
      { by: 'graphql_text', op: 'SUBSCRIPTION OnMessage', at: '/graphql', vars: ['graphql_var:room'], hash: null },
      { by: 'graphql_ast', op: 'QUERY AdminUsers', at: '/graphql', vars: ['graphql_var:role'], hash: null },
      { by: 'graphql_ast', op: 'MUTATION UpdateSettings', at: '/graphql', vars: ['graphql_var:input', 'graphql_var:notify'], hash: null },
      { by: 'graphql_text', op: 'QUERY SearchUsers', at: '/graphql', vars: ['graphql_var:q'], hash: null },
    ]);
    // 位置は式そのもの（Relay の生成物はオブジェクト、タグ付きテンプレートはタグから）
    const raw = readFileSync(bundle);
    const text = (i: number) => raw.subarray(rows(ctx, versionId)[i]!.start_byte, rows(ctx, versionId)[i]!.end_byte).toString();
    expect(text(0)).toMatch(/^\{fragment:\{argumentDefinitions:t=\[/);
    expect(text(1)).toMatch(/^a`\n {2}query GetFeed/);

    const run = getAnalysisRun(ctx, r.extractors.graphql!.runId)!;
    expect(run).toMatchObject({ tool: 'extract_endpoints/graphql', inputLayer: 'raw', filesTotal: 1, filesSkipped: 0 });
    expect(run.toolVersion).toMatch(/graphql 17\.\d+\.\d+/);

    // 一覧では送信先（POST /graphql）と operation が並ぶ
    const list = listEndpoints(ctx, { targetId });
    expect(list.filter((e) => e.operation === '').map((e) => `${e.method} ${e.pathNorm}`)).toEqual(['POST /graphql']);
    expect(list.find((e) => e.operation === 'UserProfileQuery')).toMatchObject({
      protocol: 'graphql',
      persistedHash: '7f3a9c2e1b4d6f8a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a',
      params: [
        { name: 'userId', in: 'graphql_var' },
        { name: 'withPosts', in: 'graphql_var' },
      ],
    });
  });

  it('sends operations to each origin of the GraphQL endpoint, or leaves the target empty when unknown', async () => {
    const ctx = makeCtx();
    const { versionId } = await loadFixture(ctx, { loadedByOrigins: ['https://app.example.com', 'https://admin.example.com'] });
    await extractEndpoints(ctx, { versionId });
    const byOrigin = new Map<string, number>();
    for (const s of rows(ctx, versionId)) byOrigin.set(`${s.origin}${s.path_norm}`, (byOrigin.get(`${s.origin}${s.path_norm}`) ?? 0) + 1);
    expect(Object.fromEntries(byOrigin)).toEqual({ 'https://admin.example.com/graphql': 7, 'https://app.example.com/graphql': 7 });

    // graphql だけを掛けた別の版: 送信先が分からないので origin もパスも ''
    const ctx2 = makeCtx();
    const { versionId: v2 } = await loadFixture(ctx2);
    const r = await extractEndpoints(ctx2, { versionId: v2, extractors: ['graphql'] });
    expect(Object.keys(r.extractors)).toEqual(['graphql']);
    expect(new Set(rows(ctx2, v2).map((s) => `${s.origin}|${s.path_norm}`))).toEqual(new Set(['|']));
  });

  it('rewrites only its own sightings on a re-run', async () => {
    const ctx = makeCtx();
    const { versionId } = await loadFixture(ctx);
    await extractEndpoints(ctx, { versionId });
    const before = rows(ctx, versionId);
    const again = await extractEndpoints(ctx, { versionId, extractors: ['graphql'] });
    const after = rows(ctx, versionId);
    expect(after.map(({ params: _p, ...rest }) => rest)).toEqual(before.map(({ params: _p, ...rest }) => rest));
    const runs = ctx.db.prepare('SELECT DISTINCT run_id FROM endpoint_sighting WHERE extracted_by IN (?, ?, ?)').pluck().all('graphql_text', 'graphql_ast', 'relay');
    expect(runs).toEqual([again.extractors.graphql!.runId]);
    // ast_url の sighting（POST /graphql）は残る
    expect(ctx.db.prepare("SELECT count(*) FROM endpoint_sighting WHERE extracted_by = 'ast_url'").pluck().get()).toBe(1);
  });
});
