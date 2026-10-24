/**
 * content_hash（sha256）を名前にした blob ストア（design.md §6.1「成果物ストア」）。
 * 実体は <root>/<hash[0:2]>/<hash>。同じ中身は版をまたいで 1 つだけ保存する。position_map も blob にする。
 *
 * 受け取るのはバイト列だけ（文字列は受けない）。証拠の基準座標は raw のバイト範囲なので（design.md §6.6）、
 * 取り込んだバイトを文字列に変換して符号化し直すと座標がずれる。
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { SaError } from '../errors';

export interface BlobPutResult {
  /** sha256（小文字 16 進 64 桁）。artifact_file.content_hash / position_map_hash に入れる値 */
  hash: string;
  size: number;
  /** 新しく書いたら true、既にあって重複排除したら false */
  created: boolean;
}

export interface BlobStore {
  readonly root: string;
  put(data: Uint8Array): BlobPutResult;
  /** 中身を読み、ハッシュが名前と一致するか検査してから返す */
  get(hash: string): Buffer;
  has(hash: string): boolean;
  /** 中身を読まずに大きさ（バイト）を返す */
  sizeOf(hash: string): number;
  pathOf(hash: string): string;
}

const HASH_RE = /^[0-9a-f]{64}$/;

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** root 配下の blob ストアを開く（root が無ければ作る） */
export function openBlobStore(root: string): BlobStore {
  const absRoot = resolve(root);
  mkdirSync(absRoot, { recursive: true });

  // hash は外から来る値なので、形式を確かめてからパスに使う（原則8。'../' などでストアの外を指させない）
  const pathOf = (hash: string): string => {
    if (!HASH_RE.test(hash)) {
      throw new SaError('INVALID_INPUT', 'blob hash must be 64 lowercase hex characters', { hash });
    }
    return join(absRoot, hash.slice(0, 2), hash);
  };

  const put = (data: Uint8Array): BlobPutResult => {
    const hash = sha256Hex(data);
    const dest = pathOf(hash);
    if (existsSync(dest)) return { hash, size: data.byteLength, created: false };

    mkdirSync(join(absRoot, hash.slice(0, 2)), { recursive: true });
    // 同じディレクトリの一時ファイルに書いて fsync してから rename する（途中で落ちても壊れた blob を名前で残さない）。
    // 完成した blob は書き換えないので読み取り専用で作る
    const tmp = `${dest}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      const fd = openSync(tmp, 'wx', 0o444);
      try {
        let off = 0;
        while (off < data.byteLength) off += writeSync(fd, data, off);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new SaError('IO_ERROR', `failed to write blob ${hash}`, { hash }, { cause: err });
    }
    return { hash, size: data.byteLength, created: true };
  };

  const get = (hash: string): Buffer => {
    const p = pathOf(hash);
    let data: Buffer;
    try {
      data = readFileSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SaError('NOT_FOUND', `blob not found: ${hash}`, { hash }, { cause: err });
      }
      throw new SaError('IO_ERROR', `failed to read blob ${hash}`, { hash }, { cause: err });
    }
    const actual = sha256Hex(data);
    if (actual !== hash) {
      throw new SaError('INTEGRITY_ERROR', `blob content does not match its hash: ${hash}`, { hash, actual });
    }
    return data;
  };

  const has = (hash: string): boolean => existsSync(pathOf(hash));

  const sizeOf = (hash: string): number => {
    const p = pathOf(hash);
    try {
      return statSync(p).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new SaError('NOT_FOUND', `blob not found: ${hash}`, { hash }, { cause: err });
      }
      throw new SaError('IO_ERROR', `failed to stat blob ${hash}`, { hash }, { cause: err });
    }
  };

  return { root: absRoot, put, get, has, sizeOf, pathOf };
}
