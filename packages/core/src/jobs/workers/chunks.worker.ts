/**
 * find_missing_chunks の参照の収集（design.md §7.1）。raw の JS を Babel でパースし、まだ取得していないかもしれない
 * ファイルへの参照を集める。URL の解決と取得済みかの判定は sa-core（artifact/chunks.ts）が版全体で行う。
 * worker 側の規約は ./index.ts を参照。
 *
 * 集めるもの:
 * - webpack 5 のランタイム: `X.u = e => ... + {id: hash}[e] + ".js"`（チャンク ID → ファイル名の組み立て方）と
 *   `X.p = "..."`（公開パス。式なら auto = スクリプト自身の場所）
 * - チャンク ID の参照: `X.e(id)`（非同期チャンク）、`X.O(void 0, [id, ...], ...)`（起動時に要るチャンク。HTML が読む）
 * - 動的 import の文字列 `import("...")` と `new URL("...", import.meta.url)`（.js / .mjs / .cjs / .wasm だけ）
 * - コメント: `//# sourceMappingURL=...`（data: は除く）と `/*! For license information please see ... *\/`
 */
import { parse } from '@babel/parser';
import type { Node } from '@babel/types';
import { skip, toByteOffsets, walk } from './shared.ts';

export interface ChunksInput {
  /** raw の JS（UTF-8） */
  bytes: Uint8Array;
}

/** ファイル名の組み立て方の部品: 文字列・チャンク ID そのもの・ID から引く表（無ければ ID に戻すか、組み立てられない） */
export type TemplatePart = { lit: string } | { id: true } | { map: Record<string, string>; fallbackToId: boolean };

export interface ByteSpan {
  startByte: number;
  endByte: number;
}

export interface ChunkTemplate extends ByteSpan {
  parts: TemplatePart[];
  /** 公開パス（X.p の文字列）。式（auto）か見つからなければ null */
  publicPath: string | null;
}

export interface ChunkIdRef extends ByteSpan {
  id: string;
  /** async: X.e(id)、startup: X.O の起動時の依存 */
  via: 'async' | 'startup';
}

export interface FileRef extends ByteSpan {
  kind: 'import' | 'url' | 'sourcemap' | 'license';
  /** 書かれたままの URL（相対のこともある） */
  value: string;
}

export interface ChunksOutput {
  templates: ChunkTemplate[];
  chunkIds: ChunkIdRef[];
  refs: FileRef[];
}

const CODE_URL_RE = /\.(m?js|cjs|wasm)(?:[?#].*)?$/i;

export default function collectChunkRefs(input: ChunksInput): ChunksOutput {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes);
  } catch {
    throw skip('parse_failed', 'not valid UTF-8');
  }
  let file;
  try {
    file = parse(text, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });
  } catch (err) {
    throw skip('parse_failed', err instanceof Error ? err.message : String(err));
  }

  type At = { start: number; end: number };
  const templates: (Omit<ChunkTemplate, 'startByte' | 'endByte' | 'publicPath'> & At & { owner: string })[] = [];
  const publicPaths = new Map<string, string | null>();
  const chunkIds: (Omit<ChunkIdRef, 'startByte' | 'endByte'> & At)[] = [];
  const refs: (Omit<FileRef, 'startByte' | 'endByte'> & At)[] = [];

  walk(file.program, (n) => {
    // X.u = e => ... / X.p = "..."
    if (n.type === 'AssignmentExpression' && n.operator === '=' && n.left.type === 'MemberExpression' && !n.left.computed) {
      const owner = n.left.object.type === 'Identifier' ? n.left.object.name : undefined;
      const prop = n.left.property.type === 'Identifier' ? n.left.property.name : undefined;
      if (owner !== undefined && prop === 'u') {
        const parts = filenameTemplate(n.right);
        if (parts) templates.push({ parts, owner, start: n.start!, end: n.end! });
      }
      if (owner !== undefined && prop === 'p') publicPaths.set(owner, n.right.type === 'StringLiteral' ? n.right.value : null);
      return;
    }
    if (n.type === 'CallExpression') {
      const callee = n.callee;
      const prop = callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : '';
      const objIsIdent = callee.type === 'MemberExpression' && callee.object.type === 'Identifier';
      // X.e(id)
      if (prop === 'e' && objIsIdent && n.arguments.length === 1) {
        const id = literalArg(n.arguments[0] as Node);
        if (id !== undefined) chunkIds.push({ id, via: 'async', start: n.start!, end: n.end! });
      }
      // X.O(void 0, [ids], fn)
      if (prop === 'O' && objIsIdent && n.arguments.length >= 2 && isUndefined(n.arguments[0] as Node) && n.arguments[1]?.type === 'ArrayExpression') {
        for (const el of n.arguments[1].elements) {
          const id = el ? literalArg(el as Node) : undefined;
          if (id !== undefined) chunkIds.push({ id, via: 'startup', start: el!.start!, end: el!.end! });
        }
      }
      // import("...")（Babel の古い形）
      if (callee.type === 'Import' && n.arguments[0]?.type === 'StringLiteral') {
        refs.push({ kind: 'import', value: n.arguments[0].value, start: n.start!, end: n.end! });
      }
      return;
    }
    if (n.type === 'ImportExpression' && n.source.type === 'StringLiteral') {
      refs.push({ kind: 'import', value: n.source.value, start: n.start!, end: n.end! });
      return;
    }
    // new URL("./worker.js", import.meta.url)
    if (
      n.type === 'NewExpression' &&
      n.callee.type === 'Identifier' &&
      n.callee.name === 'URL' &&
      n.arguments[0]?.type === 'StringLiteral' &&
      n.arguments[1]?.type === 'MemberExpression' &&
      n.arguments[1].object.type === 'MetaProperty' &&
      CODE_URL_RE.test(n.arguments[0].value)
    ) {
      refs.push({ kind: 'url', value: n.arguments[0].value, start: n.start!, end: n.end! });
    }
  });

  for (const c of file.comments ?? []) {
    const body = c.value.trim();
    const map = /^[#@]\s*sourceMappingURL=(\S+)/.exec(body);
    if (map && !map[1]!.startsWith('data:')) refs.push({ kind: 'sourcemap', value: map[1]!, start: c.start!, end: c.end! });
    const license = /^!?\s*For license information please see (\S+)/.exec(body);
    if (license) refs.push({ kind: 'license', value: license[1]!, start: c.start!, end: c.end! });
  }

  const offsets = toByteOffsets(text, [...templates, ...chunkIds, ...refs].flatMap((x) => [x.start, x.end]));
  const span = (x: At): ByteSpan => ({ startByte: offsets.get(x.start)!, endByte: offsets.get(x.end)! });
  const bySource = <T extends At>(xs: T[]) => [...xs].sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    templates: bySource(templates).map(({ parts, owner, ...at }) => ({ parts, publicPath: publicPaths.get(owner) ?? null, ...span(at) })),
    chunkIds: bySource(chunkIds).map(({ id, via, ...at }) => ({ id, via, ...span(at) })),
    refs: bySource(refs).map(({ kind, value, ...at }) => ({ kind, value, ...span(at) })),
  };
}

