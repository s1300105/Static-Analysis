/**
 * GraphQL の operation の文書を、sighting の位置から読み直す（export_endpoints。design.md §7.3）。本文は DB に持たない。
 * - graphql_text: 位置の式（文字列・テンプレート・タグ付きテンプレート・文字列の配列）の本文を graphql-js で読む
 * - graphql_ast: DocumentNode のオブジェクトリテラル。loc.source.body があれば読み、無ければリテラルだけを評価して print する
 * - relay: params.text があれば読む。無ければ（persisted query）本文は無いので、名前・id・変数名をコメントで出す
 * fragment は、同じ版の GraphQL の文書のどこかに定義があれば足す（タグ付きテンプレートの ${...} で埋め込む形）。
 * 位置の式だけを読むので、変数を介した値は追わない（変数の値は extract_endpoints が抽出のときに使った）。
 */
import { parseExpression } from '@babel/parser';
import type { Node } from '@babel/types';
import { type DefinitionNode, type DocumentNode, type FragmentDefinitionNode, Kind, type OperationDefinitionNode, parse, print, visit } from 'graphql';

/** 読み直しに使う式の長さの上限（大きすぎる位置は読まない） */
const MAX_SNIPPET = 1024 * 1024;

export interface DocumentSource {
  extractedBy: 'graphql_text' | 'graphql_ast' | 'relay';
  /** 位置の範囲の中身（UTF-8） */
  snippet: Uint8Array;
}

/** 位置から GraphQL の定義（operation と fragment）を取り出す。読めなければ空 */
export function definitionsAt(src: DocumentSource): DefinitionNode[] {
  if (src.snippet.byteLength > MAX_SNIPPET) return [];
  let expr: Node;
  try {
    expr = parseExpression(Buffer.from(src.snippet).toString('utf8'), { sourceType: 'unambiguous' });
  } catch {
    return [];
  }
  if (src.extractedBy === 'graphql_text') return parseDefinitions(textOf(expr));
  if (expr.type !== 'ObjectExpression') return [];
  const value = literal(expr) as Record<string, unknown> | undefined;
  if (!value) return [];
  if (src.extractedBy === 'relay') {
    const text = (value.params as { text?: unknown } | undefined)?.text;
    return typeof text === 'string' ? parseDefinitions(text) : [];
  }
  const body = (value.loc as { source?: { body?: unknown } } | undefined)?.source?.body;
  if (typeof body === 'string') return parseDefinitions(body);
  const defs = Array.isArray(value.definitions) ? value.definitions : [];
  return defs.filter((d): d is DefinitionNode => isDefinition(d) && printable(d));
}

/** Relay の persisted query（本文が無い）なら、名前・id・変数名 */
export function persistedRelayAt(src: DocumentSource): { name: string; id: string | null; variables: string[] } | undefined {
  if (src.extractedBy !== 'relay' || src.snippet.byteLength > MAX_SNIPPET) return undefined;
  let expr: Node;
  try {
    expr = parseExpression(Buffer.from(src.snippet).toString('utf8'), { sourceType: 'unambiguous' });
  } catch {
    return undefined;
  }
  const value = (expr.type === 'ObjectExpression' ? literal(expr) : undefined) as
    | { params?: { name?: unknown; id?: unknown; text?: unknown }; fragment?: { argumentDefinitions?: unknown } }
    | undefined;
  const params = value?.params;
  if (typeof params?.name !== 'string' || typeof params.text === 'string') return undefined;
  const args = Array.isArray(value?.fragment?.argumentDefinitions) ? value.fragment.argumentDefinitions : [];
  return {
    name: params.name,
    id: typeof params.id === 'string' ? params.id : null,
    variables: args.map((a) => (a as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string'),
  };
}

/** operation の文書（operation と、使う fragment を推移的に足したもの）を print する */
export function printOperation(op: OperationDefinitionNode, fragments: Map<string, FragmentDefinitionNode>): { text: string; missingFragments: string[] } {
  const used: FragmentDefinitionNode[] = [];
  const missing = new Set<string>();
  const seen = new Set<string>();
  const queue: DefinitionNode[] = [op];
  while (queue.length > 0) {
    visit(queue.shift()!, {
      FragmentSpread(node) {
        const name = node.name.value;
        if (seen.has(name)) return;
        seen.add(name);
        const f = fragments.get(name);
        if (f) {
          used.push(f);
          queue.push(f);
        } else missing.add(name);
      },
    });
  }
  const doc: DocumentNode = { kind: Kind.DOCUMENT, definitions: [op, ...used] };
  return { text: print(doc), missingFragments: [...missing].sort() };
}

function parseDefinitions(text: string | undefined): DefinitionNode[] {
  if (text === undefined || text.length > MAX_SNIPPET) return [];
  try {
    return [...parse(text, { noLocation: true }).definitions];
  } catch {
    return [];
  }
}

/** 文字列・テンプレート（埋め込みは除く）・タグ付きテンプレート・文字列の配列の本文 */
function textOf(n: Node): string | undefined {
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral') return n.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
  if (n.type === 'TaggedTemplateExpression') return textOf(n.quasi);
  if (n.type === 'ArrayExpression' && n.elements.every((e) => e?.type === 'StringLiteral')) {
    return n.elements.map((e) => (e as { value: string }).value).join('');
  }
  return undefined;
}

/** リテラルだけでできた式の値（変数・呼び出しなどは undefined にする） */
function literal(n: Node | null | undefined): unknown {
  if (!n) return undefined;
  switch (n.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return n.value;
    case 'NullLiteral':
      return null;
    case 'TemplateLiteral':
      return n.expressions.length === 0 ? n.quasis[0]?.value.cooked : undefined;
    case 'UnaryExpression':
      if (n.operator === '!' && n.argument.type === 'NumericLiteral') return !n.argument.value;
      return undefined;
    case 'ArrayExpression':
      return n.elements.map((e) => (e && e.type !== 'SpreadElement' ? literal(e) : undefined));
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const p of n.properties) {
        if (p.type !== 'ObjectProperty' || p.computed) continue;
        const k = p.key.type === 'Identifier' ? p.key.name : p.key.type === 'StringLiteral' ? p.key.value : undefined;
        if (k !== undefined) out[k] = literal(p.value as Node);
      }
      return out;
    }
    case 'AssignmentExpression':
      return n.operator === '=' ? literal(n.right) : undefined;
    default:
      return undefined;
  }
}

function isDefinition(d: unknown): boolean {
  const kind = (d as { kind?: unknown } | null)?.kind;
  return kind === Kind.OPERATION_DEFINITION || kind === Kind.FRAGMENT_DEFINITION;
}

/** 評価したオブジェクトが print できる形か（読めない値が混じっていれば print は投げる） */
function printable(d: DefinitionNode): boolean {
  try {
    print(d);
    return true;
  } catch {
    return false;
  }
}
