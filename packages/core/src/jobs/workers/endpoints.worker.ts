/**
 * ast_url 抽出器（design.md §7.3 extract_endpoints の 2）。raw の JS をファイルごと Babel でパースし、
 * HTTP クライアントの呼び出しから URL・メソッド・パラメータ名を拾う。データフローは使わない。
 * 同じ AST から GraphQL の operation も拾う（./graphql.ts。パースを 1 回で済ませる）。
 * unpack が切り出したモジュールの範囲は「範囲」として受け取り、ベース URL と変数の値は範囲ごとに扱う（./bindings.ts）。
 * ファイルごと読むのは、webpack のランタイムに埋め込まれたエントリ（モジュールマップの外）も読むため。
 * worker 側の規約は ./index.ts を参照。
 *
 * 拾う呼び出し:
 * - fetch(url, opts) / new Request(url, opts)（opts の method・headers・body）
 * - x.get/post/put/patch/delete/head/options(url, data?, config?)（axios・jQuery・HttpClient などの形。メソッドは名前から）
 * - 設定オブジェクト: f({ url, method|type, params, data, headers }) / x.ajax(...) / x.request(...)（axios(config)・$.ajax）、
 *   $.ajax(url, settings)
 * - xhr.open(method, url)、navigator.sendBeacon(url)、new WebSocket(url)、new EventSource(url)
 * URL は文字列・テンプレートリテラル・"+" の連結・"...".concat(...)・同じ範囲で値が 1 つに決まる文字列の変数から組み立てる。
 * 可変部分は {name}（名前が 3 文字以上なら）か {}（minify された短い名前・複雑な式）にする。
 *
 * ベース URL（同じ範囲の単純な場合だけ）: `baseURL: "..."` の文字列か、`fetch("/api/v2" + path)` のように
 * 「"/" で終わらない文字列の直後に式が続く」URL（クライアントの送信部）を候補にし、候補が 1 つだけなら
 * メソッド名の呼び出し（api.get("/x") など）の相対 URL の前に付ける。後者の送信部自体はエンドポイントとして返さない。
 */
import { parse, parseExpression } from '@babel/parser';
import type { Expression, Node, ObjectExpression } from '@babel/types';
import { Bindings, type ByteRange, Scopes } from './bindings.ts';
import { type GraphqlExtractor, extractGraphql } from './graphql.ts';
import { skip, toByteOffsets, walk } from './shared.ts';

export interface EndpointsInput {
  /** raw の JS（UTF-8） */
  bytes: Uint8Array;
  /** unpack が切り出したモジュールの範囲（raw のバイト位置）。無ければファイル全体が 1 つの範囲 */
  modules?: ByteRange[];
  /** HTTP クライアントの呼び出しを拾う（ast_url。既定 true） */
  rest?: boolean;
  /** GraphQL の operation を拾う（./graphql.ts。既定 false） */
  graphql?: boolean;
}

export interface GraphqlOperation {
  extractor: GraphqlExtractor;
  /** operation 名。無名は '' */
  name: string;
  /** query / mutation / subscription */
  kind: string;
  variables: string[];
  /** persisted query の id（Relay の params.id） */
  persistedId: string | null;
  /** 見つけた式（テンプレート・文字列・DocumentNode・Relay の生成物）の raw のバイト範囲 */
  startByte: number;
  endByte: number;
}

export interface ExtractedParam {
  name: string;
  in: 'query' | 'body' | 'header';
}

export interface ExtractedCall {
  /** 可変部分を {name} / {} にした URL（normalizeEndpointUrl に渡す形） */
  url: string;
  /** 大文字。分からなければ '' */
  method: string;
  websocket: boolean;
  params: ExtractedParam[];
  /** どの形で拾ったか（fetch / method / config / xhr / beacon / websocket / eventsource） */
  via: string;
  /** 呼び出し式の raw のバイト範囲 */
  startByte: number;
  endByte: number;
}

