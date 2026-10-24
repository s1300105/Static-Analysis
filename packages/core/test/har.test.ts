import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SaContext, createTarget, extractEndpoints, importHar, ingestHar, listEndpoints, loadArtifact } from '@sa/core';
import { listArtifactFiles } from '../src/db/repo/artifactFile';
import { getArtifactVersion } from '../src/db/repo/artifactVersion';
import { listPageContexts } from '../src/db/repo/pageContext';
import { useContext, useTmpDir } from './helpers';

const makeCtx = useContext();
const tmp = useTmpDir();
const fixtures = new URL('./fixtures/', import.meta.url).pathname;
const endpointsBundle = join(fixtures, 'webpack5-endpoints/output/main.c452f02c.js');
const graphqlBundle = join(fixtures, 'webpack5-graphql/output/main.d30a92cb.js');
const RELAY_HASH = '7f3a9c2e1b4d6f8a0c2e4b6d8f0a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a';

/** HAR のどこに値があっても残らないことを確かめるための目印。どれも DB・blob・作業ディレクトリに現れてはいけない */
const SECRETS = [
  'SECRET_PAGE_QUERY',
  'SECRET_DOC_QUERY',
  'SECRETNONCE123',
  'SECRET_REPORT_KEY',
  'SECRET_SET_COOKIE',
  'SECRET_HEADER_VALUE',
  'SECRET_HTML_BODY',
  'SECRET_SCRIPT_QUERY',
  'SECRET_QUERY_VALUE',
  'SECRET_AUTH_TOKEN',
  'SECRET_COOKIE_REQ',
  'SECRET_RESPONSE_EMAIL',
  'SECRET_BODY_VALUE',
  'SECRET_FORM_VALUE',
  'SECRET_GQL_VAR',
  'SECRET_GQL_GET',
  'SECRET_GQL_QUERY_TEXT',
  'SECRET_WS_TOKEN',
  'SECRETtoken0123456789',
  'secret-mail',
] as const;

const h = (name: string, value: string) => ({ name, value });

function entry(over: Record<string, unknown>, req: Record<string, unknown>, res: Record<string, unknown> = {}) {
  return {
    pageref: 'page_1',
    startedDateTime: '2026-10-02T10:00:05.000Z',
    ...over,
    request: { method: 'GET', headers: [h('Cookie', 'sid=SECRET_COOKIE_REQ')], queryString: [], ...req },
    response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '{"email":"SECRET_RESPONSE_EMAIL"}' }, ...res },
  };
}

