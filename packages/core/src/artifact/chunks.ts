/**
 * find_missing_chunks（design.md §7.1、計画書 M2）: 版の JS が参照するチャンク・sourcemap・LICENSE のうち、まだ取り込んでいない
 * ものを expected_chunk に記録する（通信しない。取りに行くのは人間）。
 * - 参照の収集は worker（jobs/workers/chunks.worker.ts）。webpack 5 のランタイムのファイル名の組み立て方と公開パス、
 *   X.e(id)・X.O の起動時の依存、動的 import、new URL(..., import.meta.url)、sourceMappingURL、LICENSE のコメント
 * - チャンク ID のファイル名は、版のどこかのランタイムの組み立て方で作る（チャンクを読むコードは別のファイルにあることがある）。
 *   起動時の依存は HTML が読むので、組み立て方の表に ID があるときだけファイル名を作る
 * - URL: 公開パスが絶対ならそれ、"/" で始まれば文書（loaded_by_origins）かスクリプトのオリジンから、式（auto）ならスクリプト
 *   自身の場所（source_urls）から解く。その他の参照はスクリプトの URL から解く。解けなければ URL は null で、書かれた値をキーにする
 * - 取得済みの判定: チャンク ID は raw の chunk_key、それ以外は配信 URL（クエリを除く）かファイル名（orig_name）で照合する
 * - host_in_scope は target.scope で判定する（policy/scope.ts）。人間が付けた unavailable は残す
 */
import { basename } from 'node:path';
import type { SaContext } from '../context';
import { withTxn } from '../db/connection';
import { finishAnalysisRun, startAnalysisRun } from '../db/repo/analysisRun';
import { type ArtifactFile, listArtifactFiles } from '../db/repo/artifactFile';
import { getArtifactVersion } from '../db/repo/artifactVersion';
import { ensureCodeLocation } from '../db/repo/codeLocation';
import {
  type ExpectedChunkStatus,
  deleteExpectedChunk,
  listExpectedChunks,
  setExpectedChunkStatus,
  upsertExpectedChunk,
} from '../db/repo/expectedChunk';
import { getTarget } from '../db/repo/target';
import { SaError } from '../errors';
import { SkipLog } from '../jobs/skips';
import { BABEL_PARSER_VERSION, chunksWorker } from '../jobs/workers';
import type { ChunkTemplate, TemplatePart } from '../jobs/workers/chunks.worker';
import { originInScope } from '../policy/scope';
import { CORE_VERSION } from '../version';
import { displayPositions } from './position';

export type ExpectedChunkKind = 'chunk' | 'startup_chunk' | 'import' | 'url' | 'sourcemap' | 'license';

export interface ExpectedChunk {
  /** webpack のチャンク ID。それ以外は URL（解けなければ書かれた値） */
  chunkKey: string;
  url: string | null;
  /** 何から分かったか（DB には持たない） */
  kind: ExpectedChunkKind;
  hostInScope: boolean | null;
  status: ExpectedChunkStatus;
  /** 最初に見つけた参照の位置 */
  referencedFrom: { rawFileId: string; startByte: number; endByte: number };
}

export interface FindMissingChunksResult {
  runId: string;
  chunks: ExpectedChunk[];
  missing: number;
  /** 読めなかった raw の数 */
  skipped: number;
}

interface Found {
  key: string;
  url: string | null;
  kind: ExpectedChunkKind;
  chunkId?: string;
  raw: ArtifactFile;
  startByte: number;
  endByte: number;
}

