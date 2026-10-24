#!/usr/bin/env node
/**
 * sa-mcp: stdio の MCP サーバ。設定は sa と同じ（SA_HOME / SA_CONFIG / SA_TOOLS）。caller は mcp。
 * 標準出力は MCP の通信に使うので、ログは標準エラーに出す。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeContext, openContext, resolveConfig } from '@sa/core';
import { createMcpServer } from './index';

const { config } = resolveConfig({ env: process.env });
const ctx = openContext({
  config,
  caller: 'mcp',
  onMigrated: (r) => process.stderr.write(`migrated the database schema ${r.from} -> ${r.to}\n`),
});
const server = createMcpServer(ctx);
const close = async () => {
  await server.close();
  closeContext(ctx);
};
process.on('SIGINT', () => void close().then(() => process.exit(0)));
process.on('SIGTERM', () => void close().then(() => process.exit(0)));
const transport = new StdioServerTransport();
transport.onclose = () => closeContext(ctx);
await server.connect(transport);