function makeHar(): unknown {
  const js = readFileSync(endpointsBundle, 'utf8');
  return {
    log: {
      version: '1.2',
      pages: [{ id: 'page_1', title: 'https://app.example.com/dashboard?session=SECRET_PAGE_QUERY', startedDateTime: '2026-10-02T10:00:00.000Z' }],
      entries: [
        entry(
          { _resourceType: 'document' },
          { url: 'https://app.example.com/dashboard?session=SECRET_DOC_QUERY' },
          {
            headers: [
              h('Content-Security-Policy', "script-src 'nonce-SECRETNONCE123' 'strict-dynamic'; report-uri https://csp.example.com/r?key=SECRET_REPORT_KEY"),
              h('Content-Security-Policy-Report-Only', "require-trusted-types-for 'script'"),
              h('X-Frame-Options', 'DENY'),
              h('Cross-Origin-Opener-Policy', 'same-origin'),
              h('Set-Cookie', 'session=SECRET_SET_COOKIE; HttpOnly'),
              h('X-Internal', 'SECRET_HEADER_VALUE'),
            ],
            content: {
              mimeType: 'text/html; charset=utf-8',
              text: `<html><head><meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'"></head><body>SECRET_HTML_BODY</body></html>`,
            },
          },
        ),
        entry(
          { _resourceType: 'script' },
          { url: 'https://cdn.example.com/static/main.c452f02c.js?token=SECRET_SCRIPT_QUERY' },
          { content: { mimeType: 'application/javascript', text: Buffer.from(js).toString('base64'), encoding: 'base64' } },
        ),
        // sourcemap は本文が無い（取り込めない）
        entry({}, { url: 'https://cdn.example.com/static/main.c452f02c.js.map' }, { content: { mimeType: 'application/json' } }),
        entry(
          { _resourceType: 'xhr' },
          {
            url: 'https://app.example.com/api/v2/users/12345?include=SECRET_QUERY_VALUE',
            headers: [h('Authorization', 'Bearer SECRET_AUTH_TOKEN'), h('Cookie', 'sid=SECRET_COOKIE_REQ')],
          },
        ),
        entry(
          { _resourceType: 'fetch' },
          {
            method: 'PUT',
            url: 'https://app.example.com/api/v2/users/12345',
            postData: { mimeType: 'application/json', text: '{"displayName":"SECRET_BODY_VALUE","email":"a@b","newField":1}' },
          },
        ),
        entry(
          { _resourceType: 'fetch' },
          {
            method: 'POST',
            url: 'https://app.example.com/api/v2/hidden/feature',
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'flag=SECRET_FORM_VALUE&mode=1' },
          },
        ),
        entry(
          { _resourceType: 'fetch' },
          {
            method: 'POST',
            url: 'https://app.example.com/graphql',
            postData: {
              mimeType: 'application/json',
              text: JSON.stringify({
                operationName: 'GetFeed',
                query: 'query GetFeed($first: Int, $after: String) { feed(first: $first, after: $after, tag: "SECRET_GQL_QUERY_TEXT") { id } }',
                variables: { first: 'SECRET_GQL_VAR' },
              }),
            },
          },
        ),
        entry(
          { _resourceType: 'fetch' },
          {
            url: `https://app.example.com/graphql?operationName=UserProfileQuery&variables=${encodeURIComponent(
              JSON.stringify({ userId: 'SECRET_GQL_GET' }),
            )}&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: RELAY_HASH } }))}`,
          },
        ),
        entry({ _resourceType: 'image' }, { url: 'https://app.example.com/logo.png' }, { content: { mimeType: 'image/png' } }),
        entry(
          { _resourceType: 'preflight' },
          { method: 'OPTIONS', url: 'https://app.example.com/api/v2/users/1', headers: [h('Access-Control-Request-Method', 'PUT')] },
        ),
        entry({ _resourceType: 'websocket' }, { url: 'wss://rt.example.com/socket?token=SECRET_WS_TOKEN' }, { status: 101 }),
        entry({ _resourceType: 'fetch' }, { url: 'https://app.example.com/reset/SECRETtoken0123456789ABCD' }),
        entry({ _resourceType: 'fetch' }, { url: 'https://app.example.com/api/users/alice%40secret-mail.example/profile' }),
        { request: { url: 'not a url', method: 'GET' }, response: { status: 0 } },
      ],
    },
  };
}

function writeHar(har: unknown = makeHar()): string {
  const path = join(tmp(), 'capture.har');
  writeFileSync(path, JSON.stringify(har));
  return path;
}

/** home の下のすべてのファイル（DB を含む）の中身 */
function everything(ctx: SaContext): string {
  ctx.db.pragma('wal_checkpoint(TRUNCATE)');
  const root = join(ctx.config.dbPath, '..');
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(readFileSync(p).toString('latin1'));
    }
  };
  walk(root);
  return out.join('\n');
}

async function prepared(ctx: SaContext): Promise<{ targetId: string; versionId: string }> {
  const { id: targetId } = createTarget(ctx, { name: 'example', scope: { allowed_domains: ['*.example.com'] } });
  const { versionId } = loadArtifact(ctx, {
    targetId,
    collectedAt: '2026-10-02T09:00:00Z',
    files: [{ path: endpointsBundle }, { path: graphqlBundle }],
  });
  await extractEndpoints(ctx, { versionId });
  return { targetId, versionId };
}

