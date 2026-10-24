/**
 * worker で動かすジョブの登録（docs/architecture.md §3.4）。
 *
 * worker のモジュール（*.worker.ts）は、ビルド後は dist/workers/<name>.js（tsup.config.ts のエントリ）、
 * ソースのまま（テスト）は Node の型除去でそのまま読む（Node 22.18 以降の既定）。
 * どちらでも読めるように、worker のモジュールは次を守る:
 * - 相対 import をしない（パッケージの import と `import type` だけ）。型除去では拡張子無しの相対 import を解決できない
 * - 消せる型構文だけを使う（enum・namespace・引数プロパティを使わない。tsconfig の erasableSyntaxOnly で検査）
 * - スキップ理由を付けて失敗させるときは skipReason プロパティを持つ Error を投げる（JobSkipError と同じ形）
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineWorker } from '../runner';
import type { SourcemapInput, SourcemapOutput } from './sourcemap.worker';
import type { UnpackInput, UnpackOutput } from './unpack.worker';

function workerUrl(name: string): URL {
  // ビルド後: このコードは dist/index.js（または同じ階層のチャンク）に入るので、隣の workers/<name>.js
  const built = new URL(`./workers/${name}.js`, import.meta.url);
  if (existsSync(fileURLToPath(built))) return built;
  // ソース: src/jobs/workers/<name>.worker.ts
  return new URL(`./${name}.worker.ts`, import.meta.url);
}

export const unpackWorker = defineWorker<UnpackInput, UnpackOutput>('unpack', workerUrl('unpack'));
export const sourcemapWorker = defineWorker<SourcemapInput, SourcemapOutput>('sourcemap', workerUrl('sourcemap'));

/** analysis_run.tool_version に残す Babel パーサの版 */
export const BABEL_PARSER_VERSION: string = (
  createRequire(import.meta.url)('@babel/parser/package.json') as { version: string }
).version;
