/**
 * ビルド後の sa コマンド（dist）を実際に起動して、対象の作成 → 取り込み（unpack・sourcemap）→ エンドポイントの抽出 → バックアップを
 * 一通り動かす。
 * pnpm build の後に CI で実行する。単体テストは src を読むので、dist の解決（worker の dist/workers/*.js を含む）はここで確かめる。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const fixture = new URL('../../core/test/fixtures/webpack5-basic/output/', import.meta.url).pathname;
const endpointsBundle = new URL('../../core/test/fixtures/webpack5-endpoints/output/main.c452f02c.js', import.meta.url).pathname;
const home = mkdtempSync(join(tmpdir(), 'sa-smoke-'));

/** 引数は配列で渡す（シェルを通さない） */
const sa = (...args) =>
  execFileSync(process.execPath, [cli, '--json', ...args], { env: { ...process.env, SA_HOME: home }, encoding: 'utf8' });

try {
  sa('target', 'add', 'smoke', '--allow', 'example.com');
  const files = readdirSync(fixture).map((f) => join(fixture, f));
  const r = JSON.parse(sa('load', 'smoke', ...files, '--collected-at', 'now'));
  const accepted = r.sourcemaps.filter((s) => s.result?.accepted).length;
  if (r.unpack.moduleCount !== 4 || r.unpack.skipped !== 0 || accepted !== 3) {
    throw new Error(`unexpected load result: ${JSON.stringify({ unpack: r.unpack, accepted })}`);
  }
  sa('load', 'smoke', endpointsBundle, '--version-id', r.load.versionId);
  const e = JSON.parse(sa('extract-endpoints', 'smoke'));
  if (e.endpoints !== 10 || e.skipped !== 0) throw new Error(`unexpected extract-endpoints result: ${JSON.stringify(e)}`);
  const b = JSON.parse(sa('backup', join(home, 'snapshot.db')));
  if (b.schemaVersion < 1) throw new Error(`unexpected backup result: ${JSON.stringify(b)}`);
  console.log(
    `smoke ok: ${r.unpack.moduleCount} modules, ${accepted} sourcemaps accepted, ${e.endpoints} endpoints, backup schema ${b.schemaVersion}`,
  );
} finally {
  rmSync(home, { recursive: true, force: true });
}
