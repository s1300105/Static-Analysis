/**
 * artifact_file（各層のファイル）のリポジトリ関数（design.md §6.1・§6.6）。
 * path はツールが生成する作業パス（policy/paths）、orig_name は表示専用（パスに使わない。原則8）。
 */
import type { ArtifactKind, Bundler, Layer, MapCheck, Ownership, ParseStatus } from '@sa/types';
import { newId } from '../../ids';
import { type HasDb, dbCall } from '../connection';

export interface ArtifactFile {
  id: string;
  versionId: string;
  layer: Layer;
  kind: ArtifactKind | null;
  path: string;
  origName: string | null;
  contentHash: string;
  parentFileId: string | null;
  rawOffset: number | null;
  positionMapHash: string | null;
  sourceUrls: string[] | null;
  loadedByOrigins: string[] | null;
  ownership: Ownership | null;
  chunkKey: string | null;
  bundler: Bundler | null;
  parseStatus: ParseStatus;
  mapCheck: MapCheck | null;
}

export interface NewArtifactFile {
  /** path に ID を埋めるため、呼び出し側が先に newId() で決めてよい */
  id?: string;
  versionId: string;
  layer: Layer;
  kind?: ArtifactKind;
  path: string;
  origName?: string;
  contentHash: string;
  parentFileId?: string;
  rawOffset?: number;
  positionMapHash?: string;
  sourceUrls?: string[];
  loadedByOrigins?: string[];
  ownership?: Ownership;
  chunkKey?: string;
  bundler?: Bundler;
}

/** 後から書き換える列（取り込み後の推定・unpack の結果・sourcemap の検証） */
export interface ArtifactFilePatch {
  sourceUrls?: string[];
  loadedByOrigins?: string[];
  ownership?: Ownership;
  chunkKey?: string;
  bundler?: Bundler;
  parseStatus?: ParseStatus;
  mapCheck?: MapCheck;
}

interface ArtifactFileDbRow {
  id: string;
  version_id: string;
  layer: string;
  kind: string | null;
  path: string;
  orig_name: string | null;
  content_hash: string;
  parent_file_id: string | null;
  raw_offset: number | null;
  position_map_hash: string | null;
  source_urls: string | null;
  loaded_by_origins: string | null;
  ownership: string | null;
  chunk_key: string | null;
  bundler: string | null;
  parse_status: string;
  map_check: string | null;
}

export function insertArtifactFile(ctx: HasDb, f: NewArtifactFile): string {
  const id = f.id ?? newId();
  dbCall(() =>
    ctx.db
      .prepare(
        `INSERT INTO artifact_file
           (id, version_id, layer, kind, path, orig_name, content_hash, parent_file_id, raw_offset, position_map_hash,
            source_urls, loaded_by_origins, ownership, chunk_key, bundler)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        f.versionId,
        f.layer,
        f.kind ?? null,
        f.path,
        f.origName ?? null,
        f.contentHash,
        f.parentFileId ?? null,
        f.rawOffset ?? null,
        f.positionMapHash ?? null,
        jsonOrNull(f.sourceUrls),
        jsonOrNull(f.loadedByOrigins),
        f.ownership ?? null,
        f.chunkKey ?? null,
        f.bundler ?? null,
      ),
  );
  return id;
}

export function getArtifactFile(ctx: HasDb, id: string): ArtifactFile | undefined {
  const row = dbCall(() => ctx.db.prepare('SELECT * FROM artifact_file WHERE id = ?').get(id) as ArtifactFileDbRow | undefined);
  return row && toArtifactFile(row);
}

/** 版のファイルを ID 順（＝作成順）に返す */
export function listArtifactFiles(
  ctx: HasDb,
  q: { versionId: string; layer?: Layer; kind?: ArtifactKind; parentFileId?: string },
): ArtifactFile[] {
  const where = ['version_id = ?'];
  const params: unknown[] = [q.versionId];
  if (q.layer !== undefined) {
    where.push('layer = ?');
    params.push(q.layer);
  }
  if (q.kind !== undefined) {
    where.push('kind = ?');
    params.push(q.kind);
  }
  if (q.parentFileId !== undefined) {
    where.push('parent_file_id = ?');
    params.push(q.parentFileId);
  }
  const rows = dbCall(
    () => ctx.db.prepare(`SELECT * FROM artifact_file WHERE ${where.join(' AND ')} ORDER BY id`).all(...params) as ArtifactFileDbRow[],
  );
  return rows.map(toArtifactFile);
}

/** 版の中で同じ層・同じ中身のファイル（取り込みの重複排除に使う） */
export function findArtifactFileByHash(
  ctx: HasDb,
  q: { versionId: string; layer: Layer; contentHash: string },
): ArtifactFile | undefined {
  const row = dbCall(
    () =>
      ctx.db
        .prepare('SELECT * FROM artifact_file WHERE version_id = ? AND layer = ? AND content_hash = ? ORDER BY id LIMIT 1')
        .get(q.versionId, q.layer, q.contentHash) as ArtifactFileDbRow | undefined,
  );
  return row && toArtifactFile(row);
}

const PATCH_COLUMNS: Record<keyof ArtifactFilePatch, { column: string; json: boolean }> = {
  sourceUrls: { column: 'source_urls', json: true },
  loadedByOrigins: { column: 'loaded_by_origins', json: true },
  ownership: { column: 'ownership', json: false },
  chunkKey: { column: 'chunk_key', json: false },
  bundler: { column: 'bundler', json: false },
  parseStatus: { column: 'parse_status', json: false },
  mapCheck: { column: 'map_check', json: true },
};

/** patch に含まれる列だけを書き換える（列名は固定の表から選ぶ。値はプレースホルダ） */
export function updateArtifactFile(ctx: HasDb, id: string, patch: ArtifactFilePatch): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const key of Object.keys(PATCH_COLUMNS) as (keyof ArtifactFilePatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    const { column, json } = PATCH_COLUMNS[key];
    sets.push(`${column} = ?`);
    params.push(json ? JSON.stringify(value) : value);
  }
  if (sets.length === 0) return;
  dbCall(() => ctx.db.prepare(`UPDATE artifact_file SET ${sets.join(', ')} WHERE id = ?`).run(...params, id));
}

function toArtifactFile(row: ArtifactFileDbRow): ArtifactFile {
  return {
    id: row.id,
    versionId: row.version_id,
    layer: row.layer as Layer,
    kind: row.kind as ArtifactKind | null,
    path: row.path,
    origName: row.orig_name,
    contentHash: row.content_hash,
    parentFileId: row.parent_file_id,
    rawOffset: row.raw_offset,
    positionMapHash: row.position_map_hash,
    sourceUrls: parseJson<string[]>(row.source_urls),
    loadedByOrigins: parseJson<string[]>(row.loaded_by_origins),
    ownership: row.ownership as Ownership | null,
    chunkKey: row.chunk_key,
    bundler: row.bundler as Bundler | null,
    parseStatus: row.parse_status as ParseStatus,
    mapCheck: parseJson<MapCheck>(row.map_check),
  };
}

function jsonOrNull(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

function parseJson<T>(s: string | null): T | null {
  return s === null ? null : (JSON.parse(s) as T);
}