export interface EndpointsOutput {
  calls: ExtractedCall[];
  /** 範囲ごとに推定できたベース URL（ソースの順） */
  bases: string[];
  graphql: GraphqlOperation[];
}

type Part = { lit: string } | { expr: string | undefined };

const METHOD_NAMES: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  del: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
  getJSON: 'GET',
};
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const BASE_KEYS = new Set(['baseURL', 'baseUrl', 'prefixUrl', 'apiBase', 'apiBaseUrl']);
const MIME_RE = /^(application|text|image|audio|video|multipart|font)\/[\w.+-]+$/i;

interface Candidate extends Omit<ExtractedCall, 'url' | 'startByte' | 'endByte'> {
  parts: Part[];
  start: number;
  end: number;
  scope: number;
}

/** 範囲 scope の中で値が文字列に決まる変数を引く */
type Constants = (name: string) => string | undefined;

export default function extractFromJs(input: EndpointsInput): EndpointsOutput {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes);
  } catch {
    throw skip('parse_failed', 'not valid UTF-8');
  }
  const root = parseModule(text);
  const scopes = new Scopes(input.bytes, input.modules ?? []);
  const bindings = new Bindings(root, scopes);
  const rest = input.rest !== false ? restCalls(root, scopes, bindings) : { candidates: [], bases: [] };
  const graphql = input.graphql === true ? extractGraphql(root, scopes, bindings) : [];

  const offsets = toByteOffsets(text, [...rest.candidates, ...graphql].flatMap((c) => [c.start, c.end]));
  const calls: ExtractedCall[] = [];
  const seen = new Set<string>();
  for (const c of rest.candidates) {
    const key = `${c.start}:${c.method}:${c.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { start, end, ...call } = c;
    calls.push({ ...call, startByte: offsets.get(start)!, endByte: offsets.get(end)! });
  }
  return {
    calls,
    bases: rest.bases,
    graphql: graphql.map(({ start, end, ...op }) => ({ ...op, startByte: offsets.get(start)!, endByte: offsets.get(end)! })),
  };
}

/** HTTP クライアントの呼び出し（URL は描画済み、位置は文字位置）とベース URL */
function restCalls(
  root: Node,
  scopes: Scopes,
  bindings: Bindings,
): { candidates: (Omit<ExtractedCall, 'startByte' | 'endByte'> & { start: number; end: number })[]; bases: string[] } {
  const constantsOf = (scope: number): Constants => (name) => literalString(bindings.get(scope, name));
  // 範囲ごとのベース URL の候補（最初に見つけた位置も持って、出力をソースの順にする）
  const baseCandidates = new Map<number, { values: Set<string>; at: number }>();
  const addBase = (scope: number, value: string, at: number): void => {
    const b = baseCandidates.get(scope) ?? { values: new Set<string>(), at };
    b.values.add(value);
    b.at = Math.min(b.at, at);
    baseCandidates.set(scope, b);
  };
  const candidates: Candidate[] = [];

  walk(root, (n) => {
    if (n.type === 'ObjectProperty' && !n.computed && BASE_KEYS.has(keyName(n.key) ?? '')) {
      const scope = scopes.of(n.start!);
      const v = literalUrl(n.value as Expression, constantsOf(scope));
      if (v !== undefined) addBase(scope, v, n.start!);
    }
    if (n.type !== 'CallExpression' && n.type !== 'NewExpression' && n.type !== 'OptionalCallExpression') return;
    const scope = scopes.of(n.start!);
    const c = recognize(n, constantsOf(scope), scope);
    if (!c) return;
    const base = basePrefix(c.parts);
    if (base !== undefined && c.via !== 'method') {
      addBase(scope, base, n.start!);
      return;
    }
    candidates.push(c);
  });

  // 候補が 1 つだけの範囲のベース URL
  const bases = new Map<number, { value: string; at: number }>();
  for (const [scope, b] of baseCandidates) if (b.values.size === 1) bases.set(scope, { value: [...b.values][0]!, at: b.at });
  // walk は順不同なので、ソースの順に並べる（出力を決定的にする）
  candidates.sort((a, b) => a.start - b.start || a.end - b.end);
  return {
    candidates: candidates.map(({ parts, scope, ...c }) => {
      let url = render(parts);
      const base = bases.get(scope)?.value;
      if (c.via === 'method' && base !== undefined && isPathRelative(url) && !url.startsWith(base)) {
        url = `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
      }
      return { ...c, url };
    }),
    bases: [...bases.values()].sort((a, b) => a.at - b.at).map((b) => b.value),
  };
}

