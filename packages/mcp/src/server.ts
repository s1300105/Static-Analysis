#!/usr/bin/env node
import { createMcpServer } from './index';

try {
  createMcpServer();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