export async function findMissingChunks(ctx: SaContext, opts: { versionId: string }): Promise<FindMissingChunksResult> {
  const version = getArtifactVersion(ctx, opts.versionId);
  if (!version) throw new SaError('NOT_FOUND', `artifact_version not found: ${opts.versionId}`);
  const scope = getTarget(ctx, version.targetId)?.scope ?? null;
  const raws = listArtifactFiles(ctx, { versionId: version.id, layer: 'raw' });
  const scripts = raws.filter((f) => f.kind === 'js');
  const runId = startAnalysisRun(ctx, {
    versionId: version.id,
    kind: 'engine',
    tool: 'find_missing_chunks',
    toolVersion: `sa-core ${CORE_VERSION}; @babel/parser ${BABEL_PARSER_VERSION}`,
    inputLayer: 'raw',
  });
  const results = await Promise.all(
    scripts.map((raw) => ctx.jobs.runWorker(chunksWorker, { bytes: ctx.store.get(raw.contentHash) }, ctx.config.workerLimits)),
  );

  const skips = new SkipLog();
  const templates: { raw: ArtifactFile; t: ChunkTemplate }[] = [];
  const found: Found[] = [];
  const chunkRefs: { raw: ArtifactFile; id: string; via: 'async' | 'startup'; startByte: number; endByte: number }[] = [];
  scripts.forEach((raw, i) => {
    const r = results[i]!;
    if (!skips.record(r, { fileId: raw.id })) return;
    for (const t of r.value.templates) templates.push({ raw, t });
    for (const c of r.value.chunkIds) chunkRefs.push({ raw, ...c });
    const scriptUrl = raw.sourceUrls?.[0];
    for (const ref of r.value.refs) {
      const url = resolveUrl(ref.value, scriptUrl);
      found.push({ key: url ?? ref.value, url, kind: ref.kind, raw, startByte: ref.startByte, endByte: ref.endByte });
    }
  });

  // チャンク ID: 組み立て方の表の ID と、X.e / X.O で参照される ID
  const ids = new Map<string, { via: 'async' | 'startup'; raw: ArtifactFile; startByte: number; endByte: number }>();
  for (const { raw, t } of templates) {
    for (const part of t.parts) if ('map' in part) for (const id of Object.keys(part.map)) if (!ids.has(id)) ids.set(id, { via: 'async', raw, ...span(t) });
  }
  for (const c of chunkRefs) {
    const prev = ids.get(c.id);
    // X.e で読むなら非同期のチャンク（起動時の依存でもあれば非同期を採る）
    if (!prev || (prev.via === 'startup' && c.via === 'async')) ids.set(c.id, { via: c.via, raw: c.raw, startByte: c.startByte, endByte: c.endByte });
  }
  if (templates.length > 0 || chunkRefs.some((c) => c.via === 'startup')) {
    for (const [id, at] of ids) {
      const url = chunkUrl(id, at.via, templates);
      found.push({ key: id, url, kind: at.via === 'async' ? 'chunk' : 'startup_chunk', chunkId: id, raw: at.raw, startByte: at.startByte, endByte: at.endByte });
    }
  }

  // キーごとに 1 つ（最初の参照の位置、最初に分かった URL）
  const byKey = new Map<string, Found>();
  for (const f of found) {
    const prev = byKey.get(f.key);
    if (!prev) byKey.set(f.key, f);
    else if (prev.url === null && f.url !== null) prev.url = f.url;
  }

  const fetched = fetchedIndex(raws);
  const chunks: ExpectedChunk[] = [];
  const positions = new Map<string, Map<number, { line: number; col: number }>>();
  const positionOf = (f: Found) => {
    let p = positions.get(f.raw.id);
    if (!p) {
      p = displayPositions(
        ctx.store.get(f.raw.contentHash),
        [...byKey.values()].filter((x) => x.raw.id === f.raw.id).map((x) => x.startByte),
      );
      positions.set(f.raw.id, p);
    }
    return p.get(f.startByte)!;
  };
  withTxn(ctx, () => {
    const keep = new Set(byKey.keys());
    for (const row of listExpectedChunks(ctx, version.id)) {
      if (!keep.has(row.chunkKey) && row.status !== 'unavailable') deleteExpectedChunk(ctx, version.id, row.chunkKey);
    }
    for (const f of byKey.values()) {
      const computed: ExpectedChunkStatus = fetched.has(f) ? 'fetched' : 'missing';
      const hostInScope = f.url !== null ? originInScope(new URL(f.url).origin, scope) : null;
      const locationId = ensureCodeLocation(ctx, { rawFileId: f.raw.id, startByte: f.startByte, endByte: f.endByte, ...positionOf(f) });
      upsertExpectedChunk(ctx, { versionId: version.id, chunkKey: f.key, url: f.url, referencedFromLocationId: locationId, hostInScope, status: computed });
    }
    const stored = new Map(listExpectedChunks(ctx, version.id).map((r) => [r.chunkKey, r.status]));
    for (const f of byKey.values()) {
      chunks.push({
        chunkKey: f.key,
        url: f.url,
        kind: f.kind,
        hostInScope: f.url !== null ? originInScope(new URL(f.url).origin, scope) : null,
        status: stored.get(f.key) ?? 'missing',
        referencedFrom: { rawFileId: f.raw.id, startByte: f.startByte, endByte: f.endByte },
      });
    }
  });

  const { filesSkipped, skippedDetail } = skips.summary();
  finishAnalysisRun(ctx, runId, { filesTotal: scripts.length, filesAnalyzed: scripts.length - filesSkipped, filesSkipped, skippedDetail });
  chunks.sort((a, b) => order(a) - order(b) || a.chunkKey.localeCompare(b.chunkKey));
  return { runId, chunks, missing: chunks.filter((c) => c.status === 'missing').length, skipped: filesSkipped };
}