describe('importHar', () => {
  it('keeps only allow-listed fields and never stores the HAR', async () => {
    const ctx = makeCtx();
    const { versionId } = await prepared(ctx);
    const harPath = writeHar();
    const before = readFileSync(harPath);
    const r = await ingestHar(ctx, { targetId: getArtifactVersion(ctx, versionId)!.targetId, versionId, harPath });
    expect(r.har).toMatchObject({ entries: 14, invalid: 1, ignored: 2, pages: 1, scripts: { added: 0, withoutBody: 1 } });

    const all = everything(ctx);
    for (const secret of SECRETS) expect({ secret, found: all.includes(secret) }).toEqual({ secret, found: false });
    // HAR の中身はどこにも書かれない（元のファイルはそのまま人間の手元に残る）
    expect(all.includes(before.toString('latin1').slice(0, 200))).toBe(false);
    expect(readFileSync(harPath)).toEqual(before);
  });

  it('matches API calls to the extracted templates and registers HAR-only endpoints', async () => {
    const ctx = makeCtx();
    const { targetId, versionId } = await prepared(ctx);
    const r = importHar(ctx, { targetId, versionId, harPath: writeHar() });
    // API の呼び出し 8 件（users GET・PUT、hidden、graphql POST・GET、websocket、reset、profile）
    expect(r.api).toMatchObject({ requests: 8 });

    const list = listEndpoints(ctx, { targetId });
    const find = (method: string, path: string, operation = '') =>
      list.find((e) => e.method === method && `${e.origin}${e.pathNorm}`.endsWith(path) && e.operation === operation);

    // 静的に抽出した endpoint（origin は不明）に当たり、パラメータの名前が足される（値は残らない）
    expect(find('GET', '/api/v2/users/{}')).toMatchObject({ origin: '', observedInHar: true, params: [{ name: 'include', in: 'query' }] });
    expect(find('PUT', '/api/v2/users/{}')!.params).toEqual(
      expect.arrayContaining([
        { name: 'displayName', in: 'body' },
        { name: 'email', in: 'body' },
        { name: 'newField', in: 'body' },
      ]),
    );
    expect(find('', 'wss://rt.example.com/socket')).toMatchObject({ protocol: 'websocket', observedInHar: true });
    // GraphQL: 名前で当たる（変数名だけ）・persisted query はハッシュでも当たる
    expect(find('QUERY', '/graphql', 'GetFeed')).toMatchObject({ observedInHar: true });
    expect(find('QUERY', '/graphql', 'GetFeed')!.params).toEqual(
      expect.arrayContaining([
        { name: 'first', in: 'graphql_var' },
        { name: 'after', in: 'graphql_var' },
      ]),
    );
    expect(find('QUERY', '/graphql', 'UserProfileQuery')).toMatchObject({ observedInHar: true, persistedHash: RELAY_HASH });
    expect(find('POST', '/graphql')).toMatchObject({ protocol: 'graphql', observedInHar: true });

    // HAR にしか無いもの: origin つきで、パスの ID・トークン・メールアドレスは {}
    const harOnly = list.filter((e) => e.observedInHar && e.sightings === 1 && e.origin === 'https://app.example.com');
    expect(harOnly.map((e) => `${e.method} ${e.pathNorm}`).sort()).toEqual([
      'GET /api/users/{}/profile',
      'GET /graphql',
      'GET /reset/{}',
      'POST /api/v2/hidden/feature',
    ]);
    expect(find('POST', '/api/v2/hidden/feature')).toMatchObject({ inScope: true, params: [{ name: 'flag', in: 'body' }, { name: 'mode', in: 'body' }] });
    expect(r.api.harOnly).toBe(4);
  });

  it('records security headers of documents without tokens, and script origins', async () => {
    const ctx = makeCtx();
    const { versionId } = await prepared(ctx);
    importHar(ctx, { targetId: getArtifactVersion(ctx, versionId)!.targetId, versionId, harPath: writeHar() });
    expect(listPageContexts(ctx, versionId)).toMatchObject([
      {
        documentUrl: 'https://app.example.com/dashboard',
        observedAt: '2026-10-02T10:00:05.000Z',
        headers: {
          'content-security-policy': ["script-src 'nonce-{}' 'strict-dynamic'; report-uri https://csp.example.com/r"],
          'content-security-policy-report-only': ["require-trusted-types-for 'script'"],
          'x-frame-options': 'DENY',
          'cross-origin-opener-policy': 'same-origin',
          'meta-content-security-policy': ["frame-ancestors 'none'"],
        },
      },
    ]);
    // HAR の JS は既に取り込んだものと同じ中身 → 行は 1 つのまま、配信 URL（クエリ無し）と読み込んだ文書のオリジンが足される
    const raw = listArtifactFiles(ctx, { versionId, layer: 'raw' }).find((f) => f.origName === 'main.c452f02c.js')!;
    expect(raw.sourceUrls).toEqual(['https://cdn.example.com/static/main.c452f02c.js']);
    expect(raw.loadedByOrigins).toEqual(['https://app.example.com']);
  });

  it('merges parameters and keeps one page row when the same HAR is imported again', async () => {
    const ctx = makeCtx();
    const { targetId, versionId } = await prepared(ctx);
    const harPath = writeHar();
    importHar(ctx, { targetId, versionId, harPath });
    const once = listEndpoints(ctx, { targetId });
    const again = importHar(ctx, { targetId, versionId, harPath });
    expect(again.api.harOnly).toBe(0);
    expect(listEndpoints(ctx, { targetId }).map(({ id, params, sightings }) => ({ id, params, sightings }))).toEqual(
      once.map(({ id, params, sightings }) => ({ id, params, sightings })),
    );
    expect(listPageContexts(ctx, versionId)).toHaveLength(1);
  });

  it('creates a version dated by the HAR and loads the scripts it carries', async () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example' });
    const r = await ingestHar(ctx, { targetId, harPath: writeHar(), label: 'from-har' });
    expect(r.har).toMatchObject({ createdVersion: true, scripts: { added: 1 } });
    expect(getArtifactVersion(ctx, r.har.versionId)).toMatchObject({ collectedAt: '2026-10-02T10:00:00.000Z', label: 'from-har' });
    expect(r.unpack).toMatchObject({ files: 1 });
    // 抽出の前に取り込んだので、API はすべて HAR にしか無い endpoint になる
    expect(r.har.api.matched).toBe(0);
  });

  it('rejects files that are not HAR and versions it cannot use', async () => {
    const ctx = makeCtx();
    const { id: targetId } = createTarget(ctx, { name: 'example' });
    const other = createTarget(ctx, { name: 'other' });
    const dir = tmp();
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as { code: string }).code;
      }
      return 'ok';
    };
    writeFileSync(join(dir, 'x.har'), '{ not json');
    expect(code(() => importHar(ctx, { targetId, harPath: join(dir, 'x.har') }))).toBe('INVALID_INPUT');
    writeFileSync(join(dir, 'y.har'), '{"log":{}}');
    expect(code(() => importHar(ctx, { targetId, harPath: join(dir, 'y.har') }))).toBe('INVALID_INPUT');
    expect(code(() => importHar(ctx, { targetId, harPath: join(dir, 'missing.har') }))).toBe('INVALID_INPUT');
    writeFileSync(join(dir, 'z.har'), JSON.stringify({ log: { entries: [] } }));
    expect(code(() => importHar(ctx, { targetId, harPath: join(dir, 'z.har') }))).toBe('INVALID_INPUT');
    expect(importHar(ctx, { targetId, harPath: join(dir, 'z.har'), collectedAt: '2026-10-01T00:00:00Z' })).toMatchObject({ entries: 0 });
    const { versionId } = loadArtifact(ctx, { targetId: other.id, collectedAt: '2026-10-01T00:00:00Z', files: [{ path: endpointsBundle }] });
    expect(code(() => importHar(ctx, { targetId, versionId, harPath: writeHar() }))).toBe('INVALID_INPUT');
  });
});
