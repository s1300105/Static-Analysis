/**
 * sa missing-chunks: 版の JS が参照しているのにまだ取り込んでいないチャンク・sourcemap・LICENSE を一覧する
 * （design.md §7.1 find_missing_chunks。通信しない）。人間が取りに行き、取れたものは sa load で足す。
 * 取りに行って取れなかったものは --unavailable で印を付ける（掛け直しても残る）。
 */
import { type ExpectedChunk, type FindMissingChunksResult, findMissingChunks, findTarget, findVersion, markChunkUnavailable } from '@sa/core';
import type { Command } from 'commander';
import { type CliIo, collect, emit, withContext } from '../io';

interface MissingChunksOptions {
  versionId?: string;
  unavailable?: string[];
  all?: boolean;
}

export function registerMissingChunksCommand(program: Command, io: CliIo): void {
  program
    .command('missing-chunks')
    .description('参照されているのに未取得のチャンク・sourcemap・LICENSE を一覧する（通信しない）')
    .argument('<target>', '対象の ID か名前')
    .option('--version-id <id>', '調べる版（既定: 取得日時が最も新しい版）')
    .option('--unavailable <key>', '取りに行って取れなかったものに印を付ける（チャンク ID か URL。繰り返し指定）', collect)
    .option('--all', '取得済みのものも出す')
    .action(async (targetRef: string, opts: MissingChunksOptions, cmd: Command) => {
      const r = await withContext(cmd, io, async (ctx) => {
        const version = findVersion(ctx, findTarget(ctx, targetRef).id, opts.versionId);
        const result = await findMissingChunks(ctx, { versionId: version.id });
        for (const key of opts.unavailable ?? []) markChunkUnavailable(ctx, version.id, key);
        const marked = new Set(opts.unavailable ?? []);
        const chunks = result.chunks.map((c) => (marked.has(c.chunkKey) && c.status === 'missing' ? { ...c, status: 'unavailable' as const } : c));
        return { versionId: version.id, ...result, chunks, missing: chunks.filter((c) => c.status === 'missing').length };
      });
      emit(cmd, io, r, () => summary(r, opts.all === true));
    });
}

function summary(r: FindMissingChunksResult & { versionId: string }, all: boolean): string[] {
  const count = (s: ExpectedChunk['status']) => r.chunks.filter((c) => c.status === s).length;
  const lines = [
    `version ${r.versionId}: ${r.chunks.length} references, ${count('missing')} missing, ${count('unavailable')} unavailable, ` +
      `${count('fetched')} fetched (run ${r.runId})`,
  ];
  for (const c of r.chunks) {
    if (!all && c.status === 'fetched') continue;
    const where = c.url === null ? '(URL unknown)' : c.url === c.chunkKey ? c.url : `${c.chunkKey}  ${c.url}`;
    const scope = c.hostInScope === null ? 'scope ?' : c.hostInScope ? 'in scope' : 'OUT OF SCOPE';
    lines.push(`${c.status.padEnd(11)} ${c.kind.padEnd(13)} ${c.url === null ? `${c.chunkKey}  ${where}` : where}  (${scope})`);
  }
  return lines;
}
