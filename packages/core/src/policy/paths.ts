/**
 * 作業パスの生成と検証（design.md 原則8・§6.6、docs/architecture.md §3.1）。
 * - ファイルシステムのパスはツールが生成する: <version_id>/<layer>/<file_id>.<ext>
 *   sourcemap の sources 名・モジュール名は表示用（orig_name）にだけ置き、パスに使わない
 * - 例外は original 層。import を解決できるよう sources の相対構造を保つ（§6.6）ので、
 *   sources 名を正規化してから <version_id>/original/<map_file_id>/<正規化名> に置く
 * - 書き出しの直前に、実際のパス（シンボリックリンクを解決したもの）が作業ディレクトリ配下にあることを確かめる
 */
import { closeSync, constants, existsSync, mkdirSync, openSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type ArtifactKind, LAYERS, type Layer } from '@sa/types';
import { SaError } from '../errors';
import { isUlid } from '../ids';

export interface WorkPath {
  /** 作業ディレクトリからの相対パス（区切りは '/'）。artifact_file.path に入れる値 */
  relPath: string;
  /** 絶対パス */
  absPath: string;
}

const KIND_EXT: Record<ArtifactKind, string> = { js: '.js', sourcemap: '.map', html: '.html' };

/** 正規化で「作業ディレクトリより上」を指す .. の代わりに置く区切り名。外へは出さず、別の名前とも衝突しにくくする */
export const UP_SEGMENT = '__up__';

const MAX_SEGMENT_BYTES = 255;

/** <version_id>/<layer>/<file_id>.<ext>。ID は newId() の形（ULID）に限る */
export function generateWorkPath(
  workspaceDir: string,
  p: { versionId: string; layer: Layer; fileId: string; kind?: ArtifactKind },
): WorkPath {
  assertId('versionId', p.versionId);
  assertId('fileId', p.fileId);
  if (!(LAYERS as readonly string[]).includes(p.layer)) throw new SaError('INVALID_INPUT', `unknown layer: ${p.layer}`);
  if (p.layer === 'original') {
    throw new SaError('INVALID_INPUT', 'original layer keeps source structure; use generateOriginalSourcePath');
  }
  const ext = KIND_EXT[p.kind ?? 'js'];
  if (ext === undefined) throw new SaError('INVALID_INPUT', `unknown artifact kind: ${p.kind}`);
  return toWorkPath(workspaceDir, `${p.versionId}/${p.layer}/${p.fileId}${ext}`);
}

/** original 層のパス: <version_id>/original/<map_file_id>/<正規化した sources 名> */
export function generateOriginalSourcePath(
  workspaceDir: string,
  p: { versionId: string; mapFileId: string; sourceName: string },
): WorkPath {
  assertId('versionId', p.versionId);
  assertId('mapFileId', p.mapFileId);
  return toWorkPath(workspaceDir, `${p.versionId}/original/${p.mapFileId}/${normalizeSourceName(p.sourceName)}`);
}

/**
 * sourcemap の sources 名（ターゲット由来・信頼しない）を、作業ディレクトリ内の相対パスに正規化する。
 * - クエリ・フラグメント（?vue&type=… / #…）と URL スキーム（webpack:// file:// など）を除く
 * - \ は / に、制御文字は _ に置き換える。空・. の区切りは捨てる
 * - .. は手前の区切りと打ち消し、それでも上へ出るものは UP_SEGMENT に置き換える（外へは出さない）
 * 違う sources 名が同じパスになることがある（例: a.vue?type=script と a.vue?type=template）。重複の扱いは呼び出し側が決める。
 * 使える名前が残らない・区切りが長すぎるときは INVALID_INPUT（呼び出し側は path_excluded として記録する）。
 */
export function normalizeSourceName(name: string): string {
  let s = name.replace(/[?#].*$/s, '');
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/\\/g, '/').replace(/[\x00-\x1f\x7f]/g, '_');

  const out: string[] = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== UP_SEGMENT) out.pop();
      else out.push(UP_SEGMENT);
      continue;
    }
    if (Buffer.byteLength(seg, 'utf8') > MAX_SEGMENT_BYTES) {
      throw new SaError('INVALID_INPUT', 'source name has a path segment longer than 255 bytes', { sourceName: name });
    }
    out.push(seg);
  }
  if (out.length === 0 || out.every((seg) => seg === UP_SEGMENT)) {
    throw new SaError('INVALID_INPUT', 'source name does not contain a usable file path', { sourceName: name });
  }
  return out.join('/');
}

/**
 * target（絶対パス、または作業ディレクトリからの相対パス）が作業ディレクトリ配下にあることを確かめ、絶対パスを返す。
 * 字面だけでなく、存在する一番深い祖先（target 自身を含む）のシンボリックリンクを解決した実パスでも確かめる。
 */
export function assertWithinWorkspace(workspaceDir: string, target: string): string {
  let root: string;
  try {
    root = realpathSync(resolve(workspaceDir));
  } catch (err) {
    throw new SaError('INVALID_INPUT', `workspace does not exist: ${workspaceDir}`, { workspaceDir }, { cause: err });
  }
  const abs = resolve(root, target);
  if (!isWithin(root, abs)) {
    throw new SaError('POLICY_DENIED', `path escapes the workspace: ${target}`, { workspaceDir, target });
  }
  let existing = abs;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = realpathSync(existing);
  if (!isWithin(root, real)) {
    throw new SaError('POLICY_DENIED', `path escapes the workspace through a symbolic link: ${target}`, {
      workspaceDir,
      target,
    });
  }
  return abs;
}

/**
 * 作業ディレクトリ配下の relPath に data を書く（親ディレクトリは作る）。書き出しはすべてこれを通す。
 * 最後の要素がシンボリックリンクなら辿らずに失敗する（O_NOFOLLOW）。既存のファイルは上書きする（作業ファイルは作り直せるキャッシュ）。
 */
export function writeWorkFile(workspaceDir: string, relPath: string, data: Uint8Array): string {
  if (isAbsolute(relPath)) throw new SaError('INVALID_INPUT', `relPath must be relative: ${relPath}`);
  const abs = assertWithinWorkspace(workspaceDir, relPath);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    const fd = openSync(abs, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try {
      let off = 0;
      while (off < data.byteLength) off += writeSync(fd, data, off);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    throw new SaError('IO_ERROR', `failed to write work file ${relPath}`, { relPath }, { cause: err });
  }
  return abs;
}

function toWorkPath(workspaceDir: string, relPath: string): WorkPath {
  return { relPath, absPath: assertWithinWorkspace(workspaceDir, join(...relPath.split('/'))) };
}

function assertId(name: string, id: string): void {
  if (!isUlid(id)) throw new SaError('INVALID_INPUT', `${name} must be a ULID generated by sa-core`, { [name]: id });
}

/** p が root 自身か root の下にあるか（'..foo' のような名前を外と誤認しない） */
function isWithin(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
