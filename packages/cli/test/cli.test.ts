import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_VERSION, run } from '@sa/cli';
import { SCHEMA_VERSION } from '@sa/core';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sa-cli-test-'));
  dirs.push(d);
  return d;
}

const fixtures = new URL('../../core/test/fixtures/webpack5-basic/', import.meta.url).pathname;
const output = join(fixtures, 'output');
const endpointsBundle = new URL('../../core/test/fixtures/webpack5-endpoints/output/main.c452f02c.js', import.meta.url).pathname;
const graphqlBundle = new URL('../../core/test/fixtures/webpack5-graphql/output/main.d30a92cb.js', import.meta.url).pathname;

/** home を一時ディレクトリにして sa を実行する */
function cli(home: string) {
  return async (...args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await run(['node', 'sa', '--home', home, ...args], {
      stdout: (s) => (stdout += s),
      stderr: (s) => (stderr += s),
      env: {},
      cwd: home,
    });
    return { code, stdout, stderr, json: <T = Record<string, unknown>>() => JSON.parse(stdout) as T };
  };
}

const evidence = ['--policy-confirmed-at', '2026-10-20', '--policy-source', 'https://hackerone.com/example/policy'];

describe('sa', () => {
  it('prints its version and help', async () => {
    const sa = cli(tmp());
    expect(await sa('--version')).toMatchObject({ code: 0, stdout: `${CLI_VERSION}\n` });
    const help = await sa('--help');
    expect(help.code).toBe(0);
    for (const c of ['target', 'load', 'import-har', 'missing-chunks', 'extract-endpoints', 'endpoints', 'backup']) {
      expect(help.stdout).toContain(c);
    }
  });

  it('rejects unknown commands and options as usage errors', async () => {
    const sa = cli(tmp());
    expect((await sa('nope')).code).not.toBe(0);
    expect((await sa('target', 'add', 'x', '--llm-code-policy', 'sometimes')).code).not.toBe(0);
  });
});

describe('sa target', () => {
  it('adds, lists, shows and updates a target', async () => {
    const home = tmp();
    const sa = cli(home);
    const added = await sa('--json', 'target', 'add', 'example', '--allow', 'example.com', '--allow', 'api.example.com');
    expect(added.code).toBe(0);
    expect(added.json()).toMatchObject({
      name: 'example',
      scope: { allowed_domains: ['example.com', 'api.example.com'], llm_code_policy: 'deny' },
    });
    // データは home の下にできる（接続を閉じると WAL のファイルは消える）
    expect(readdirSync(home).sort()).toEqual(['blobs', 'sa.db', 'workspace']);

    const list = await sa('target', 'list');
    expect(list.stdout).toContain('example  llm_code_policy=deny  example.com,api.example.com');

    const updated = await sa('--json', 'target', 'set-scope', 'example', '--llm-code-policy', 'no_original', ...evidence);
    expect(updated.code).toBe(0);
    // 指定しなかった項目はそのまま
    expect(updated.json()).toMatchObject({
      scope: { allowed_domains: ['example.com', 'api.example.com'], llm_code_policy: 'no_original' },
    });

    const shown = await sa('target', 'show', 'example');
    expect(shown.stdout).toContain('llm_code_policy : no_original (confirmed 2026-10-20, https://hackerone.com/example/policy)');
    expect(shown.stdout).toContain('versions        : 0');
  });

  it('refuses to allow LLM access without recording where the program allows it', async () => {
    const sa = cli(tmp());
    await sa('target', 'add', 'example');
    const r = await sa('target', 'set-scope', 'example', '--llm-code-policy', 'allow');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('llm_code_policy_confirmed_at');
    expect((await sa('--json', 'target', 'show', 'example')).json()).toMatchObject({ scope: { llm_code_policy: 'deny' } });
  });

  it('reports validation details and maps error codes to exit codes', async () => {
    const sa = cli(tmp());
    const bad = await sa('target', 'add', 'example', '--llm-code-policy', 'allow', '--policy-confirmed-at', 'last week', '--policy-source', 'x');
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/llm_code_policy_confirmed_at: /);
    expect(bad.stderr).toMatch(/llm_code_policy_source_url: /);
    expect((await sa('target', 'show', 'missing')).code).toBe(3);
  });
});