/**
 * ファイル全体（ESM・境界の無い形式）はプログラムとして、webpack のファクトリ（function (e, t, n) { ... }）は式として読む。
 * どちらでも読めなければプログラムとしての誤りを返す
 */
function parseModule(text: string): Node {
  try {
    return parse(text, { sourceType: 'unambiguous', allowReturnOutsideFunction: true }).program;
  } catch (err) {
    try {
      return parseExpression(text, { sourceType: 'unambiguous' });
    } catch {
      throw skip('parse_failed', err instanceof Error ? err.message : String(err));
    }
  }
}

/** 呼び出しの形を見て、URL・メソッド・パラメータを取り出す */
function recognize(n: Node, constants: Constants, scope: number): Candidate | undefined {
  if (n.type !== 'CallExpression' && n.type !== 'NewExpression' && n.type !== 'OptionalCallExpression') return undefined;
  const args = n.arguments as Node[];
  const callee = n.callee as Node;
  const name = calleeName(callee);
  const prop = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression' ? memberName(callee) : undefined;
  const at = { start: n.start!, end: n.end!, scope };

  // new WebSocket(url) / new EventSource(url)
  if (n.type === 'NewExpression' && (name === 'WebSocket' || name === 'EventSource')) {
    const parts = urlParts(args[0], constants);
    if (!parts) return undefined;
    const ws = name === 'WebSocket';
    return { parts, method: ws ? '' : 'GET', websocket: ws, params: [], via: ws ? 'websocket' : 'eventsource', ...at };
  }

  // fetch(url, opts) / new Request(url, opts)
  if (name === 'fetch' || prop === 'fetch' || (n.type === 'NewExpression' && name === 'Request')) {
    const parts = urlParts(args[0], constants);
    if (!parts) return undefined;
    const opts = asObject(args[1]);
    const method = (opts && methodProp(opts, constants)) ?? 'GET';
    return { parts, method, websocket: false, params: opts ? optionParams(opts) : [], via: 'fetch', ...at };
  }

  // xhr.open(method, url)
  if (prop === 'open' && args.length >= 2) {
    const method = literalString(args[0])?.toUpperCase();
    if (method === undefined || !HTTP_METHODS.has(method)) return undefined;
    const parts = urlParts(args[1], constants);
    if (!parts) return undefined;
    return { parts, method, websocket: false, params: [], via: 'xhr', ...at };
  }

  // navigator.sendBeacon(url, data)
  if (prop === 'sendBeacon') {
    const parts = urlParts(args[0], constants);
    if (!parts) return undefined;
    return { parts, method: 'POST', websocket: false, params: [], via: 'beacon', ...at };
  }

  // $.ajax(url, settings?)
  if (prop === 'ajax' && args[0] && !asObject(args[0])) {
    const parts = urlParts(args[0], constants);
    if (!parts || !looksLikeUrl(render(parts))) return undefined;
    const settings = asObject(args[1]);
    const method = (settings && methodProp(settings, constants)) ?? 'GET';
    return { parts, method, websocket: false, params: settings ? optionParams(settings) : [], via: 'config', ...at };
  }

  // 設定オブジェクト: f({ url, ... }) / x.ajax({ ... }) / x.request({ ... })
  const config = asObject(args[0]);
  if (config && hasKey(config, 'url')) {
    const parts = urlParts(propValue(config, 'url'), constants);
    if (parts && (hasAnyKey(config, ['method', 'type', 'params', 'data', 'headers', 'body']) || prop === 'ajax' || prop === 'request')) {
      // axios(config)・$.ajax の既定は GET
      const method = methodProp(config, constants) ?? 'GET';
      return { parts, method, websocket: false, params: optionParams(config), via: 'config', ...at };
    }
  }

  // x.get(url, config) / x.post(url, data, config) …
  if (prop !== undefined && prop in METHOD_NAMES) {
    const parts = urlParts(args[0], constants);
    if (!parts || !looksLikeUrl(render(parts))) return undefined;
    const method = METHOD_NAMES[prop]!;
    const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
    const params: ExtractedParam[] = [];
    if (hasBody && args[1]) params.push(...bodyParams(args[1]));
    const config2 = asObject(args[hasBody ? 2 : 1]);
    if (config2) params.push(...optionParams(config2));
    return { parts, method, websocket: false, params, via: 'method', ...at };
  }
  return undefined;
}

