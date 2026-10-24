/**
 * load_artifact（design.md §7.1、計画書 M1）: 人間が取得したファイルを raw 層として取り込む。
 * - 中身は blob ストアに置き（content_hash で重複排除）、artifact_file 行を作る。path はツールが生成する作業パス（原則8）
 * - versionId を渡せば既存の版にファイルを足す。版の中で同じ中身のファイルは 1 行にまとめ、配信 URL 等を足し合わせる
 * - HAR はここでは受けない（HAR は保存しない。import_har で許可リストの項目だけを抜く）
 * パースはしない（unpack_bundle が worker で行う）。版にファイルを足したら、呼び出し側が unpack 以降を掛け直す。
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { type ArtifactKind, type LoadArtifactFile, type LoadArtifactInput, LoadArtifactInputSchema } from '@sa/types';
import type { SaContext } from '../context';
import { withTxn } from '../db/connection';
import { findArtifactFileByHash, insertArtifactFile, updateArtifactFile } from '../db/repo/artifactFile';
import { getArtifactVersion, insertArtifactVersion } from '../db/repo/artifactVersion';
import { getTarget } from '../db/repo/target';
import { SaError } from '../errors';
import { newId } from '../ids';
import { generateWorkPath } from '../policy/paths';
import { parseInput } from '../validate';

export interface LoadArtifactResult {
  versionId: string;
  /** 版を新しく作ったか */
  createdVersion: boolean;
  /** 入力の順。版に同じ中身が既にあったファイルは既存の ID */
  fileIds: string[];
  /** 新しく作った raw 行の数 */
  added: number;
}

/** 取り込む中身 1 つ（人間が渡したファイル、import_har が抜き出したレスポンス本文） */
export interface RawFileInput extends Omit<LoadArtifactFile, 'path'> {
  /** 種類の判定と表示用の名前に使う（ファイルのパスか、URL のパス） */
  name: string;
  bytes: Uint8Array;
}

/** 足す先の版。versionId が無ければ新しい版を作る（collectedAt が要る） */
export type VersionSpec = Omit<LoadArtifactInput, 'files'>;

export function loadArtifact(ctx: SaContext, input: LoadArtifactInput): LoadArtifactResult {
  const { files, ...spec } = parseInput(LoadArtifactInputSchema, input, 'load_artifact');
  checkVersionSpec(ctx, spec);
  return addRawFiles(
    ctx,
    spec,
    files.map(({ path, ...f }) => ({ ...f, name: path, bytes: readInputFile(path), origName: f.origName ?? basename(path) })),
  );
}

/** 足す先の版の指定を確かめる（対象・既存の版・基準の版） */
export function checkVersionSpec(ctx: SaContext, req: VersionSpec): void {
  if (!getTarget(ctx, req.targetId)) throw new SaError('NOT_FOUND', `target not found: ${req.targetId}`);
  if (req.versionId !== undefined) {
    const v = getArtifactVersion(ctx, req.versionId);
    if (!v) throw new SaError('NOT_FOUND', `artifact_version not found: ${req.versionId}`);
    if (v.targetId !== req.targetId) throw new SaError('INVALID_INPUT', `artifact_version ${req.versionId} belongs to another target`);
    const versionAttrs = [req.baseVersionId, req.label, req.collectedAt, req.collectionNotes];
    if (versionAttrs.some((a) => a !== undefined)) {
      throw new SaError('INVALID_INPUT', 'baseVersionId / label / collectedAt / collectionNotes can only be set when creating a version');
    }
  } else {
    if (req.collectedAt === undefined) throw new SaError('INVALID_INPUT', 'collectedAt is required to create a version');
    if (req.baseVersionId !== undefined) {
      const base = getArtifactVersion(ctx, req.baseVersionId);
      if (!base) throw new SaError('NOT_FOUND', `base artifact_version not found: ${req.baseVersionId}`);
      if (base.targetId !== req.targetId) throw new SaError('INVALID_INPUT', 'base version belongs to another target');
    }
  }
}

