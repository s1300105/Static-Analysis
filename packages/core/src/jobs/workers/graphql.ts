/**
 * GraphQL の operation の抽出（design.md §7.3 extract_endpoints の 3）。endpoints.worker.ts がパースした AST を受けて、
 * graphql-js で本文を読む。worker の中で動く（規約は ./index.ts）。
 *
 * - graphql_text: テンプレートリテラル（gql`...` のタグの名前は minify で変わるので問わない）・文字列・変換後のタグ付き
 *   テンプレート（_taggedTemplateLiteral(["...", "..."]) の文字列の配列）のうち、先頭が query / mutation / subscription /
 *   fragment で graphql-js が読めるもの。埋め込み（${...}）は除いて読む（fragment を後ろに足す形が普通）。
 *   名前の無い { ... } の形は、タグの名前が gql / graphql のときだけ
 * - graphql_ast: ビルド時に変換された DocumentNode のオブジェクトリテラル（kind: "Document"）。loc.source.body があれば
 *   それを読み、無ければ definitions を静的に評価して OperationDefinition を取り出す
 * - relay: Relay の生成物（params に name と operationKind を持つオブジェクト）。params.text があれば読み、無ければ
 *   fragment / operation の argumentDefinitions から変数名を取る。params.id（persisted query の id）を持つ
 * 生成物と DocumentNode の中の文字列は、それぞれの抽出器の結果として数え、graphql_text では重ねて数えない。
 */
import type { Node, ObjectExpression } from '@babel/types';
import { parse, type DocumentNode } from 'graphql';
import type { Bindings, Scopes } from './bindings.ts';
import { walk } from './shared.ts';

export type GraphqlExtractor = 'graphql_text' | 'graphql_ast' | 'relay';

export interface GraphqlFound {
  extractor: GraphqlExtractor;
  /** operation 名。無名は '' */
  name: string;
  /** query / mutation / subscription */
  kind: string;
  variables: string[];
  /** persisted query の id（Relay の params.id） */
  persistedId: string | null;
  /** 見つけた式の文字位置（UTF-16） */
  start: number;
  end: number;
}

