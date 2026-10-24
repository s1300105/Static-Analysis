/**
 * artifact_version（成果物の版）のリポジトリ関数（design.md §6.1）。
 */
import { newId, nowIso } from '../../ids';
import { type HasDb, dbCall } from '../connection';

export interface ArtifactVersion {
  id: string;
  targetId: string;
  label: string | null;
  /** 比較の基準。初版だけ null */
  baseVersionId: string | null;
  /** 人間が取得した日時 */
  collectedAt: string;
  /** ログイン有無・ロール・言語・機能フラグ */
  collectionNotes: Record<string, unknown> | null;
  ingestedAt: string | null;
}

export interface NewArtifactVersion {
  targetId: string;
  label?: string;
  baseVersionId?: string;
  collectedAt: string;
  collectionNotes?: Record<string, unknown>;
}

interface ArtifactVersionDbRow {
  id: string;
  target_id: string;
  label: string | null;
  base_version_id: string | null;
  collected_at: string;
  collection_notes: string | null;
  ingested_at: string | null;
}

/** 版を作る。ingested_at は今 */
export function insertArtifactVersion(ctx: HasDb, v: NewArtifactVersion): string {
  const id = newId();
  dbCall(() =>
    ctx.db
      .prepare(
        `INSERT INTO artifact_version (id, target_id, label, base_version_id, collected_at, collection_notes, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        v.targetId,
        v.label ?? null,
        v.baseVersionId ?? null,
        v.collectedAt,
        v.collectionNotes === undefined ? null : JSON.stringify(v.collectionNotes),
        nowIso(),
      ),
  );
  return id;
}

export function getArtifactVersion(ctx: HasDb, id: string): ArtifactVersion | undefined {
  const row = dbCall(
    () => ctx.db.prepare('SELECT * FROM artifact_version WHERE id = ?').get(id) as ArtifactVersionDbRow | undefined,
  );
  return row && toArtifactVersion(row);
}

/** 対象の版を取得日時の順に返す */
export function listArtifactVersions(ctx: HasDb, targetId: string): ArtifactVersion[] {
  const rows = dbCall(
    () =>
      ctx.db
        .prepare('SELECT * FROM artifact_version WHERE target_id = ? ORDER BY collected_at, id')
        .all(targetId) as ArtifactVersionDbRow[],
  );
  return rows.map(toArtifactVersion);
}

function toArtifactVersion(row: ArtifactVersionDbRow): ArtifactVersion {
  return {
    id: row.id,
    targetId: row.target_id,
    label: row.label,
    baseVersionId: row.base_version_id,
    collectedAt: row.collected_at,
    collectionNotes: row.collection_notes === null ? null : (JSON.parse(row.collection_notes) as Record<string, unknown>),
    ingestedAt: row.ingested_at,
  };
}