/** opts / config の params・headers・body・data・json からパラメータ名を取る */
function optionParams(o: ObjectExpression): ExtractedParam[] {
  const out: ExtractedParam[] = [];
  const params = asObject(propValue(o, 'params'));
  if (params) for (const k of objectKeys(params)) out.push({ name: k, in: 'query' });
  const headers = asObject(propValue(o, 'headers'));
  if (headers) for (const k of objectKeys(headers)) out.push({ name: k, in: 'header' });
  for (const key of ['body', 'data', 'json']) {
    const v = propValue(o, key);
    if (v) out.push(...bodyParams(v));
  }
  return out;
}

/** 本文: オブジェクトリテラル・JSON.stringify({...})・new URLSearchParams({...}) のキー */
function bodyParams(n: Node): ExtractedParam[] {
  let obj = asObject(n);
  if (!obj && (n.type === 'CallExpression' || n.type === 'NewExpression')) {
    const name = calleeName(n.callee as Node);
    if (name === 'stringify' || name === 'URLSearchParams') obj = asObject(n.arguments[0] as Node);
  }
  return obj ? objectKeys(obj).map((name) => ({ name, in: 'body' as const })) : [];
}

/** URL の式を文字列と可変部分の並びにする。文字列の部分が 1 つも無ければ undefined */
function urlParts(n: Node | undefined, constants: Constants): Part[] | undefined {
  if (!n) return undefined;
  const parts: Part[] = [];
  const add = (x: Node): void => {
    if (x.type === 'StringLiteral') parts.push({ lit: x.value });
    else if (x.type === 'TemplateLiteral') {
      x.quasis.forEach((q, i) => {
        parts.push({ lit: q.value.cooked ?? q.value.raw });
        const e = x.expressions[i];
        if (e) add(e as Node);
      });
    } else if (x.type === 'BinaryExpression' && x.operator === '+') {
      add(x.left as Node);
      add(x.right as Node);
    } else if (
      x.type === 'CallExpression' &&
      x.callee.type === 'MemberExpression' &&
      memberName(x.callee) === 'concat' &&
      (x.callee.object.type === 'StringLiteral' || x.callee.object.type === 'TemplateLiteral')
    ) {
      add(x.callee.object);
      for (const a of x.arguments) add(a as Node);
    } else if (x.type === 'Identifier' && constants(x.name) !== undefined) parts.push({ lit: constants(x.name)! });
    else parts.push({ expr: exprName(x) });
  };
  add(n);
  const merged: Part[] = [];
  for (const p of parts) {
    const last = merged[merged.length - 1];
    if ('lit' in p && last && 'lit' in last) last.lit += p.lit;
    else if (!('lit' in p && p.lit === '')) merged.push({ ...p });
  }
  return merged.some((p) => 'lit' in p && p.lit.trim() !== '') ? merged : undefined;
}

