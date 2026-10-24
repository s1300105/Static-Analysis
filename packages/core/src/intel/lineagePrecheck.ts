/**
 * 手順6（関数同一性による事実の引き継ぎ）の前提確認（計画書 M2・design.md §12 手順2）: 実デプロイの 2 つの版で、
 * 関数の対応が exact / fuzzy / ambiguous / 不一致にどれだけ分かれるかを、source・sink を含む関数について特に数える。
 * index_functions（M3）の本実装の前に、norm_hash の簡易版で見通しを立てるためのもの。DB は使わない。
 *
 * 簡易版の norm_hash（design.md §6.1・§9 の関数同一性の規則に沿う）:
 * - 識別子は関数の中で最初に現れた順の番号に置き換える（minify の改名に依らない）。プロパティ名・文字列・数値は残す
 * - 入れ子の関数の本体はプレースホルダにする（外側の関数のハッシュが内側の変更で変わらない）
 * - 表記の差を少し吸収する: !0 → true、!1 → false、void 0 → undefined（undefined という名前の参照と同じにする）
 * - anchors: 文字列リテラル・プロパティ名・呼び出す API 名（minify で変わらない手掛かり）
 * 対応: norm_hash＋anchors が両方の版で一意なら exact、どちらかで重なれば ambiguous。残りを、トークンの shingle の Jaccard 係数
 * （MinHash で候補を絞る）が閾値以上のものから 1:1 で fuzzy にする。残りが不一致。
 * sourcemap による対応（match_kind=sourcemap）と、外側の関数を手掛かりにした第 2 パスは本実装で足す。
 *
 * scripts/lineage-precheck.ts から Node の型除去でそのまま読むので、sa-core の他のモジュールは import しない。
 */
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';

export interface FunctionInfo {
  /** ファイル名と開始位置（表示用） */
  where: string;
  normHash: string;
  anchors: string[];
  /** 正規化したトークンの数 */
  size: number;
  /** source か sink に当たる名前を含む */
  sourceSink: boolean;
  /** 類似度に使う shingle */
  shingles: Set<string>;
}

export type MatchKind = 'exact' | 'ambiguous' | 'fuzzy' | 'unmatched';

export interface Counts {
  total: number;
  exact: number;
  ambiguous: number;
  fuzzy: number;
  unmatched: number;
}

export interface PrecheckReport {
  base: { files: number; parseFailed: string[]; functions: number };
  next: { files: number; parseFailed: string[]; functions: number };
  /** base の関数がどう対応したか */
  all: Counts;
  /** source・sink を含む base の関数 */
  sourceSink: Counts;
  /** next にだけある（どれにも対応しなかった）関数の数 */
  nextOnly: number;
  fuzzyThreshold: number;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);
const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments']);
/** source・sink の手掛かりになる名前（design.md §3.1 の source / sink 種別の代表） */
const SOURCE_SINK = new Set([
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'write',
  'writeln',
  'srcdoc',
  'eval',
  'setTimeout',
  'setInterval',
  'Function',
  'createContextualFragment',
  'postMessage',
  'message',
  'hash',
  'search',
  'href',
  'referrer',
  'cookie',
  'localStorage',
  'sessionStorage',
  'getItem',
  'name',
]);
const SHINGLE = 5;
const MINHASH = 32;
const BAND = 4;
export const DEFAULT_FUZZY_THRESHOLD = 0.8;

/** JS の関数を正規化して並べる。パースできなければ投げる */
export function functionsOf(code: string, file: string): FunctionInfo[] {
  const ast = parse(code, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: false });
  const out: FunctionInfo[] = [];
  const visit = (n: Node): void => {
    if (FUNCTION_TYPES.has(n.type)) out.push(describe(n, file));
    for (const child of children(n)) visit(child);
  };
  visit(ast.program);
  return out;
}

function describe(fn: Node, file: string): FunctionInfo {
  const tokens: string[] = [];
  const anchors = new Set<string>();
  const names = new Map<string, number>();
  const ident = (name: string) => {
    if (!names.has(name)) names.set(name, names.size);
    return `$${names.get(name)}`;
  };
  const emit = (n: Node, parent: Node | undefined, key: string): void => {
    if (n !== fn && FUNCTION_TYPES.has(n.type)) {
      tokens.push('FN');
      return;
    }
    switch (n.type) {
      case 'Identifier': {
        const property =
          (key === 'property' && (parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression') && !(parent as { computed: boolean }).computed) ||
          (key === 'key' && parent !== undefined && 'computed' in parent && !(parent as { computed: boolean }).computed);
        if (property) {
          tokens.push(`.${n.name}`);
          anchors.add(n.name);
        } else if (n.name === 'undefined') tokens.push('undefined');
        else tokens.push(ident(n.name));
        return;
      }
      case 'StringLiteral':
        tokens.push(JSON.stringify(n.value));
        anchors.add(n.value);
        return;
      case 'NumericLiteral':
        tokens.push(String(n.value));
        return;
      case 'BooleanLiteral':
        tokens.push(String(n.value));
        return;
      case 'NullLiteral':
        tokens.push('null');
        return;
      case 'UnaryExpression':
        if (n.operator === '!' && n.argument.type === 'NumericLiteral') {
          tokens.push(n.argument.value === 0 ? 'true' : 'false');
          return;
        }
        if (n.operator === 'void' && n.argument.type === 'NumericLiteral') {
          tokens.push('undefined');
          return;
        }
        break;
      case 'CallExpression':
      case 'NewExpression': {
        // 呼び出す API 名（x.foo() の foo、foo() の foo は改名されうるので取らない）
        const callee = n.callee;
        if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') && !callee.computed && callee.property.type === 'Identifier') {
          anchors.add(callee.property.name);
        }
        if (n.type === 'NewExpression' && callee.type === 'Identifier') anchors.add(callee.name);
        break;
      }
      default:
        break;
    }
    tokens.push(n.type);
    for (const [k, v] of Object.entries(n)) {
      if (SKIP_KEYS.has(k)) continue;
      if (typeof v === 'string' || typeof v === 'boolean') tokens.push(`${k}=${v}`);
      else if (Array.isArray(v)) {
        tokens.push(`[${k}`);
        for (const x of v) if (isNode(x)) emit(x, n, k);
        tokens.push(']');
      } else if (isNode(v)) emit(v, n, k);
    }
  };
  emit(fn, undefined, '');
  const sortedAnchors = [...anchors].sort();
  const shingles = new Set<string>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) shingles.add(tokens.slice(i, i + SHINGLE).join(' '));
  if (shingles.size === 0) shingles.add(tokens.join(' '));
  return {
    where: `${file}:${fn.start ?? 0}`,
    normHash: createHash('sha256').update(tokens.join('\u0000')).digest('hex'),
    anchors: sortedAnchors,
    size: tokens.length,
    sourceSink: sortedAnchors.some((a) => SOURCE_SINK.has(a)),
    shingles,
  };
}