describe('sa load', () => {
  it('loads a bundle, unpacks it and imports its sourcemaps', async () => {
    const sa = cli(tmp());
    await sa('target', 'add', 'example');
    const files = readdirSync(output).map((f) => join(output, f));
    const r = await sa('--json', 'load', 'example', ...files, '--collected-at', 'now', '--label', 'v1', '--notes', '{"loggedIn":true}');
    expect(r.code).toBe(0);
    const body = r.json<{
      load: { createdVersion: boolean; added: number; versionId: string };
      unpack: { moduleCount: number; skipped: number };
      sourcemaps: { origName: string; result?: { accepted: boolean } }[];
    }>();
    expect(body.load).toMatchObject({ createdVersion: true, added: 6 });
    expect(body.unpack).toMatchObject({ moduleCount: 4, skipped: 0 });
    expect(body.sourcemaps.map((s) => [s.origName, s.result?.accepted]).sort()).toEqual([
      ['949.d486fd40.js.map', true],
      ['lazy.ce3f5b37.js.map', true],
      ['main.037dca38.js.map', true],
    ]);

    const shown = await sa('--json', 'target', 'show', 'example');
    expect(shown.json()).toMatchObject({
      versions: [{ id: body.load.versionId, label: 'v1', collectionNotes: { loggedIn: true }, files: { raw: 6, unpacked: 4, original: 16 } }],
    });
  });

  it('adds files to an existing version and reports maps it cannot place', async () => {
    const sa = cli(tmp());
    await sa('target', 'add', 'example');
    const first = await sa('--json', 'load', 'example', join(output, 'main.037dca38.js'), '--collected-at', '2026-10-01T09:00:00Z');
    const versionId = first.json<{ load: { versionId: string } }>().load.versionId;

    // 別ビルドの map は名前でも sourceMappingURL でも生成元が決まらない → その map だけ取り込まずに続ける
    const r = await sa('load', 'example', join(fixtures, 'other-build', 'main.57d12ed8.js.map'), '--version-id', versionId);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`version ${versionId}: 1 files, 1 added`);
    expect(r.stdout).toContain('sourcemap main.57d12ed8.js.map: not imported - cannot find the generated file');
  });

  it('reads per-file information from a manifest', async () => {
    const home = tmp();
    const sa = cli(home);
    await sa('target', 'add', 'example');
    writeFileSync(
      join(home, 'manifest.json'),
      JSON.stringify([
        {
          path: join(output, 'lazy.ce3f5b37.js'),
          sourceUrls: ['https://cdn.example.com/lazy.ce3f5b37.js'],
          loadedByOrigins: ['https://app.example.com'],
          ownership: 'first_party',
        },
      ]),
    );
    const r = await sa('--json', 'load', 'example', '--manifest', 'manifest.json', '--collected-at', 'now', '--no-unpack');
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ load: { added: 1 }, sourcemaps: [] });
    expect(r.json<{ unpack?: unknown }>().unpack).toBeUndefined();
  });

  it('validates its input', async () => {
    const home = tmp();
    const sa = cli(home);
    await sa('target', 'add', 'example');
    const lazy = join(output, 'lazy.ce3f5b37.js');
    expect((await sa('load', 'example', lazy)).stderr).toContain('collectedAt is required');
    expect((await sa('load', 'example', '--collected-at', 'now')).code).toBe(2);
    expect((await sa('load', 'missing', lazy, '--collected-at', 'now')).code).toBe(3);
    expect((await sa('load', 'example', lazy, '--collected-at', 'now', '--notes', '[1]')).code).toBe(2);
    writeFileSync(join(home, 'capture.har'), '{"log":{}}');
    const har = await sa('load', 'example', 'capture.har', '--collected-at', 'now');
    expect(har.code).toBe(2);
    expect(har.stderr).toContain('HAR files are not stored');
  });
});