/** "/api/v2" + path のように、"/" で終わらない文字列の直後に式が続く URL ならその文字列（ベース URL の候補） */
function basePrefix(parts: Part[]): string | undefined {
  const [first, second] = parts;
  if (!first || !('lit' in first) || !second || !('expr' in second)) return undefined;
  const lit = first.lit;
  if (lit.endsWith('/') || lit.includes('?') || !/^(https?:\/\/|\/)/.test(lit)) return undefined;
  return lit;
}

function render(parts: Part[]): string {
  return parts.map((p) => ('lit' in p ? p.lit : p.expr !== undefined ? `{${p.expr}}` : '{}')).join('');
}

function literalUrl(n: Expression, constants: Constants): string | undefined {
  const parts = urlParts(n as Node, constants);
  return parts && parts.length === 1 && 'lit' in parts[0]! ? parts[0].lit : undefined;
}

function looksLikeUrl(url: string): boolean {
  if (/\s/.test(url) || MIME_RE.test(url)) return false;
  return /^(https?:|wss?:|\/\/|\/|\.\.?\/|\{)/i.test(url) || url.includes('/');
}

function isPathRelative(url: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(url);
}

/** 可変部分の名前。minify された短い名前（1〜2 文字）は意味が無いので使わない */
function exprName(n: Node): string | undefined {
  const name = n.type === 'Identifier' ? n.name : n.type === 'MemberExpression' && !n.computed ? memberName(n) : undefined;
  return name !== undefined && name.length >= 3 ? name : undefined;
}

function calleeName(n: Node): string | undefined {
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') return memberName(n);
  // (0, x.fetch)(...) の形
  if (n.type === 'SequenceExpression') return calleeName(n.expressions[n.expressions.length - 1] as Node);
  return undefined;
}

function memberName(n: Node): string | undefined {
  if (n.type !== 'MemberExpression' && n.type !== 'OptionalMemberExpression') return undefined;
  if (!n.computed && n.property.type === 'Identifier') return n.property.name;
  if (n.computed && n.property.type === 'StringLiteral') return n.property.value;
  return undefined;
}

function asObject(n: Node | undefined): ObjectExpression | undefined {
  return n?.type === 'ObjectExpression' ? n : undefined;
}

function keyName(k: Node): string | undefined {
  if (k.type === 'Identifier') return k.name;
  if (k.type === 'StringLiteral') return k.value;
  if (k.type === 'NumericLiteral') return String(k.value);
  return undefined;
}

function objectKeys(o: ObjectExpression): string[] {
  const keys: string[] = [];
  for (const p of o.properties) {
    if ((p.type === 'ObjectProperty' || p.type === 'ObjectMethod') && !p.computed) {
      const k = keyName(p.key);
      if (k !== undefined && !keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

function propValue(o: ObjectExpression, key: string): Node | undefined {
  for (const p of o.properties) {
    if (p.type === 'ObjectProperty' && !p.computed && keyName(p.key) === key) return p.value as Node;
  }
  return undefined;
}

function hasKey(o: ObjectExpression, key: string): boolean {
  return propValue(o, key) !== undefined;
}

function hasAnyKey(o: ObjectExpression, keys: string[]): boolean {
  return keys.some((k) => hasKey(o, k));
}

/**
 * method（$.ajax は type）の値。キーが無ければ undefined（呼び出し側の既定）、文字列で無ければ ''（不明）。
 * type は他の意味（"json" など）にも使われるので、HTTP のメソッド名のときだけ使う
 */
function methodProp(o: ObjectExpression, constants: Constants): string | undefined {
  const value = (n: Node): string | undefined => literalString(n) ?? (n.type === 'Identifier' ? constants(n.name) : undefined);
  const m = propValue(o, 'method');
  if (m) return value(m)?.toUpperCase() ?? '';
  const t = propValue(o, 'type');
  const s = t && value(t)?.toUpperCase();
  return s !== undefined && HTTP_METHODS.has(s) ? s : undefined;
}

function literalString(n: Node | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}