/** base の関数ごとの対応の種類と、next にだけある関数の数 */
export function matchFunctions(
  base: FunctionInfo[],
  next: FunctionInfo[],
  threshold = DEFAULT_FUZZY_THRESHOLD,
): { kinds: MatchKind[]; nextOnly: number } {
  const keyOf = (f: FunctionInfo) => `${f.normHash}:${f.anchors.join('\u0001')}`;
  const count = (fs: FunctionInfo[]) => {
    const m = new Map<string, number>();
    for (const f of fs) m.set(keyOf(f), (m.get(keyOf(f)) ?? 0) + 1);
    return m;
  };
  const inBase = count(base);
  const inNext = count(next);
  const kinds: MatchKind[] = base.map((f) => {
    const k = keyOf(f);
    const n = inNext.get(k) ?? 0;
    if (n === 0) return 'unmatched';
    return n === 1 && inBase.get(k) === 1 ? 'exact' : 'ambiguous';
  });
  const nextTaken = next.map((f) => (inBase.get(keyOf(f)) ?? 0) > 0);

  // fuzzy: 残りを MinHash の帯で候補にし、Jaccard 係数の高い組から 1:1 で決める
  const restBase = base.map((_, i) => i).filter((i) => kinds[i] === 'unmatched');
  const restNext = next.map((_, j) => j).filter((j) => !nextTaken[j]);
  const buckets = new Map<string, number[]>();
  for (const j of restNext) for (const b of bands(next[j]!.shingles)) buckets.set(b, [...(buckets.get(b) ?? []), j]);
  const pairs: { i: number; j: number; s: number }[] = [];
  for (const i of restBase) {
    const candidates = new Set<number>();
    for (const b of bands(base[i]!.shingles)) for (const j of buckets.get(b) ?? []) candidates.add(j);
    for (const j of candidates) {
      const s = jaccard(base[i]!.shingles, next[j]!.shingles);
      if (s >= threshold) pairs.push({ i, j, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  const usedBase = new Set<number>();
  const usedNext = new Set<number>();
  for (const p of pairs) {
    if (usedBase.has(p.i) || usedNext.has(p.j)) continue;
    usedBase.add(p.i);
    usedNext.add(p.j);
    kinds[p.i] = 'fuzzy';
  }
  return { kinds, nextOnly: restNext.filter((j) => !usedNext.has(j)).length };
}

export function precheck(
  base: { files: { name: string; code: string }[] },
  next: { files: { name: string; code: string }[] },
  threshold = DEFAULT_FUZZY_THRESHOLD,
): PrecheckReport {
  const read = (v: { files: { name: string; code: string }[] }) => {
    const parseFailed: string[] = [];
    const fns: FunctionInfo[] = [];
    for (const f of v.files) {
      try {
        fns.push(...functionsOf(f.code, f.name));
      } catch {
        parseFailed.push(f.name);
      }
    }
    return { fns, parseFailed };
  };
  const a = read(base);
  const b = read(next);
  const { kinds, nextOnly } = matchFunctions(a.fns, b.fns, threshold);
  const counts = (pick: (i: number) => boolean): Counts => {
    const c: Counts = { total: 0, exact: 0, ambiguous: 0, fuzzy: 0, unmatched: 0 };
    kinds.forEach((k, i) => {
      if (!pick(i)) return;
      c.total++;
      c[k]++;
    });
    return c;
  };
  return {
    base: { files: base.files.length, parseFailed: a.parseFailed, functions: a.fns.length },
    next: { files: next.files.length, parseFailed: b.parseFailed, functions: b.fns.length },
    all: counts(() => true),
    sourceSink: counts((i) => a.fns[i]!.sourceSink),
    nextOnly,
    fuzzyThreshold: threshold,
  };
}

function bands(shingles: Set<string>): string[] {
  const mins = new Array<number>(MINHASH).fill(0xffffffff);
  for (const s of shingles) {
    for (let k = 0; k < MINHASH; k++) {
      const h = fnv1a(s, k);
      if (h < mins[k]!) mins[k] = h;
    }
  }
  const out: string[] = [];
  for (let b = 0; b < MINHASH; b += BAND) out.push(`${b}:${mins.slice(b, b + BAND).join(',')}`);
  return out;
}

function fnv1a(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

function children(n: Node): Node[] {
  const out: Node[] = [];
  for (const [k, v] of Object.entries(n)) {
    if (SKIP_KEYS.has(k)) continue;
    if (Array.isArray(v)) for (const x of v) if (isNode(x)) out.push(x);
    if (isNode(v)) out.push(v);
  }
  return out;
}
