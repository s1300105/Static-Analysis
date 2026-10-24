/**
 * ビルド後の sa-mcp（dist/server.js）を stdio で起動し、ツールの一覧と extract_endpoints を一通り呼ぶ。
 * 対象と版はビルド後の sa（packages/cli/dist）で用意する。pnpm build の後に CI で実行する。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = new URL('../dist/server.js', import.meta.url).pathname;
const cli = new URL('../../cli/dist/cli.js', import.meta.url).pathname;
const bundle = new URL('../../core/test/fixtures/webpack5-endpoints/output/main.c452f02c.js', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'sa-mcp-smoke-'));
const env = { PATH: process.env.PATH ?? '', SA_HOME: home };

try {
  const sa = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  sa('target', 'add', 'smoke');
  sa('load', 'smoke', bundle, '--collected-at', 'now');

  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: 'ignore' }));
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    if (tools.join() !== 'diff_versions,extract_endpoints,find_missing_chunks') throw new Error(`unexpected tools: ${tools}`);
    const r = await client.callTool({ name: 'extract_endpoints', arguments: { target: 'smoke', extractors: ['ast_url'] } });
    const body = JSON.parse(r.content[0].text);
    if (r.isError || body.endpointsTotal !== 10) throw new Error(`unexpected extract_endpoints result: ${r.content[0].text}`);
    console.log(`mcp smoke ok: ${tools.length} tools, ${body.endpointsTotal} endpoints`);
  } finally {
    await client.close();
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