describe('sa extract-endpoints / sa endpoints', () => {
  it('extracts endpoints from the latest version and lists them', async () => {
    const home = tmp();
    const sa = cli(home);
    await sa('target', 'add', 'example', '--allow', 'app.example.com', '--allow', '*.example.com', '--out-of-scope', 'auth.example.com');
    writeFileSync(join(home, 'manifest.json'), JSON.stringify([{ path: endpointsBundle, loadedByOrigins: ['https://app.example.com'] }]));
    await sa('load', 'example', '--manifest', 'manifest.json', '--collected-at', '2026-09-01T00:00:00Z');
    const latest = await sa('--json', 'load', 'example', '--manifest', 'manifest.json', '--collected-at', '2026-10-01T00:00:00Z');
    const versionId = latest.json<{ load: { versionId: string } }>().load.versionId;

    const r = await sa('extract-endpoints', 'example');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`version ${versionId}: 10 endpoints, 10 sightings`);
    expect(r.stdout).toContain('  ast_url: 1 inputs, 10 found, 0 dropped, 10 sightings, 0 skipped');
    expect(r.stdout).toContain('  jsluice: not configured');

    const list = await sa('endpoints', 'example');
    expect(list.code).toBe(0);
    const lines = list.stdout.trim().split('\n');
    expect(lines).toHaveLength(10);
    expect(lines).toContain('GET     https://app.example.com/api/v2/users/:param  [query:include]  (in scope; 1 sighting)');
    expect(lines).toContain(
      'POST    https://auth.example.com/oauth/token  [body:grant_type body:password body:username header:Content-Type header:X-Client-Version]  (OUT OF SCOPE; 1 sighting)',
    );
    expect(lines).toContain('websocket wss://rt.example.com/socket  (in scope; 1 sighting)');

    const json = await sa('--json', 'endpoints', 'example');
    expect(json.json<unknown[]>()).toHaveLength(10);
    expect(json.json<{ pathNorm: string; params: unknown[] }[]>().find((e) => e.pathNorm === '/api/v2/search')).toMatchObject({
      method: 'GET',
      origin: 'https://app.example.com',
      params: [
        { name: 'limit', in: 'query' },
        { name: 'q', in: 'query' },
      ],
      inScope: true,
      firstSeen: '2026-10-01T00:00:00.000Z',
    });
  });

  it('extracts a chosen version and reports errors', async () => {
    const home = tmp();
    const sa = cli(home);
    await sa('target', 'add', 'example');
    await sa('target', 'add', 'other');
    expect((await sa('extract-endpoints', 'example')).code).toBe(3);
    expect((await sa('endpoints', 'example')).stdout).toContain('no endpoints');
    const loaded = await sa('--json', 'load', 'example', endpointsBundle, '--collected-at', 'now');
    const versionId = loaded.json<{ load: { versionId: string } }>().load.versionId;
    expect((await sa('extract-endpoints', 'other', '--version-id', versionId)).code).toBe(3);
    const r = await sa('--json', 'extract-endpoints', 'example', '--version-id', versionId);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ versionId, endpoints: 10, extractors: { ast_url: { skipped: 0 } }, unavailable: ['jsluice'] });
    expect((await sa('extract-endpoints', 'example', '--extractor', 'nope')).code).toBe(2);
    const noJsluice = await sa('extract-endpoints', 'example', '--extractor', 'jsluice');
    expect(noJsluice.code).toBe(2);
    expect(noJsluice.stderr).toContain('jsluice is not configured');
  });

  it('lists GraphQL operations with their kind, target and persisted query id', async () => {
    const sa = cli(tmp());
    await sa('target', 'add', 'example');
    await sa('load', 'example', graphqlBundle, '--collected-at', 'now');
    const r = await sa('extract-endpoints', 'example');
    expect(r.stdout).toContain('  graphql: 1 inputs, 7 found, 0 dropped, 7 sightings, 0 skipped');
    const lines = (await sa('endpoints', 'example')).stdout.trim().split('\n');
    expect(lines).toHaveLength(8);
    expect(lines).toContain('graphql POST /graphql  [header:Content-Type]  (scope ?; 1 sighting)');
    expect(lines).toContain(
      'graphql QUERY /graphql UserProfileQuery #7f3a9c2e1b4d  [graphql_var:userId graphql_var:withPosts]  (scope ?; 1 sighting)',
    );
    expect(lines).toContain('graphql MUTATION /graphql DeletePost  [graphql_var:id graphql_var:reason]  (scope ?; 1 sighting)');
  });

  it('runs jsluice when config.json points at it', async () => {
    const home = tmp();
    const sa = cli(home);
    // 引数の形を確かめてから、1 件だけ返す偽の jsluice
    const bin = join(home, 'jsluice');
    writeFileSync(
      bin,
      `#!${process.execPath}
const [mode, , , , file] = process.argv.slice(2);
if (mode !== 'urls' || !require('node:fs').existsSync(file)) process.exit(9);
console.log(JSON.stringify({ url: '/hidden/admin', type: 'stringLiteral', source: '"/settings"' }));
`,
    );
    chmodSync(bin, 0o755);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ tools: { jsluice: { path: './jsluice', version: 'fake' } } }));
    await sa('target', 'add', 'example');
    await sa('load', 'example', endpointsBundle, '--collected-at', 'now');
    const r = await sa('--json', 'extract-endpoints', 'example', '--extractor', 'jsluice');
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ endpoints: 1, extractors: { jsluice: { inputs: 1, found: 1, sightings: 1 } }, unavailable: [] });
    expect((await sa('endpoints', 'example')).stdout).toContain('?       /hidden/admin  (scope ?; 1 sighting)');
  });
});