const DOCUMENT_START_RE = /^\s*(?:#[^\n]*\n\s*)*(?:query|mutation|subscription|fragment)\b/;
const SHORTHAND_START_RE = /^\s*\{/;
const GQL_TAGS = new Set(['gql', 'graphql']);
/** これより長い文字列は GraphQL として読まない（巨大な埋め込みデータを避ける） */
const MAX_TEXT = 512 * 1024;
const UNKNOWN: unique symbol = Symbol('unknown');
type Value = unknown;

interface Operation {
  name: string;
  kind: string;
  variables: string[];
}

export function extractGraphql(root: Node, scopes: Scopes, bindings: Bindings): GraphqlFound[] {
  const found: GraphqlFound[] = [];
  /** 生成物・DocumentNode の範囲（中の文字列を graphql_text で重ねて数えない） */
  const claimed: { start: number; end: number }[] = [];
  const texts: { text: string; start: number; end: number; tagged: boolean }[] = [];
  // GraphQL の文書の始まり方をしているものだけを候補に残す（大きなバンドルは文字列が多い）
  const addText = (text: string, start: number, end: number, tagged: boolean): void => {
    if (text.length <= MAX_TEXT && (DOCUMENT_START_RE.test(text) || (tagged && SHORTHAND_START_RE.test(text)))) {
      texts.push({ text, start, end, tagged });
    }
  };

  walk(root, (n) => {
    if (n.type === 'ObjectExpression') {
      const scope = scopes.of(n.start!);
      const relay = relayOperation(n, scope, bindings);
      if (relay) {
        found.push({ extractor: 'relay', ...relay.op, persistedId: relay.persistedId, start: n.start!, end: n.end! });
        claimed.push({ start: n.start!, end: n.end! });
        return;
      }
      const doc = documentOperations(n, scope, bindings);
      if (doc) {
        for (const op of doc) found.push({ extractor: 'graphql_ast', ...op, persistedId: null, start: n.start!, end: n.end! });
        claimed.push({ start: n.start!, end: n.end! });
      }
      return;
    }
    if (n.type === 'TaggedTemplateExpression') {
      const tag = n.tag.type === 'Identifier' ? n.tag.name : n.tag.type === 'MemberExpression' && !n.tag.computed && n.tag.property.type === 'Identifier' ? n.tag.property.name : '';
      addText(templateText(n.quasi), n.start!, n.end!, GQL_TAGS.has(tag));
      return;
    }
    if (n.type === 'TemplateLiteral') {
      addText(templateText(n), n.start!, n.end!, false);
      return;
    }
    if (n.type === 'StringLiteral') {
      addText(n.value, n.start!, n.end!, false);
      return;
    }
    // 変換後のタグ付きテンプレート: 文字列だけの配列を 1 つの本文として読む
    if (
      n.type === 'ArrayExpression' &&
      n.elements.length >= 2 &&
      n.elements[0]?.type === 'StringLiteral' &&
      DOCUMENT_START_RE.test(n.elements[0].value) &&
      n.elements.every((e) => e?.type === 'StringLiteral')
    ) {
      addText(n.elements.map((e) => (e as { value: string }).value).join(''), n.start!, n.end!, false);
    }
  });

  // 外側から読む（配列としてまとめて読めたら、その要素の文字列は数えない。タグ付きテンプレートの中のテンプレートも同じ）
  texts.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const covered: { start: number; end: number }[] = [];
  const inside = (ranges: { start: number; end: number }[], s: number, e: number) => ranges.some((r) => r.start <= s && e <= r.end);
  const textFound: GraphqlFound[] = [];
  for (const t of texts) {
    if (inside(claimed, t.start, t.end) || inside(covered, t.start, t.end)) continue;
    const ops = operationsInText(t.text, t.tagged);
    if (!ops) continue;
    covered.push({ start: t.start, end: t.end });
    for (const op of ops) textFound.push({ extractor: 'graphql_text', ...op, persistedId: null, start: t.start, end: t.end });
  }
  return [...found, ...textFound].sort((a, b) => a.start - b.start || a.end - b.end || a.name.localeCompare(b.name));
}

/** GraphQL の文書として読めれば operation の並び（fragment だけなら空）。読めなければ undefined */
function operationsInText(text: string, tagged: boolean): Operation[] | undefined {
  if (text.length > MAX_TEXT) return undefined;
  if (!DOCUMENT_START_RE.test(text) && !(tagged && SHORTHAND_START_RE.test(text))) return undefined;
  let doc: DocumentNode;
  try {
    doc = parse(text, { noLocation: true });
  } catch {
    return undefined;
  }
  return operationsOf(doc.definitions as unknown[]);
}

/** DocumentNode（またはそれを評価した値）の definitions から operation を取り出す */
function operationsOf(definitions: unknown[]): Operation[] {
  const ops: Operation[] = [];
  for (const d of definitions) {
    const def = d as {
      kind?: unknown;
      operation?: unknown;
      name?: { value?: unknown };
      variableDefinitions?: { variable?: { name?: { value?: unknown } } }[];
    };
    if (def?.kind !== 'OperationDefinition' || typeof def.operation !== 'string') continue;
    ops.push({
      name: typeof def.name?.value === 'string' ? def.name.value : '',
      kind: def.operation,
      variables: (Array.isArray(def.variableDefinitions) ? def.variableDefinitions : [])
        .map((v) => v?.variable?.name?.value)
        .filter((v): v is string => typeof v === 'string'),
    });
  }
  return ops;
}

/** kind: "Document" のオブジェクトリテラルなら、その operation（fragment だけなら空） */
function documentOperations(n: ObjectExpression, scope: number, bindings: Bindings): Operation[] | undefined {
  if (literalProp(n, 'kind', scope, bindings) !== 'Document' || !prop(n, 'definitions')) return undefined;
  const loc = evaluate(prop(n, 'loc'), scope, bindings);
  const body = (loc as { source?: { body?: unknown } } | undefined)?.source?.body;
  if (typeof body === 'string') {
    const ops = operationsInText(body, true);
    if (ops) return ops;
  }
  const definitions = evaluate(prop(n, 'definitions'), scope, bindings);
  return Array.isArray(definitions) ? operationsOf(definitions) : [];
}

/** Relay の生成物（params に name と operationKind）なら、その operation と persisted query の id */
function relayOperation(
  n: ObjectExpression,
  scope: number,
  bindings: Bindings,
): { op: Operation; persistedId: string | null } | undefined {
  const paramsNode = prop(n, 'params');
  if (paramsNode?.type !== 'ObjectExpression') return undefined;
  const name = literalProp(paramsNode, 'name', scope, bindings);
  const kind = literalProp(paramsNode, 'operationKind', scope, bindings);
  if (typeof name !== 'string' || typeof kind !== 'string') return undefined;
  const id = literalProp(paramsNode, 'id', scope, bindings);
  const persistedId = typeof id === 'string' && id !== '' ? id : null;

  const text = literalProp(paramsNode, 'text', scope, bindings);
  if (typeof text === 'string') {
    const op = operationsInText(text, true)?.find((o) => o.name === name);
    if (op) return { op, persistedId };
  }
  // text が無い（persisted query）: 引数の定義から変数名を取る
  let variables: string[] = [];
  for (const key of ['fragment', 'operation']) {
    const v = evaluate(prop(n, key), scope, bindings) as { argumentDefinitions?: unknown } | undefined;
    if (Array.isArray(v?.argumentDefinitions)) {
      variables = v.argumentDefinitions.map((a) => (a as { name?: unknown })?.name).filter((x): x is string => typeof x === 'string');
      break;
    }
  }
  return { op: { name, kind, variables }, persistedId };
}

function templateText(t: Node): string {
  return t.type === 'TemplateLiteral' ? t.quasis.map((q) => q.value.cooked ?? q.value.raw).join('') : '';
}

function prop(o: ObjectExpression, key: string): Node | undefined {
  for (const p of o.properties) {
    if (p.type !== 'ObjectProperty' || p.computed) continue;
    const k = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : undefined;
    if (k === key) return p.value as Node;
  }
  return undefined;
}

function literalProp(o: ObjectExpression, key: string, scope: number, bindings: Bindings): Value {
  const v = evaluate(prop(o, key), scope, bindings);
  return v === UNKNOWN ? undefined : v;
}

/**
 * 式を静的に評価する（リテラル・配列・オブジェクト・!0 / void 0・代入式・カンマ式・[...].concat(...)・値の決まる変数）。
 * 評価できない部分は UNKNOWN（配列の要素・オブジェクトの値としては残す。使う側が形を確かめる）
 */
function evaluate(n: Node | null | undefined, scope: number, bindings: Bindings, depth = 0, seen = new Set<Node>()): Value {
  if (!n || depth > 64) return UNKNOWN;
  const ev = (x: Node | null | undefined) => evaluate(x, scope, bindings, depth + 1, seen);
  switch (n.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return n.value;
    case 'NullLiteral':
      return null;
    case 'TemplateLiteral':
      return n.expressions.length === 0 ? (n.quasis[0]?.value.cooked ?? UNKNOWN) : UNKNOWN;
    case 'UnaryExpression': {
      if (n.operator === 'void') return undefined;
      const v = ev(n.argument);
      if (v === UNKNOWN) return UNKNOWN;
      if (n.operator === '!') return !v;
      if (n.operator === '-' && typeof v === 'number') return -v;
      return UNKNOWN;
    }
    case 'ArrayExpression':
      return n.elements.flatMap((e) => {
        if (e === null) return [undefined];
        if (e.type === 'SpreadElement') {
          const v = ev(e.argument);
          return Array.isArray(v) ? v : [];
        }
        return [ev(e)];
      });
    case 'ObjectExpression': {
      const out: Record<string, Value> = {};
      for (const p of n.properties) {
        if (p.type === 'SpreadElement') {
          const v = ev(p.argument);
          if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v);
          continue;
        }
        if (p.type !== 'ObjectProperty' || p.computed) continue;
        const k = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : undefined;
        if (k !== undefined) out[k] = ev(p.value as Node);
      }
      return out;
    }
    case 'Identifier': {
      if (n.name === 'undefined') return undefined;
      const init = bindings.get(scope, n.name);
      if (!init || seen.has(init)) return UNKNOWN;
      seen.add(init);
      const v = ev(init);
      seen.delete(init);
      return v;
    }
    case 'AssignmentExpression':
      return n.operator === '=' ? ev(n.right) : UNKNOWN;
    case 'SequenceExpression':
      return ev(n.expressions[n.expressions.length - 1]);
    case 'CallExpression': {
      // [...].concat(a, b): 評価できた配列だけをつなぐ（他の文書の fragment を足す形）
      const callee = n.callee;
      if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier' || callee.property.name !== 'concat') {
        return UNKNOWN;
      }
      const base = ev(callee.object);
      if (!Array.isArray(base)) return UNKNOWN;
      return base.concat(...n.arguments.map((a) => ev(a as Node)).filter((v) => Array.isArray(v)));
    }
    default:
      return UNKNOWN;
  }
}
