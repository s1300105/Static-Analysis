/**
 * diff_versions の初期版（design.md §7.3、計画書 M2）: 2 つの版の api_endpoint の差分。function_lineage には依存しない。
 * - 比べるのは静的な抽出器の sighting（HAR は人間が触った範囲の観測なので差分に入れない）
 * - 新規 / 削除: 片方の版にだけ sighting がある endpoint。既存の endpoint の新規パラメータも出す
 * - 未収集による差（別枠）: 差分の sighting がすべて「もう一方の版では参照されているのに取得していないチャンク」にあるもの。
 *   そのチャンクを取れば消えるかもしれない差なので、新規・削除と分ける。どの版でも参照されていないチャンクは新しいチャンクとして新規に数える。
 *   チャンクの参照は find_missing_chunks で両方の版について作り直してから見る
 * - 基準の版は、指定が無ければ版の base_version_id、それも無ければ同じ対象の直前の版（取得日時の順）
 */
import type { EndpointParam } from '@sa/types';
import { findMissingChunks } from '../../artifact/chunks';
import type { SaContext } from '../../context';
import { type ArtifactVersion, getArtifactVersion, listArtifactVersions } from '../../db/repo/artifactVersion';
import { type EndpointSummary, listEndpointSummaries, listStaticSightings } from '../../db/repo/endpoint';
import { SaError } from '../../errors';

export interface EndpointChange {
  endpoint: EndpointSummary;
  /** その版でのパラメータ */
  params: EndpointParam[];
  /** sighting のあるチャンク（push のチャンク ID。チャンクを持たないファイルは 'entry'） */
  chunks: string[];
}

export interface DiffResult {
  versionId: string;
  baseVersionId: string;
  added: EndpointChange[];
  removed: EndpointChange[];
  /** 両方の版にある endpoint の、新しい版にだけあるパラメータ */
  newParams: { endpoint: EndpointSummary; params: EndpointParam[] }[];
  /** もう一方の版で取得していないチャンクにだけある差 */
  uncollected: { added: EndpointChange[]; removed: EndpointChange[] };
}

interface Seen {
  params: EndpointParam[];
  chunks: Set<string>;
}

const ENTRY = 'entry';

export async function diffVersions(ctx: SaContext, opts: { versionId: string; baseVersionId?: string }): Promise<DiffResult> {
  const version = getArtifactVersion(ctx, opts.versionId);
  if (!version) throw new SaError('NOT_FOUND', `artifact_version not found: ${opts.versionId}`);
  const base = baseOf(ctx, version, opts.baseVersionId);

  // 参照されているのに取得していないチャンク（チャンク ID）
  const notFetched = async (versionId: string) =>
    new Set(
      (await findMissingChunks(ctx, { versionId })).chunks
        .filter((c) => (c.kind === 'chunk' || c.kind === 'startup_chunk') && c.status !== 'fetched')
        .map((c) => c.chunkKey),
    );
  const missingInBase = await notFetched(base.id);
  const missingInVersion = await notFetched(version.id);

  const before = seenByEndpoint(ctx, base.id);
  const after = seenByEndpoint(ctx, version.id);
  const summaries = new Map(listEndpointSummaries(ctx, version.targetId).map((e) => [e.id, e]));
  const change = (id: string, s: Seen): EndpointChange => ({ endpoint: summaries.get(id)!, params: s.params, chunks: [...s.chunks].sort() });
  /** すべての sighting が、もう一方の版で取得していないチャンクにあるか */
  const onlyUncollected = (s: Seen, missing: Set<string>) => [...s.chunks].every((c) => c !== ENTRY && missing.has(c));

  const out: DiffResult = { versionId: version.id, baseVersionId: base.id, added: [], removed: [], newParams: [], uncollected: { added: [], removed: [] } };
  for (const [id, s] of after) {
    const prev = before.get(id);
    if (!prev) {
      (onlyUncollected(s, missingInBase) ? out.uncollected.added : out.added).push(change(id, s));
      continue;
    }
    const fresh = s.params.filter((p) => !prev.params.some((q) => q.name === p.name && q.in === p.in));
    if (fresh.length > 0) out.newParams.push({ endpoint: summaries.get(id)!, params: fresh });
  }
  for (const [id, s] of before) {
    if (after.has(id)) continue;
    (onlyUncollected(s, missingInVersion) ? out.uncollected.removed : out.removed).push(change(id, s));
  }
  const byPath = (a: { endpoint: EndpointSummary }, b: { endpoint: EndpointSummary }) =>
    a.endpoint.pathNorm.localeCompare(b.endpoint.pathNorm) || a.endpoint.method.localeCompare(b.endpoint.method) || a.endpoint.operation.localeCompare(b.endpoint.operation);
  for (const list of [out.added, out.removed, out.newParams, out.uncollected.added, out.uncollected.removed]) list.sort(byPath);
  return out;
}

function baseOf(ctx: SaContext, version: ArtifactVersion, baseVersionId: string | undefined): ArtifactVersion {
  const id = baseVersionId ?? version.baseVersionId;
  if (id !== undefined && id !== null) {
    const base = getArtifactVersion(ctx, id);
    if (!base || base.targetId !== version.targetId) throw new SaError('NOT_FOUND', `base artifact_version not found in the target: ${id}`);
    if (base.id === version.id) throw new SaError('INVALID_INPUT', 'a version cannot be compared with itself');
    return base;
  }
  const versions = listArtifactVersions(ctx, version.targetId);
  const i = versions.findIndex((v) => v.id === version.id);
  if (i <= 0) throw new SaError('INVALID_INPUT', 'no earlier version to compare with (give baseVersionId)');
  return versions[i - 1]!;
}

/** 版の静的な sighting を endpoint ごとにまとめる（パラメータの和集合と、sighting のあるチャンク） */
function seenByEndpoint(ctx: SaContext, versionId: string): Map<string, Seen> {
  const out = new Map<string, Seen>();
  for (const s of listStaticSightings(ctx, versionId)) {
    const seen = out.get(s.endpointId) ?? { params: [], chunks: new Set<string>() };
    out.set(s.endpointId, seen);
    for (const p of s.params) if (!seen.params.some((q) => q.name === p.name && q.in === p.in)) seen.params.push(p);
    const ids = (s.chunkKey ?? '').split(',').filter((c) => c !== '');
    if (ids.length === 0) seen.chunks.add(ENTRY);
    for (const c of ids) seen.chunks.add(c);
  }
  return out;
}
