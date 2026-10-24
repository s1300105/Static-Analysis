import { describe, expect, it } from 'vitest';
import { type SaContext, createTarget } from '@sa/core';
import { TargetScopeSchema } from '@sa/types';
import { insertArtifactFile } from '../src/db/repo/artifactFile';
import { insertArtifactVersion } from '../src/db/repo/artifactVersion';
import { ensureCodeLocation } from '../src/db/repo/codeLocation';
import { endpointParams, listEndpointSummaries, upsertEndpoint, upsertSighting } from '../src/db/repo/endpoint';
import { hostOfOrigin, matchesHostPattern, originInScope } from '../src/policy/scope';
import { catchError, useContext } from './helpers';

const makeCtx = useContext();

function versionAt(ctx: SaContext, targetId: string, collectedAt: string): string {
  return insertArtifactVersion(ctx, { targetId, collectedAt });
}

describe('api_endpoint / endpoint_sighting', () => {
  it('keeps one endpoint per key and fills display fields once', () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example' });
    const key = { targetId, protocol: 'rest' as const, origin: '', method: 'GET', pathNorm: '/api/users/{}', operation: '' };
    const a = upsertEndpoint(ctx, key);
    const b = upsertEndpoint(ctx, { ...key, pathTemplate: '/api/users/:id' });
    const c = upsertEndpoint(ctx, { ...key, pathTemplate: '/api/users/:userId' });
    expect(new Set([a, b, c]).size).toBe(1);
    expect(listEndpointSummaries(ctx, targetId)).toMatchObject([{ id: a, pathTemplate: '/api/users/:id', triage: 'untested' }]);
    // method が違えば別の endpoint
    expect(upsertEndpoint(ctx, { ...key, method: 'POST' })).not.toBe(a);
  });

  it('derives first/last seen, HAR observation and the parameter union from sightings', () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example' });
    const v1 = versionAt(ctx, targetId, '2026-09-01T00:00:00.000Z');
    const v2 = versionAt(ctx, targetId, '2026-10-01T00:00:00.000Z');
    const raw = insertArtifactFile(ctx, { versionId: v1, layer: 'raw', path: 'x', contentHash: 'a'.repeat(64) });
    const loc = ensureCodeLocation(ctx, { rawFileId: raw, startByte: 10, endByte: 30, line: 1, col: 10 });
    expect(ensureCodeLocation(ctx, { rawFileId: raw, startByte: 10, endByte: 30 })).toBe(loc);

    const e = upsertEndpoint(ctx, { targetId, protocol: 'rest', origin: '', method: 'GET', pathNorm: '/api/users', operation: '' });
    upsertSighting(ctx, { endpointId: e, versionId: v1, locationId: loc, params: [{ name: 'q', in: 'query' }], extractedBy: 'ast_url' });
    // 同じ版・位置・抽出器で掛け直したらパラメータは新しいものになる
    upsertSighting(ctx, {
      endpointId: e,
      versionId: v1,
      locationId: loc,
      params: [{ name: 'q', in: 'query' }, { name: 'page', in: 'query' }],
      extractedBy: 'ast_url',
    });
    upsertSighting(ctx, { endpointId: e, versionId: v2, params: [{ name: 'X-Debug', in: 'header' }], extractedBy: 'har' });

    expect(listEndpointSummaries(ctx, targetId)).toMatchObject([
      { firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-10-01T00:00:00.000Z', observedInHar: true, sightings: 2 },
    ]);
    expect(endpointParams(ctx, e)).toEqual([
      { name: 'X-Debug', in: 'header' },
      { name: 'page', in: 'query' },
      { name: 'q', in: 'query' },
    ]);
  });

  it('rejects inverted byte ranges', () => {
    const ctx = makeCtx();
    expect((catchError(() => ensureCodeLocation(ctx, { rawFileId: 'x', startByte: 5, endByte: 4 })) as { code: string }).code).toBe(
      'INVALID_INPUT',
    );
  });
});

describe('scope matching', () => {
  const scopes = [
    { allowed_domains: ['example.com', '*.example.com'], out_of_scope: ['blog.example.com'] },
    { allowed_domains: ['*.example.com'], out_of_scope: [] },
    { allowed_domains: ['api.example.com'], out_of_scope: ['*.internal.example.com'] },
    { allowed_domains: [], out_of_scope: [] },
  ];
  const origins = [
    '',
    'https://example.com',
    'https://api.example.com:8443',
    'https://blog.example.com',
    'https://x.internal.example.com',
    'https://notexample.com',
    'https://example.com.evil.com',
    '//cdn.example.com',
    'https://{}.example.com',
    'wss://rt.example.com',
  ];

  it('agrees between the VIEW and policy/scope for every origin and scope', () => {
    const ctx = makeCtx();
    for (const [i, raw] of scopes.entries()) {
      const scope = TargetScopeSchema.parse(raw);
      const { id: targetId } = createTarget(ctx, { name: `t${i}`, scope });
      for (const origin of origins) {
        upsertEndpoint(ctx, { targetId, protocol: 'rest', origin, method: '', pathNorm: '/x', operation: '' });
      }
      for (const row of listEndpointSummaries(ctx, targetId)) {
        expect({ scope: i, origin: row.origin, inScope: row.inScope, host: row.host }).toEqual({
          scope: i,
          origin: row.origin,
          inScope: originInScope(row.origin, scope),
          host: hostOfOrigin(row.origin),
        });
      }
    }
  });

  it('treats *. as subdomains only', () => {
    expect(matchesHostPattern('example.com', '*.example.com')).toBe(false);
    expect(matchesHostPattern('a.example.com', '*.example.com')).toBe(true);
    expect(matchesHostPattern('a.b.example.com', '*.example.com')).toBe(true);
    expect(matchesHostPattern('badexample.com', '*.example.com')).toBe(false);
    expect(originInScope('https://blog.example.com', TargetScopeSchema.parse(scopes[0]))).toBe(false);
    expect(originInScope('', TargetScopeSchema.parse(scopes[0]))).toBeNull();
  });

  it('only accepts host patterns in the scope', () => {
    for (const bad of ['https://example.com', 'example.com/path', 'example.com:443', '*example.com', '']) {
      expect(TargetScopeSchema.safeParse({ allowed_domains: [bad] }).success).toBe(false);
    }
  });
});
