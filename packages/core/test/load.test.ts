import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SaContext, isUlid, loadArtifact } from '@sa/core';
import { getArtifactFile, listArtifactFiles } from '../src/db/repo/artifactFile';
import { getArtifactVersion } from '../src/db/repo/artifactVersion';
import { insertTarget } from '../src/db/repo/target';
import { catchError, useContext, useTmpDir } from './helpers';

const makeCtx = useContext();
const tmp = useTmpDir();
const T0 = '2026-10-01T09:00:00Z';
const fixture = (name: string) => new URL(`./fixtures/webpack5-basic/output/${name}`, import.meta.url).pathname;

function setup(): { ctx: SaContext; targetId: string } {
  const ctx = makeCtx();
  return { ctx, targetId: insertTarget(ctx, { name: 'example', scope: { allowed_domains: ['example.com'] } }) };
}

const code = (fn: () => unknown) => (catchError(fn) as { code: string }).code;

describe('loadArtifact', () => {
  it('creates a version and stores each file as a raw layer blob', () => {
    const { ctx, targetId } = setup();
    const r = loadArtifact(ctx, {
      targetId,
      collectedAt: T0,
      label: 'v1',
      collectionNotes: { loggedIn: true, role: 'user' },
      files: [
        {
          path: fixture('main.037dca38.js'),
          sourceUrls: ['https://cdn.example.com/static/main.037dca38.js'],
          loadedByOrigins: ['https://app.example.com'],
          ownership: 'first_party',
        },
        { path: fixture('main.037dca38.js.map') },
      ],
    });
    expect(r.createdVersion).toBe(true);
    expect(r.added).toBe(2);
    expect(getArtifactVersion(ctx, r.versionId)).toMatchObject({
      targetId,
      label: 'v1',
      baseVersionId: null,
      collectedAt: T0,
      collectionNotes: { loggedIn: true, role: 'user' },
    });

    const [js, map] = r.fileIds.map((id) => getArtifactFile(ctx, id)!);
    expect(js).toMatchObject({
      layer: 'raw',
      kind: 'js',
      path: `${r.versionId}/raw/${js!.id}.js`,
      origName: 'main.037dca38.js',
      sourceUrls: ['https://cdn.example.com/static/main.037dca38.js'],
      loadedByOrigins: ['https://app.example.com'],
      ownership: 'first_party',
      parseStatus: 'ok',
      bundler: null,
      parentFileId: null,
    });
    expect(isUlid(js!.id)).toBe(true);
    expect(ctx.store.get(js!.contentHash)).toEqual(readFileSync(fixture('main.037dca38.js')));
    expect(map).toMatchObject({ kind: 'sourcemap', path: `${r.versionId}/raw/${map!.id}.map`, ownership: 'unknown' });
  });

  it('adds files to an existing version and keeps one row per content, merging observations', () => {
    const { ctx, targetId } = setup();
    const first = loadArtifact(ctx, {
      targetId,
      collectedAt: T0,
      files: [{ path: fixture('949.d486fd40.js'), sourceUrls: ['https://cdn.example.com/a/949.js'] }],
    });
    const second = loadArtifact(ctx, {
      targetId,
      versionId: first.versionId,
      files: [
        { path: fixture('949.d486fd40.js'), sourceUrls: ['https://cdn2.example.com/949.js'], chunkKey: '949' },
        { path: fixture('lazy.ce3f5b37.js') },
      ],
    });
    expect(second).toMatchObject({ versionId: first.versionId, createdVersion: false, added: 1 });
    expect(second.fileIds[0]).toBe(first.fileIds[0]);
    expect(getArtifactFile(ctx, first.fileIds[0]!)).toMatchObject({
      sourceUrls: ['https://cdn.example.com/a/949.js', 'https://cdn2.example.com/949.js'],
      chunkKey: '949',
    });
    expect(listArtifactFiles(ctx, { versionId: first.versionId, layer: 'raw' })).toHaveLength(2);
  });

  it('links a new version to its base version of the same target', () => {
    const { ctx, targetId } = setup();
    const v1 = loadArtifact(ctx, { targetId, collectedAt: T0, files: [{ path: fixture('lazy.ce3f5b37.js') }] });
    const v2 = loadArtifact(ctx, {
      targetId,
      collectedAt: '2026-10-08T09:00:00+09:00',
      baseVersionId: v1.versionId,
      files: [{ path: fixture('lazy.ce3f5b37.js') }],
    });
    expect(getArtifactVersion(ctx, v2.versionId)?.baseVersionId).toBe(v1.versionId);
    // 版をまたいでも blob は 1 つ
    expect(getArtifactFile(ctx, v2.fileIds[0]!)?.contentHash).toBe(getArtifactFile(ctx, v1.fileIds[0]!)?.contentHash);
  });

  it('refuses HAR files, by extension or by content', () => {
    const { ctx, targetId } = setup();
    const dir = tmp();
    writeFileSync(join(dir, 'capture.har'), '{}');
    writeFileSync(join(dir, 'capture.json'), '{ "log": { "entries": [] } }');
    for (const path of [join(dir, 'capture.har'), join(dir, 'capture.json')]) {
      expect(code(() => loadArtifact(ctx, { targetId, collectedAt: T0, files: [{ path }] }))).toBe('INVALID_INPUT');
    }
  });

  it('detects the kind from the content when the extension says nothing', () => {
    const { ctx, targetId } = setup();
    const dir = tmp();
    writeFileSync(join(dir, 'page'), '<!doctype html><script src="/main.js"></script>');
    writeFileSync(join(dir, 'map'), readFileSync(fixture('lazy.ce3f5b37.js.map')));
    writeFileSync(join(dir, 'chunk'), readFileSync(fixture('lazy.ce3f5b37.js')));
    const r = loadArtifact(ctx, {
      targetId,
      collectedAt: T0,
      files: ['page', 'map', 'chunk'].map((n) => ({ path: join(dir, n) })),
    });
    expect(r.fileIds.map((id) => getArtifactFile(ctx, id)?.kind)).toEqual(['html', 'sourcemap', 'js']);
  });

  it('validates the request', () => {
    const { ctx, targetId } = setup();
    const file = { path: fixture('lazy.ce3f5b37.js') };
    const v = loadArtifact(ctx, { targetId, collectedAt: T0, files: [file] });
    const other = setup();
    const otherV = loadArtifact(other.ctx, { targetId: other.targetId, collectedAt: T0, files: [file] });

    expect(code(() => loadArtifact(ctx, { targetId: 'missing', collectedAt: T0, files: [file] }))).toBe('NOT_FOUND');
    expect(code(() => loadArtifact(ctx, { targetId, files: [file] }))).toBe('INVALID_INPUT');
    expect(code(() => loadArtifact(ctx, { targetId, collectedAt: 'yesterday', files: [file] }))).toBe('INVALID_INPUT');
    expect(code(() => loadArtifact(ctx, { targetId, collectedAt: T0, files: [] }))).toBe('INVALID_INPUT');
    expect(
      code(() => loadArtifact(ctx, { targetId, collectedAt: T0, files: [{ ...file, sourceUrls: ['not a url'] }] })),
    ).toBe('INVALID_INPUT');
    expect(code(() => loadArtifact(ctx, { targetId, versionId: v.versionId, collectedAt: T0, files: [file] }))).toBe(
      'INVALID_INPUT',
    );
    expect(code(() => loadArtifact(ctx, { targetId, versionId: 'missing', files: [file] }))).toBe('NOT_FOUND');
    expect(code(() => loadArtifact(ctx, { targetId, collectedAt: T0, files: [{ path: join(tmp(), 'nope.js') }] }))).toBe(
      'INVALID_INPUT',
    );
    // 別の対象の版を基準にはできない（別 DB の ID は存在しない扱い）
    expect(code(() => loadArtifact(ctx, { targetId, collectedAt: T0, baseVersionId: otherV.versionId, files: [file] }))).toBe(
      'NOT_FOUND',
    );
    const t2 = insertTarget(ctx, { name: 'other' });
    expect(code(() => loadArtifact(ctx, { targetId: t2, collectedAt: T0, baseVersionId: v.versionId, files: [file] }))).toBe(
      'INVALID_INPUT',
    );
    expect(code(() => loadArtifact(ctx, { targetId: t2, versionId: v.versionId, files: [file] }))).toBe('INVALID_INPUT');
  });
});
