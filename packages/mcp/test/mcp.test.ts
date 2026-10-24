import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type SaContext, closeContext, configForHome, createTarget, loadArtifact, openContext, unpackBundle } from '@sa/core';
import { MCP_TOOLS, createMcpServer } from '@sa/mcp';

const fixtures = new URL('../../core/test/fixtures/', import.meta.url).pathname;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** 人間（cli）が対象と版を用意し、同じ DB を caller=mcp で開いたサーバにクライアントをつなぐ */
async function setup(prepare: (cli: SaContext) => Promise<void>): Promise<{ client: Client; mcp: SaContext }> {
  const home = mkdtempSync(join(tmpdir(), 'sa-mcp-test-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const config = configForHome(home);
  const cli = openContext({ config, caller: 'cli' });
  try {
    await prepare(cli);
  } finally {
    closeContext(cli);
  }
  const mcp = openContext({ config, caller: 'mcp' });
  cleanups.push(() => closeContext(mcp));
  const server = createMcpServer(mcp);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  cleanups.push(() => client.close());
  return { client, mcp };
}

async function call<T>(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: T; text: string }> {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]!.text;
  return { isError: r.isError === true, text, body: (r.isError ? undefined : JSON.parse(text)) as T };
}

function createTargetIdOf(cli: SaContext): string {
  return cli.db.prepare('SELECT id FROM target ORDER BY id LIMIT 1').pluck().get() as string;
}

async function load(cli: SaContext, name: string, at: string, files: string[]): Promise<void> {
  const { id: targetId } = createTarget(cli, { name });
  const { versionId } = loadArtifact(cli, { targetId, collectedAt: at, files: files.map((path) => ({ path })) });
  await unpackBundle(cli, { versionId });
}

describe('sa-mcp', () => {
  it('exposes only the E1 tools of step 2, and nothing that writes human judgements', async () => {
    const { client } = await setup(async () => {});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOLS].sort());
    for (const forbidden of ['triage_endpoint', 'set_scope', 'load_artifact', 'import_har', 'export_endpoints', 'confirm_fact']) {
      expect(tools.some((t) => t.name === forbidden)).toBe(false);
    }
    expect(tools.find((t) => t.name === 'extract_endpoints')!.inputSchema).toMatchObject({ required: ['target'] });
  });

  it('extracts endpoints and returns them in the deterministic order', async () => {
    const { client } = await setup((cli) => load(cli, 'example', '2026-10-01T00:00:00Z', [join(fixtures, 'webpack5-endpoints/output/main.c452f02c.js')]));
    const r = await call<{ endpoints: { method: string; path: string; rules: string[]; needsTriage: boolean }[]; endpointsTotal: number; extractors: { ast_url: { found: number } } }>(
      client,
      'extract_endpoints',
      { target: 'example', extractors: ['ast_url'] },
    );
    expect(r.isError).toBe(false);
    expect(r.body.extractors.ast_url.found).toBe(10);
    expect(r.body.endpointsTotal).toBe(10);
    expect(r.body.endpoints[0]).toMatchObject({ method: 'DELETE', path: '/api/v2/docs/:param', rules: ['not_in_har', 'state_changing', 'id_param'], needsTriage: true });
  });

  it('lists missing chunks and diffs versions', async () => {
    const chunks = join(fixtures, 'webpack5-chunks/output');
    const { client } = await setup(async (cli) => {
      await load(cli, 'example', '2026-09-01T00:00:00Z', [join(chunks, 'main.f21b19c3.js'), join(chunks, 'settings.f61ce08e.chunk.js')]);
    });
    const missing = await call<{ missing: number; chunks: { chunkKey: string; status: string }[] }>(client, 'find_missing_chunks', { target: 'example' });
    expect(missing.body.chunks.find((c) => c.chunkKey === '472')).toMatchObject({ status: 'fetched' });
    // admin・867 のチャンク、第三者の import、main と settings の sourcemap、LICENSE
    expect(missing.body.missing).toBe(6);

    const diff = await call(client, 'diff_versions', { target: 'example' });
    expect(diff).toMatchObject({ isError: true, text: expect.stringMatching(/^INVALID_INPUT: no earlier version/) });
  });

  it('diffs two versions, keeping differences from unfetched chunks apart', async () => {
    const chunks = join(fixtures, 'webpack5-chunks/output');
    const { client, mcp } = await setup(async (cli) => {
      await load(cli, 'example', '2026-09-01T00:00:00Z', [join(chunks, 'main.f21b19c3.js')]);
      const targetId = createTargetIdOf(cli);
      const { versionId } = loadArtifact(cli, {
        targetId,
        collectedAt: '2026-10-01T00:00:00Z',
        files: ['main.f21b19c3.js', 'admin.3be16cd6.chunk.js'].map((n) => ({ path: join(chunks, n) })),
      });
      await unpackBundle(cli, { versionId });
    });
    const versions = mcp.db.prepare('SELECT id FROM artifact_version ORDER BY collected_at').pluck().all() as string[];
    for (const versionId of versions) await call(client, 'extract_endpoints', { target: 'example', versionId });
    const d = await call<{ added: unknown[]; uncollected: { added: { method: string; path: string; chunks: string[] }[] } }>(client, 'diff_versions', {
      target: 'example',
    });
    expect(d.isError).toBe(false);
    expect(d.body.added).toEqual([]);
    expect(d.body.uncollected.added).toMatchObject([{ method: 'GET', path: '/api/admin/users', chunks: ['884'] }]);
  });

  it('reports sa-core errors as tool errors', async () => {
    const { client } = await setup(async () => {});
    const r = await call(client, 'find_missing_chunks', { target: 'nope' });
    expect(r).toMatchObject({ isError: true, text: 'NOT_FOUND: target not found: nope' });
  });

  it('refuses a context that is not opened as mcp', () => {
    const home = mkdtempSync(join(tmpdir(), 'sa-mcp-test-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const cli = openContext({ config: configForHome(home), caller: 'cli' });
    cleanups.push(() => closeContext(cli));
    expect(() => createMcpServer(cli)).toThrow(/caller=mcp/);
  });
});
