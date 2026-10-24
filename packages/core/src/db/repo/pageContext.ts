/**
 * page_context（HAR から取り込んだ文書のセキュリティヘッダ。design.md §6.2・§2.6）のリポジトリ関数。
 * 参考情報で、候補を落とす理由には使わない（原則5）。同じ版・同じ文書は 1 行にし、新しい観測で上書きする。
 */
import { newId } from '../../ids';
import { type HasDb, dbCall } from '../connection';

/** 残すヘッダ（import_har の許可リスト）。CSP は値にトークンを残さないよう整えたもの */
export interface PageSecurityHeaders {
  'content-security-policy'?: string[];
  'content-security-policy-report-only'?: string[];
  'x-frame-options'?: string;
  'cross-origin-opener-policy'?: string;
  /** <meta http-equiv="Content-Security-Policy"> */
  'meta-content-security-policy'?: string[];
}

export interface PageContext {
  id: string;
  versionId: string;
  /** origin とテンプレート化したパス（クエリは持たない） */
  documentUrl: string;
  headers: PageSecurityHeaders;
  observedAt: string | null;
}

interface PageContextDbRow {
  id: string;
  version_id: string;
  document_url: string;
  headers: string | null;
  observed_at: string | null;
}

/** 同じ版・同じ文書の行があれば、観測が新しいときだけ置き換える。行の ID を返す */
export function upsertPageContext(
  ctx: HasDb,
  p: { versionId: string; documentUrl: string; headers: PageSecurityHeaders; observedAt: string | null },
): string {
  const existing = dbCall(
    () =>
      ctx.db
        .prepare('SELECT * FROM page_context WHERE version_id = ? AND document_url = ? ORDER BY id LIMIT 1')
        .get(p.versionId, p.documentUrl) as PageContextDbRow | undefined,
  );
  if (!existing) {
    const id = newId();
    dbCall(() =>
      ctx.db
        .prepare('INSERT INTO page_context (id, version_id, document_url, headers, observed_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, p.versionId, p.documentUrl, JSON.stringify(p.headers), p.observedAt),
    );
    return id;
  }
  const newer = existing.observed_at === null || (p.observedAt !== null && p.observedAt >= existing.observed_at);
  if (newer) {
    dbCall(() =>
      ctx.db
        .prepare('UPDATE page_context SET headers = ?, observed_at = ? WHERE id = ?')
        .run(JSON.stringify(p.headers), p.observedAt, existing.id),
    );
  }
  return existing.id;
}

export function listPageContexts(ctx: HasDb, versionId: string): PageContext[] {
  const rows = dbCall(
    () => ctx.db.prepare('SELECT * FROM page_context WHERE version_id = ? ORDER BY document_url').all(versionId) as PageContextDbRow[],
  );
  return rows.map((r) => ({
    id: r.id,
    versionId: r.version_id,
    documentUrl: r.document_url,
    headers: r.headers === null ? {} : (JSON.parse(r.headers) as PageSecurityHeaders),
    observedAt: r.observed_at,
  }));
}
