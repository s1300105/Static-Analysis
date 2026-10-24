import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { functionsOf, matchFunctions, precheck } from '../src/intel/lineagePrecheck';

const fixture = new URL('./fixtures/webpack5-endpoints/', import.meta.url).pathname;
const script = new URL('../scripts/lineage-precheck.ts', import.meta.url).pathname;

const one = (code: string) => functionsOf(code, 'x.js');
const kinds = (a: string, b: string) => matchFunctions(one(a), one(b)).kinds;

describe('simplified norm_hash', () => {
  it('ignores renamed identifiers and boolean / undefined spellings, but not property names or strings', () => {
    const [f] = one('function f(a, b) { return a.total + b + "x" }');
    expect(one('function zz(q, r) { return q.total + r + "x" }')[0]!.normHash).toBe(f!.normHash);
    expect(one('function f(a, b) { return a.count + b + "x" }')[0]!.normHash).not.toBe(f!.normHash);
    expect(one('function f(a, b) { return a.total + b + "y" }')[0]!.normHash).not.toBe(f!.normHash);
    expect(one('function f(a) { return a === !0 || void 0 }')[0]!.normHash).toBe(one('function f(a) { return a === true || undefined }')[0]!.normHash);
    expect(f!.anchors).toEqual(['total', 'x']);
  });

  it('replaces nested function bodies with a placeholder', () => {
    const outer = (inner: string) => one(`function outer(a) { const h = ${inner}; return h(a.id) }`);
    const [o1, i1] = outer('(x) => x.name');
    const [o2, i2] = outer('(x) => x.title');
    expect(o1!.normHash).toBe(o2!.normHash);
    expect(i1!.normHash).not.toBe(i2!.normHash);
  });

  it('marks functions that touch sources or sinks', () => {
    expect(one('function r(e) { el.innerHTML = e }')[0]!.sourceSink).toBe(true);
    expect(one('function r(e) { return location.hash.slice(1) }')[0]!.sourceSink).toBe(true);
    expect(one('function r(e) { return e + 1 }')[0]!.sourceSink).toBe(false);
  });
});

describe('matching', () => {
  it('separates exact, ambiguous, fuzzy and unmatched functions', () => {
    const big = (v: string) =>
      `function big(o) { const r = o.items.filter((i) => i.active).map((i) => i.id); if (r.length > 10) { log("too many", r.length); } return fetch("/api/save", { method: "POST", body: JSON.stringify({ ids: r, version: "${v}" }) }); }`;
    const base = `${big('1')} function gone(a) { return a.legacy } function same(a) { return a.keep * 2 } const d1 = () => 1, d2 = () => 1;`;
    const next = `${big('2')} function same(b) { return b.keep * 2 } function added(z) { return z.fresh } const d3 = () => 1;`;
    const r = matchFunctions(one(base), one(next));
    const named = Object.fromEntries(one(base).map((f, i) => [base.slice(Number(f.where.split(':')[1]), Number(f.where.split(':')[1]) + 12), r.kinds[i]]));
    expect(named).toMatchObject({ 'function big': 'fuzzy', 'function gon': 'unmatched', 'function sam': 'exact', '() => 1, d2 ': 'ambiguous', '() => 1;': 'ambiguous' });
    // next にだけあるのは added（と big の中の矢印関数の変わらない分は exact）
    expect(r.nextOnly).toBe(1);
  });

  it('counts both versions of the endpoints fixture, with a changed, a removed and an added function', () => {
    const read = (dir: string, name: string) => ({ files: [{ name, code: readFileSync(join(fixture, dir, name), 'utf8') }] });
    const report = precheck(read('output', 'main.c452f02c.js'), read('output-v2', 'main.dfc64017.js'));
    expect(report.all).toEqual({ total: 36, exact: 19, fuzzy: 2, ambiguous: 14, unmatched: 1 });
    expect(report.sourceSink).toEqual({ total: 1, exact: 1, fuzzy: 0, ambiguous: 0, unmatched: 0 });
    expect(report.nextOnly).toBe(1);
    expect(kinds('function f(a) { return a.x }', 'function f(a) { return a.x }')).toEqual(['exact']);
  });

  it('runs as a script on two directories', () => {
    const out = execFileSync(process.execPath, [script, join(fixture, 'output'), join(fixture, 'output-v2'), '--json'], { encoding: 'utf8' });
    expect(JSON.parse(out)).toMatchObject({ base: { files: 1, functions: 36 }, next: { files: 1, functions: 36 }, all: { exact: 19 } });
    const text = execFileSync(process.execPath, [script, join(fixture, 'output'), join(fixture, 'output-v2')], { encoding: 'utf8' });
    expect(text).toContain('| すべて | 36 | 19 (52.8%) | 2 (5.6%) | 14 (38.9%) | 1 (2.8%) |');
  });
});