/**
 * 中身を raw 層に置く（spec は checkVersionSpec を通したもの）。版が無ければ作る。
 * files が空なら、版を作るだけ（import_har で JS が 1 つも無かったとき）
 */
export function addRawFiles(ctx: SaContext, req: VersionSpec, input: RawFileInput[]): LoadArtifactResult {
  // blob に置くまではトランザクションの外（中身は content_hash 名なので、後で失敗しても害が無い）
  const files = input.map(({ bytes, name, ...f }) => {
    const kind = detectKind(name, bytes);
    const { hash } = ctx.store.put(bytes);
    return { ...f, kind, hash, origName: f.origName ?? basename(name) };
  });

  return withTxn(ctx, () => {
    const createdVersion = req.versionId === undefined;
    const versionId =
      req.versionId ??
      insertArtifactVersion(ctx, {
        targetId: req.targetId,
        // 時刻は UTC にそろえて持つ（design.md §6。並べ替えを文字列比較でできるように）
        collectedAt: new Date(req.collectedAt!).toISOString(),
        ...(req.label !== undefined && { label: req.label }),
        ...(req.baseVersionId !== undefined && { baseVersionId: req.baseVersionId }),
        ...(req.collectionNotes !== undefined && { collectionNotes: req.collectionNotes }),
      });

    let added = 0;
    const fileIds = files.map((f) => {
      const existing = findArtifactFileByHash(ctx, { versionId, layer: 'raw', contentHash: f.hash });
      if (existing) {
        // 同じ中身を別の URL から取ったなど。行は 1 つにまとめ、観測を足し合わせる
        updateArtifactFile(ctx, existing.id, {
          ...(f.sourceUrls && { sourceUrls: union(existing.sourceUrls, f.sourceUrls) }),
          ...(f.loadedByOrigins && { loadedByOrigins: union(existing.loadedByOrigins, f.loadedByOrigins) }),
          ...(f.chunkKey !== undefined && existing.chunkKey === null && { chunkKey: f.chunkKey }),
          ...(f.ownership !== undefined && existing.ownership === 'unknown' && { ownership: f.ownership }),
        });
        return existing.id;
      }
      const id = newId();
      insertArtifactFile(ctx, {
        id,
        versionId,
        layer: 'raw',
        kind: f.kind,
        path: generateWorkPath(ctx.config.workspaceDir, { versionId, layer: 'raw', fileId: id, kind: f.kind }).relPath,
        origName: f.origName,
        contentHash: f.hash,
        ownership: f.ownership ?? 'unknown',
        ...(f.sourceUrls && { sourceUrls: f.sourceUrls }),
        ...(f.loadedByOrigins && { loadedByOrigins: f.loadedByOrigins }),
        ...(f.chunkKey !== undefined && { chunkKey: f.chunkKey }),
      });
      added++;
      return id;
    });
    return { versionId, createdVersion, fileIds, added };
  });
}

function readInputFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new SaError('INVALID_INPUT', `file not found: ${path}`, { path }, { cause: err });
    throw new SaError('IO_ERROR', `cannot read ${path}`, { path }, { cause: err });
  }
}

/** 拡張子で決め、決まらなければ先頭を見る。HAR は拒否する */
export function detectKind(path: string, bytes: Uint8Array): ArtifactKind {
  const head = Buffer.from(bytes.subarray(0, 4096)).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const ext = extname(path).toLowerCase();
  if (ext === '.har' || /^\{\s*"log"\s*:/.test(head)) {
    throw new SaError('INVALID_INPUT', 'HAR files are not stored; use import_har (it keeps only allow-listed fields)', { path });
  }
  if (ext === '.map') return 'sourcemap';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js';
  if (head.startsWith('{') && /"mappings"\s*:/.test(head)) return 'sourcemap';
  if (/^<(!doctype|html)/i.test(head)) return 'html';
  return 'js';
}

function union(a: string[] | null, b: string[]): string[] {
  return [...new Set([...(a ?? []), ...b])];
}