describe('sa import-har', () => {
  /** 文書・JS（本文つき）・API の呼び出し 1 つずつの HAR */
  function writeHar(dir: string): string {
    const entry = (url: string, resourceType: string, content: Record<string, unknown>, headers: unknown[] = []) => ({
      pageref: 'p',
      startedDateTime: '2026-10-03T08:00:00.000Z',
      _resourceType: resourceType,
      request: { method: 'GET', url, headers: [{ name: 'Authorization', value: 'Bearer do-not-keep' }] },
      response: { status: 200, headers, content },
    });
    const har = {
      log: {
        pages: [{ id: 'p', title: 'https://app.example.com/', startedDateTime: '2026-10-03T08:00:00.000Z' }],
        entries: [
          entry('https://app.example.com/', 'document', { mimeType: 'text/html', text: '<html></html>' }, [
            { name: 'X-Frame-Options', value: 'SAMEORIGIN' },
          ]),
          entry('https://app.example.com/main.c452f02c.js', 'script', { mimeType: 'text/javascript', text: readFileSync(endpointsBundle, 'utf8') }),
          entry('https://app.example.com/api/v2/users/42?include=do-not-keep', 'xhr', { mimeType: 'application/json', text: '{}' }),
        ],
      },
    };
    const path = join(dir, 'capture.har');
    writeFileSync(path, JSON.stringify(har));
    return path;
  }

  it('imports a HAR into the extracted version and marks what it observed', async () => {
    const home = tmp();
    const sa = cli(home);
    await sa('target', 'add', 'example');
    const loaded = await sa('--json', 'load', 'example', endpointsBundle, '--collected-at', '2026-10-03T07:00:00Z');
    const versionId = loaded.json<{ load: { versionId: string } }>().load.versionId;
    await sa('extract-endpoints', 'example');

    const r = await sa('import-har', 'example', writeHar(home), '--version-id', versionId);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`version ${versionId}: 3 entries (0 unreadable, 0 ignored)`);
    expect(r.stdout).toContain('scripts: 1 files, 0 added, 0 without a body in the HAR');
    expect(r.stdout).toContain('api: 1 requests, 1 matched extracted endpoints, 0 only in the HAR');
    expect(r.stdout).toContain('pages: 1 documents with security headers');
    expect((await sa('endpoints', 'example')).stdout).toContain(
      'GET     /api/v2/users/:param  [query:include]  (scope ?; 2 sightings, seen in HAR)',
    );
  });

  it('creates a version from the HAR alone and rejects other files', async () => {
    const home = tmp();
    const sa = cli(home);
    await sa('target', 'add', 'example');
    const r = await sa('--json', 'import-har', 'example', writeHar(home), '--label', 'har-only');
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ har: { createdVersion: true, scripts: { added: 1 }, api: { harOnly: 1 } }, unpack: { files: 1 } });
    const bad = await sa('import-har', 'example', endpointsBundle);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('not a HAR file');
  });
});

describe('sa missing-chunks', () => {
  it('lists what the loaded runtime refers to and records chunks a human could not fetch', async () => {
    const home = tmp();
    const sa = cli(home);
    await sa('target', 'add', 'example', '--allow', 'cdn.example.com');
    const out = new URL('../../core/test/fixtures/webpack5-chunks/output/', import.meta.url).pathname;
    writeFileSync(
      join(home, 'manifest.json'),
      JSON.stringify([{ path: join(out, 'main.f21b19c3.js'), sourceUrls: ['https://cdn.example.com/assets/main.f21b19c3.js'] }]),
    );
    await sa('load', 'example', '--manifest', 'manifest.json', '--collected-at', 'now');

    const r = await sa('missing-chunks', 'example', '--unavailable', '884');
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^version \w+: 6 references, 5 missing, 1 unavailable, 0 fetched \(run \w+\)$/);
    expect(lines).toContain('unavailable chunk         884  https://cdn.example.com/assets/admin.3be16cd6.chunk.js  (in scope)');
    expect(lines).toContain('missing     import        https://widgets.thirdparty.example/w.js  (OUT OF SCOPE)');
    // 印は掛け直しても残る
    const again = await sa('--json', 'missing-chunks', 'example');
    expect(again.json<{ chunks: { chunkKey: string; status: string }[] }>().chunks.find((c) => c.chunkKey === '884')).toMatchObject({
      status: 'unavailable',
    });
    expect((await sa('missing-chunks', 'example', '--unavailable', 'nope')).code).toBe(3);
  });
});

describe('sa backup', () => {
  it('writes and verifies a snapshot, and never overwrites', async () => {
    const home = tmp();
    const sa = cli(home);
    await sa('target', 'add', 'example');
    const r = await sa('--json', 'backup', 'snapshot.db');
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ path: join(home, 'snapshot.db'), schemaVersion: SCHEMA_VERSION, blobDir: join(home, 'blobs') });
    expect(existsSync(join(home, 'snapshot.db'))).toBe(true);
    expect((await sa('backup', 'snapshot.db')).code).toBe(2);
  });
});
