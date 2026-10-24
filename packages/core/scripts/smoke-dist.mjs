/**
 * ビルド後の dist で、取り込み → unpack → sourcemap を一通り動かす（pnpm build の後に CI で実行）。
 * 単体テストは worker を src（型除去）から読むので、dist/workers/*.js の解決とバンドルはここで確かめる。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  createJobRunner,
  importSourcemap,
  loadArtifact,
  migrate,
  newId,
  openBlobStore,
  openDatabase,
  unpackBundle,
} from '../dist/index.js';

const fixture = new URL('../test/fixtures/webpack5-basic/output/', import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), 'sa-smoke-'));
const db = openDatabase(join(dir, 'sa.db'));
try {
  migrate(db);
  const workspaceDir = join(dir, 'workspace');
  mkdirSync(workspaceDir);
  const ctx = {
    db,
    store: openBlobStore(join(dir, 'blobs')),
    jobs: createJobRunner(),
    config: { ...DEFAULT_CONFIG, workspaceDir },
    caller: 'cli',
  };
  // 対象を作る関数（sa target）は PR-5。ここでは行を直接入れる
  const targetId = newId();
  db.prepare('INSERT INTO target (id, name) VALUES (?, ?)').run(targetId, 'smoke');

  const names = readdirSync(fixture);
  const { versionId, fileIds } = loadArtifact(ctx, {
    targetId,
    collectedAt: '2026-10-01T00:00:00Z',
    files: names.map((f) => ({ path: join(fixture, f) })),
  });

  const unpacked = await unpackBundle(ctx, { versionId });
  if (unpacked.moduleCount !== 4 || unpacked.skipped !== 0) throw new Error(`unexpected unpack result: ${JSON.stringify(unpacked)}`);

  const mapFileId = fileIds[names.indexOf('main.037dca38.js.map')];
  const sm = await importSourcemap(ctx, { versionId, mapFileId });
  if (!sm.accepted || sm.originalFileIds.length === 0) throw new Error(`unexpected sourcemap result: ${JSON.stringify(sm)}`);

  console.log(`smoke ok: ${unpacked.moduleCount} modules, ${sm.originalFileIds.length} original files, map rate ${sm.mapCheck.rate}`);
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
