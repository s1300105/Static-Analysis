import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SaContext, createTarget, exportEndpoints, extractEndpoints, importHar, loadArtifact, unpackBundle } from '@sa/core';
import type { LoadArtifactFile, TargetScopeInput } from '@sa/types';
import { useContext, useTmpDir } from './helpers';

const makeCtx = useContext();
const tmp = useTmpDir();
const fixtures = new URL('./fixtures/', import.meta.url).pathname;
const endpointsBundle = join(fixtures, 'webpack5-endpoints/output/main.c452f02c.js');
const graphqlBundle = join(fixtures, 'webpack5-graphql/output/main.d30a92cb.js');

async function prepared(ctx: SaContext, files: LoadArtifactFile[], scope?: TargetScopeInput): Promise<{ targetId: string; versionId: string }> {
  const { id: targetId } = createTarget(ctx, { name: 'example', ...(scope && { scope }) });
  const { versionId } = loadArtifact(ctx, { targetId, collectedAt: '2026-10-01T00:00:00Z', files });
  await unpackBundle(ctx, { versionId });
  await extractEndpoints(ctx, { versionId });
  return { targetId, versionId };
}

type Op = { servers?: { url: string }[]; parameters?: { name: string; in: string; required?: boolean }[]; requestBody?: unknown; responses: unknown };

describe('exportEndpoints: OpenAPI', () => {
  it('writes REST endpoints as OpenAPI 3 with origins as servers and leaves out-of-scope hosts out', async () => {
    const ctx = makeCtx();
    const { targetId } = await prepared(
      ctx,
      [{ path: endpointsBundle, loadedByOrigins: ['https://app.example.com', 'https://admin.example.com'] }],
      { allowed_domains: ['*.example.com'], out_of_scope: ['auth.example.com'] },
    );
    const r = await exportEndpoints(ctx, { targetId });
    const doc = r.openapi as { openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, Op>>; 'x-sa-websockets': unknown[] };
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.servers).toEqual([{ url: 'https://admin.example.com' }, { url: 'https://app.example.com' }]);
    expect(Object.keys(doc.paths)).toEqual([
      '/api/v1/legacy-search',
      '/api/v2/admin/stats',
      '/api/v2/docs/{param}',
      '/api/v2/search',
      '/api/v2/users/{param}',
      '/legacy/reports/{param}/export',
      '/telemetry/ping',
    ]);
    const users = doc.paths['/api/v2/users/{param}']!;
    expect(Object.keys(users)).toEqual(['get', 'put']);
    expect(users.get).toMatchObject({
      servers: [{ url: 'https://admin.example.com' }, { url: 'https://app.example.com' }],
      parameters: [
        { name: 'param', in: 'path', required: true },
        { name: 'include', in: 'query' },
      ],
    });
    expect(users.put!.requestBody).toEqual({
      content: { 'application/json': { schema: { type: 'object', properties: { displayName: {}, email: {} } } } },
    });
    expect(doc['x-sa-websockets']).toMatchObject([{ url: 'wss://rt.example.com/socket' }]);
    // auth.example.com はスコープ外
    expect(r.counts).toMatchObject({ outOfScope: 1, websocket: 1 });

    // OpenAPI の約束: パスの {name} にはすべて in: path の必須パラメータがあり、responses がある
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const op of Object.values(item)) {
        for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
          expect(op.parameters?.some((p) => p.name === name && p.in === 'path' && p.required === true), `${path} ${name}`).toBe(true);
        }
        expect(op.responses).toBeDefined();
      }
    }

    const withAll = (await exportEndpoints(ctx, { targetId, includeOutOfScope: true })).openapi as { paths: Record<string, Record<string, Op>> };
    expect(withAll.paths['/oauth/token']!.post!.servers).toEqual([{ url: 'https://auth.example.com' }]);
    // 出力は決定的
    expect(JSON.stringify((await exportEndpoints(ctx, { targetId })))).toBe(JSON.stringify(r));
  });

  it('numbers repeated path parameter names and keeps endpoints with unknown methods aside', async () => {
    const ctx = makeCtx();
    const dir = tmp();
    writeFileSync(join(dir, 'a.js'), 'fetch(`/a/${x}/b/${y}`); fetch("/c", { method: m }); fetch(`/u/${userId}/p/${postId}`);');
    const { targetId } = await prepared(ctx, [{ path: join(dir, 'a.js') }]);
    const doc = (await exportEndpoints(ctx, { targetId })).openapi as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(doc.paths)).toEqual(['/a/{param}/b/{param2}', '/c', '/u/{userId}/p/{postId}']);
    expect(doc.paths['/c']).toEqual({ 'x-sa-method-unknown': [{ endpointIds: [expect.any(String)], parameters: [] }] });
  });
});

describe('exportEndpoints: GraphQL', () => {
  it('reads the operation documents back from the bundle, with fragments defined elsewhere', async () => {
    const ctx = makeCtx();
    const { targetId, versionId } = await prepared(ctx, [{ path: graphqlBundle }]);
    // HAR でだけ見た operation
    const har = join(tmp(), 'x.har');
    writeFileSync(
      har,
      JSON.stringify({
        log: {
          entries: [
            {
              startedDateTime: '2026-10-01T00:00:00Z',
              _resourceType: 'fetch',
              request: {
                method: 'POST',
                url: 'https://app.example.com/graphql',
                postData: { mimeType: 'application/json', text: JSON.stringify({ operationName: 'Secret', query: 'mutation Secret($a: Int) { s(a: $a) }' }) },
              },
              response: { status: 200, content: { mimeType: 'application/json' } },
            },
          ],
        },
      }),
    );
    importHar(ctx, { targetId, versionId, harPath: har });

    const { graphql, counts } = await exportEndpoints(ctx, { targetId });
    expect(counts.graphql).toBe(8);
    const block = (name: string) => graphql.split('\n\n# ').find((b) => b.replace(/^# /, '').split('\n')[0]!.split(' ')[1] === name)!;
    expect(block('GetFeed')).toContain(
      'query GetFeed($first: Int, $after: String) {\n  feed(first: $first, after: $after) {\n    ...PostFields\n  }\n}\n\nfragment PostFields on Post {\n  id\n  title\n}',
    );
    expect(block('AdminUsers')).toContain('query AdminUsers($role: Role) {\n  adminUsers\n}');
    expect(block('UpdateSettings')).toContain('mutation UpdateSettings($input: SettingsInput!, $notify: Boolean) {');
    expect(block('SearchUsers')).toContain('query SearchUsers($q: String!) {');
    expect(block('UserProfileQuery')).toContain(
      '# persisted query: the text is not in the bundle (id 7f3a9c2e1b4d6f8a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a)\n# variables: $userId, $withPosts',
    );
    expect(block('Secret')).toContain('# observed in a HAR only\n# variables: $a');
    expect(graphql.startsWith('# QUERY AdminUsers (/graphql)\n')).toBe(true);
  });
});
