/**
 * worker の中で使う、ファイルを範囲（unpack が切り出したモジュール）に分けた「値が 1 つに決まる変数」の表。
 * データフローは使わず、名前ごとに束縛の出所を数えるだけ（規約は ./index.ts）。
 *
 * 範囲: モジュールの範囲（raw のバイト位置）と、どのモジュールにも入らない部分（webpack のランタイムと、そこに埋め込まれた
 * エントリ）。minify ではモジュールごとに短い名前を使い回すので、名前は範囲ごとに数える。
 * 変数の値が決まるのは、その範囲でその名前の値の出所が 1 つだけ（初期化つきの宣言 1 つか、初期化の無い宣言への代入 1 つ）で、
 * 関数の引数・関数名・catch・for-in/of・分割代入・+= や ++ などの別の束縛が 1 つも無いとき。
 */
import type { Node } from '@babel/types';
import { toCharOffsets, walk } from './shared.ts';

/** どのモジュールにも入らない部分 */
export const OUTSIDE = -1;

export interface ByteRange {
  start: number;
  end: number;
}

/** 文字位置 → 範囲の番号 */
export class Scopes {
  readonly #ranges: { start: number; end: number; index: number }[];

  constructor(bytes: Uint8Array, modules: ByteRange[]) {
    const chars = toCharOffsets(
      bytes,
      modules.flatMap((m) => [m.start, m.end]),
    );
    this.#ranges = modules
      .map((m, index) => ({ start: chars.get(m.start)!, end: chars.get(m.end)!, index }))
      .sort((a, b) => a.start - b.start);
  }

  of(pos: number): number {
    let lo = 0;
    let hi = this.#ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = this.#ranges[mid]!;
      if (pos < r.start) hi = mid - 1;
      else if (pos >= r.end) lo = mid + 1;
      else return r.index;
    }
    return OUTSIDE;
  }
}

interface Sources {
  values: Node[];
  blocked: boolean;
}

/** 範囲ごとの「名前 → 値の式」。値が 1 つに決まる名前だけを持つ */
export class Bindings {
  readonly #byScope = new Map<number, Map<string, Node>>();

  constructor(root: Node, scopes: Scopes) {
    const sources = new Map<number, Map<string, Sources>>();
    const at = (n: Node, name: string): Sources => {
      const scope = scopes.of(n.start ?? 0);
      let names = sources.get(scope);
      if (!names) sources.set(scope, (names = new Map()));
      let s = names.get(name);
      if (!s) names.set(name, (s = { values: [], blocked: false }));
      return s;
    };
    const block = (n: Node, pattern: Node | null | undefined): void => {
      for (const name of patternNames(pattern)) at(n, name).blocked = true;
    };

    walk(root, (n) => {
      switch (n.type) {
        case 'VariableDeclarator':
          if (n.id.type === 'Identifier') {
            if (n.init) at(n, n.id.name).values.push(n.init);
          } else block(n, n.id);
          break;
        case 'AssignmentExpression':
          if (n.left.type === 'Identifier' && n.operator === '=') at(n, n.left.name).values.push(n.right);
          else block(n, n.left);
          break;
        case 'UpdateExpression':
          block(n, n.argument);
          break;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'ObjectMethod':
        case 'ClassMethod':
        case 'ClassPrivateMethod':
          if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression') && n.id) block(n, n.id);
          for (const p of n.params) block(n, p as Node);
          break;
        case 'ClassDeclaration':
        case 'ClassExpression':
          if (n.id) block(n, n.id);
          break;
        case 'CatchClause':
          block(n, n.param);
          break;
        case 'ForInStatement':
        case 'ForOfStatement':
          if (n.left.type === 'VariableDeclaration') for (const d of n.left.declarations) block(n, d.id);
          else block(n, n.left);
          break;
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
          block(n, n.local);
          break;
        default:
          break;
      }
    });

    for (const [scope, names] of sources) {
      const resolved = new Map<string, Node>();
      for (const [name, s] of names) if (!s.blocked && s.values.length === 1) resolved.set(name, s.values[0]!);
      this.#byScope.set(scope, resolved);
    }
  }

  /** 範囲 scope での name の値の式（決まらなければ undefined） */
  get(scope: number, name: string): Node | undefined {
    return this.#byScope.get(scope)?.get(name);
  }
}

/** 分割代入・引数の形から名前を集める */
function patternNames(p: Node | null | undefined): string[] {
  if (!p) return [];
  switch (p.type) {
    case 'Identifier':
      return [p.name];
    case 'AssignmentPattern':
      return patternNames(p.left);
    case 'RestElement':
      return patternNames(p.argument);
    case 'ArrayPattern':
      return p.elements.flatMap((e) => patternNames(e));
    case 'ObjectPattern':
      return p.properties.flatMap((q) => patternNames(q.type === 'RestElement' ? q : (q.value as Node)));
    case 'TSParameterProperty':
      return patternNames(p.parameter);
    default:
      return [];
  }
}
