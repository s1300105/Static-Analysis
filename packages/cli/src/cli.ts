#!/usr/bin/env node
import { run } from './index';

process.exitCode = await run(process.argv, {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  cwd: process.cwd(),
});