/** e => "..." + e + "." + {1: "abc"}[e] + ".js" の形を部品にする。ほかの形なら undefined */
function filenameTemplate(fn: Node): TemplatePart[] | undefined {
  if ((fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') || fn.params.length !== 1) return undefined;
  const [first] = fn.params;
  if (first?.type !== 'Identifier') return undefined;
  const param = first.name;
  let body: Node | null | undefined = fn.body;
  if (body.type === 'BlockStatement') {
    const [only] = body.body;
    body = body.body.length === 1 && only?.type === 'ReturnStatement' ? only.argument : undefined;
  }
  if (!body) return undefined;
  const parts: TemplatePart[] = [];
  const add = (x: Node): boolean => {
    if (x.type === 'BinaryExpression' && x.operator === '+') return add(x.left as Node) && add(x.right);
    if (x.type === 'StringLiteral') return parts.push({ lit: x.value }) > 0;
    if (x.type === 'TemplateLiteral') {
      for (const [i, q] of x.quasis.entries()) {
        parts.push({ lit: q.value.cooked ?? q.value.raw });
        const e = x.expressions[i];
        if (e && !add(e as Node)) return false;
      }
      return true;
    }
    if (x.type === 'Identifier' && x.name === param) return parts.push({ id: true }) > 0;
    const lookup = mapLookup(x, param);
    if (lookup) return parts.push({ map: lookup, fallbackToId: false }) > 0;
    // ({...}[e] || e)
    if (x.type === 'LogicalExpression' && x.operator === '||' && x.right.type === 'Identifier' && x.right.name === param) {
      const m = mapLookup(x.left, param);
      if (m) return parts.push({ map: m, fallbackToId: true }) > 0;
    }
    return false;
  };
  if (!add(body)) return undefined;
  // チャンク ID に依らない定数（チャンクが 1 つだけのとき webpack はこう畳む）も形としては受ける
  return parts.length > 0 ? parts : undefined;
}

/** {1: "a", 2: "b"}[param] なら表 */
function mapLookup(x: Node, param: string): Record<string, string> | undefined {
  if (x.type !== 'MemberExpression' || !x.computed || x.object.type !== 'ObjectExpression') return undefined;
  if (x.property.type !== 'Identifier' || x.property.name !== param) return undefined;
  const map: Record<string, string> = {};
  for (const p of x.object.properties) {
    if (p.type !== 'ObjectProperty' || p.computed) return undefined;
    const key = literalKey(p.key as Node);
    if (key === undefined || p.value.type !== 'StringLiteral') return undefined;
    map[key] = p.value.value;
  }
  return map;
}

/** オブジェクトのキー（{ 1: ..., admin: ... }） */
function literalKey(n: Node): string | undefined {
  return n.type === 'Identifier' ? n.name : literalArg(n);
}

/** 引数・配列の要素のチャンク ID（数値か文字列のリテラルだけ） */
function literalArg(n: Node): string | undefined {
  if (n.type === 'NumericLiteral') return String(n.value);
  if (n.type === 'StringLiteral') return n.value;
  return undefined;
}

function isUndefined(n: Node): boolean {
  return (n.type === 'UnaryExpression' && n.operator === 'void') || (n.type === 'Identifier' && n.name === 'undefined');
}
