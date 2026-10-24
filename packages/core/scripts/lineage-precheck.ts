/**
 * 手順6の前提確認のスクリプト（計画書 M2）: 実デプロイの 2 つの版の JS を比べ、関数の対応が exact / fuzzy / ambiguous / 不一致に
 * どれだけ分かれるか（source・sink を含む関数は別に）を記録する。DB は使わない。
 *
 *   node packages/core/scripts/lineage-precheck.ts <base のディレクトリ> <next のディレクトリ> [--json] [--threshold 0.8]
 *
 * ディレクトリの下の .js / .mjs / .cjs をすべて読む（ファイル名は対応に使わない。ハッシュが入るため）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type Counts, DEFAULT_FUZZY_THRESHOLD, precheck } from '../src/intel/lineagePrecheck.ts';

function readDir(dir: string): { name: string; code: string }[] {
  const out: { name: string; code: string }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m|c)?js$/.test(name)) out.push({ name: relative(dir, p), code: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const t = args.indexOf('--threshold');
const threshold = t >= 0 ? Number(args[t + 1]) : DEFAULT_FUZZY_THRESHOLD;
const dirs = args.filter((a, i) => !a.startsWith('--') && !(t >= 0 && i === t + 1));
if (dirs.length !== 2 || !(threshold > 0 && threshold <= 1)) {
  process.stderr.write('usage: node packages/core/scripts/lineage-precheck.ts <base-dir> <next-dir> [--json] [--threshold 0.8]\n');
  process.exit(2);
}

const report = precheck({ files: readDir(dirs[0]!) }, { files: readDir(dirs[1]!) }, threshold);
if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const pct = (n: number, c: Counts) => (c.total === 0 ? '-' : `${((100 * n) / c.total).toFixed(1)}%`);
  const row = (label: string, c: Counts) =>
    `| ${label} | ${c.total} | ${c.exact} (${pct(c.exact, c)}) | ${c.fuzzy} (${pct(c.fuzzy, c)}) | ${c.ambiguous} (${pct(c.ambiguous, c)}) | ${c.unmatched} (${pct(c.unmatched, c)}) |`;
  process.stdout.write(
    [
      `base: ${report.base.files} files, ${report.base.functions} functions${report.base.parseFailed.length ? `, unreadable: ${report.base.parseFailed.join(', ')}` : ''}`,
      `next: ${report.next.files} files, ${report.next.functions} functions${report.next.parseFailed.length ? `, unreadable: ${report.next.parseFailed.join(', ')}` : ''}`,
      '',
      '| base の関数 | 数 | exact | fuzzy | ambiguous | 不一致 |',
      '|---|---|---|---|---|---|',
      row('すべて', report.all),
      row('source・sink を含む', report.sourceSink),
      '',
      `next にだけある関数: ${report.nextOnly}（fuzzy の閾値 ${report.fuzzyThreshold}）`,
      '',
    ].join('\n'),
  );
}
