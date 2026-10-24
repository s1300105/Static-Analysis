import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SaError, openBlobStore, sha256Hex } from '@sa/core';
import { catchError, useTmpDir } from './helpers';

const tmp = useTmpDir();

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('BlobStore', () => {
  it('stores content under <root>/<hash[0:2]>/<hash> named by its sha256', () => {
    const store = openBlobStore(join(tmp(), 'blobs'));
    const data = Buffer.from('console.log(1);\n');
    const r = store.put(data);
    expect(r).toEqual({ hash: sha256Hex(data), size: data.byteLength, created: true });
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    const p = store.pathOf(r.hash);
    expect(p).toBe(join(store.root, r.hash.slice(0, 2), r.hash));
    expect(readFileSync(p)).toEqual(data);
    // 完成した blob は書き換えない
    expect(statSync(p).mode & 0o222).toBe(0);
    // 一時ファイルを残さない
    expect(readdirSync(join(store.root, r.hash.slice(0, 2)))).toEqual([r.hash]);
  });

  it('deduplicates identical content', () => {
    const store = openBlobStore(join(tmp(), 'blobs'));
    const a = store.put(Buffer.from('same'));
    const b = store.put(new TextEncoder().encode('same'));
    expect(b).toEqual({ ...a, created: false });
  });

  it('preserves raw bytes exactly (BOM, invalid UTF-8, NUL)', () => {
    const store = openBlobStore(join(tmp(), 'blobs'));
    const data = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff, 0xfe, 0x00, 0x0d, 0x0a]);
    const { hash } = store.put(data);
    expect(new Uint8Array(store.get(hash))).toEqual(data);
    expect(store.sizeOf(hash)).toBe(data.byteLength);
  });

  it('handles empty content', () => {
    const store = openBlobStore(join(tmp(), 'blobs'));
    expect(store.put(new Uint8Array()).hash).toBe(EMPTY_SHA256);
    expect(store.get(EMPTY_SHA256).byteLength).toBe(0);
  });

  it('verifies content against its hash on read', () => {
    const store = openBlobStore(join(tmp(), 'blobs'));
    const { hash } = store.put(Buffer.from('original'));
    const p = store.pathOf(hash);
    chmodSync(p, 0o644);
    writeFileSync(p, 'tampered');
    const err = catchError(() => store.get(hash));
    expect(err).toBeInstanceOf(SaError);
    expect((err as SaError).code).toBe('INTEGRITY_ERROR');
  });

  it('reports a missing blob as NOT_FOUND', () => {
    const store = openBlobStore(join(tmp(), 'blobs'));
    expect(store.has(EMPTY_SHA256)).toBe(false);
    expect((catchError(() => store.get(EMPTY_SHA256)) as SaError).code).toBe('NOT_FOUND');
    expect((catchError(() => store.sizeOf(EMPTY_SHA256)) as SaError).code).toBe('NOT_FOUND');
  });

  it('rejects malformed hashes before touching the filesystem', () => {
    const store = openBlobStore(join(tmp(), 'blobs'));
    for (const bad of ['../../etc/passwd', `../${'a'.repeat(62)}`, 'A'.repeat(64), 'a'.repeat(63), '']) {
      expect((catchError(() => store.pathOf(bad)) as SaError).code).toBe('INVALID_INPUT');
      expect((catchError(() => store.get(bad)) as SaError).code).toBe('INVALID_INPUT');
      expect((catchError(() => store.has(bad)) as SaError).code).toBe('INVALID_INPUT');
      expect((catchError(() => store.sizeOf(bad)) as SaError).code).toBe('INVALID_INPUT');
    }
  });
});
