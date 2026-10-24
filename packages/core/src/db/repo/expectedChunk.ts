/**
 * expected_chunk（参照されているのに未取得かもしれないチャンク・sourcemap。design.md §6.1・§7.1 find_missing_chunks）の
 * リポジトリ関数。status の unavailable は人間が付ける（取りに行ったが取れなかった）ので、掛け直しても残す。
 */
import { type HasDb, dbCall } from '../connection';

export const EXPECTED_CHUNK_STATUSES = ['missing', 'fetched', 'unavailable'] as const;
export type ExpectedChunkStatus = (typeof EXPECTED_CHUNK_STATUSES)[number];

export interface ExpectedChunkRow {
  versionId: string;
  chunkKey: string;
  url: string | null;
  referencedFromLocationId: string | null;
  /** null は判定できない（URL が分からないか allowed_domains が空） */
  hostInScope: boolean | null;
  status: ExpectedChunkStatus;
}

interface ExpectedChunkDbRow {
  version_id: string;
  chunk_key: string;
  url: string | null;
  referenced_from_location_id: string | null;
  host_in_scope: number | null;
  status: string;
}

export function listExpectedChunks(ctx: HasDb, versionId: string): ExpectedChunkRow[] {
  const rows = dbCall(
    () => ctx.db.prepare('SELECT * FROM expected_chunk WHERE version_id = ? ORDER BY chunk_key').all(versionId) as ExpectedChunkDbRow[],
  );
  return rows.map((r) => ({
    versionId: r.version_id,
    chunkKey: r.chunk_key,
    url: r.url,
    referencedFromLocationId: r.referenced_from_location_id,
    hostInScope: r.host_in_scope === null ? null : r.host_in_scope === 1,
    status: r.status as ExpectedChunkStatus,
  }));
}

/** 行を作るか置き換える。人間が付けた unavailable は、計算した状態が missing なら残す */
export function upsertExpectedChunk(ctx: HasDb, c: ExpectedChunkRow): void {
  dbCall(() =>
    ctx.db
      .prepare(
        `INSERT INTO expected_chunk (version_id, chunk_key, url, referenced_from_location_id, host_in_scope, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (version_id, chunk_key) DO UPDATE SET
           url = excluded.url,
           referenced_from_location_id = excluded.referenced_from_location_id,
           host_in_scope = excluded.host_in_scope,
           status = CASE WHEN expected_chunk.status = 'unavailable' AND excluded.status = 'missing' THEN 'unavailable'
                         ELSE excluded.status END`,
      )
      .run(
        c.versionId,
        c.chunkKey,
        c.url,
        c.referencedFromLocationId,
        c.hostInScope === null ? null : c.hostInScope ? 1 : 0,
        c.status,
      ),
  );
}

export function deleteExpectedChunk(ctx: HasDb, versionId: string, chunkKey: string): void {
  dbCall(() => ctx.db.prepare('DELETE FROM expected_chunk WHERE version_id = ? AND chunk_key = ?').run(versionId, chunkKey));
}

/** 状態を書き換える。行が無ければ false */
export function setExpectedChunkStatus(ctx: HasDb, versionId: string, chunkKey: string, status: ExpectedChunkStatus): boolean {
  return (
    dbCall(
      () => ctx.db.prepare('UPDATE expected_chunk SET status = ? WHERE version_id = ? AND chunk_key = ?').run(status, versionId, chunkKey).changes,
    ) > 0
  );
}