/** 人間が取りに行って取れなかったチャンクに印を付ける（取れたら sa load で取り込めば fetched になる） */
export function markChunkUnavailable(ctx: SaContext, versionId: string, chunkKey: string): void {
  if (!setExpectedChunkStatus(ctx, versionId, chunkKey, 'unavailable')) {
    throw new SaError('NOT_FOUND', `expected chunk not found in the version: ${chunkKey} (run find_missing_chunks first)`);
  }
}

const KIND_ORDER: ExpectedChunkKind[] = ['chunk', 'startup_chunk', 'import', 'url', 'sourcemap', 'license'];
function order(c: ExpectedChunk): number {
  return KIND_ORDER.indexOf(c.kind);
}

function span(t: ChunkTemplate): { startByte: number; endByte: number } {
  return { startByte: t.startByte, endByte: t.endByte };
}

/** チャンク ID のファイル名を、版のランタイムの組み立て方で作り、公開パスから URL にする */
function chunkUrl(id: string, via: 'async' | 'startup', templates: { raw: ArtifactFile; t: ChunkTemplate }[]): string | null {
  for (const { raw, t } of templates) {
    // 起動時の依存は HTML が読む。表に ID があるときだけ（定数に畳まれた組み立て方は使わない）
    if (via === 'startup' && !t.parts.some((p) => 'map' in p && id in p.map)) continue;
    const name = filename(t.parts, id);
    if (name === undefined) continue;
    const base = publicBase(t.publicPath, raw);
    const url = base !== null ? resolveUrl(name, base) : null;
    if (url) return url;
  }
  return null;
}

function filename(parts: TemplatePart[], id: string): string | undefined {
  let out = '';
  for (const p of parts) {
    if ('lit' in p) out += p.lit;
    else if ('id' in p) out += id;
    else {
      const v = p.map[id] ?? (p.fallbackToId ? id : undefined);
      if (v === undefined) return undefined;
      out += v;
    }
  }
  return out;
}

/** 公開パスの解き方（コメントの通り）。決まらなければ null */
function publicBase(publicPath: string | null, raw: ArtifactFile): string | null {
  const scriptUrl = raw.sourceUrls?.[0];
  if (publicPath === null) return scriptUrl ? new URL('.', scriptUrl).href : null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(publicPath) || publicPath.startsWith('//')) return resolveUrl(publicPath, scriptUrl ?? 'https://invalid.invalid/');
  const origin = raw.loadedByOrigins?.[0] ?? (scriptUrl ? new URL(scriptUrl).origin : undefined);
  if (origin === undefined) return null;
  return resolveUrl(publicPath.startsWith('/') ? publicPath : `/${publicPath}`, origin);
}

/** http(s) の URL に解く（base が無ければ絶対 URL だけ）。解けなければ null */
function resolveUrl(value: string, base: string | undefined): string | null {
  try {
    const u = new URL(value, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** 取り込み済みの raw（チャンク ID・配信 URL・ファイル名） */
function fetchedIndex(raws: ArtifactFile[]): { has(f: Found): boolean } {
  const chunkIds = new Set<string>();
  const urls = new Set<string>();
  const names = new Set<string>();
  for (const r of raws) {
    for (const id of (r.chunkKey ?? '').split(',')) if (id !== '') chunkIds.add(id);
    for (const u of r.sourceUrls ?? []) urls.add(withoutQuery(u));
    if (r.origName) names.add(r.origName);
  }
  return {
    has(f: Found): boolean {
      if (f.chunkId !== undefined && chunkIds.has(f.chunkId)) return true;
      if (f.url !== null) return urls.has(withoutQuery(f.url)) || names.has(basename(new URL(f.url).pathname));
      return names.has(basename(f.key.replace(/[?#].*$/, '')));
    },
  };
}

function withoutQuery(u: string): string {
  return u.replace(/[?#].*$/, '');
}
