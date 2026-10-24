/**
 * unpack worker: raw の JS をパースし、モジュール境界を raw のバイト範囲で返す（design.md §6.6 の unpacked 層）。
 * worker 側の規約（相対 import は ./shared.ts のように拡張子付きで同じ階層だけ・消せる型構文だけ）は ./index.ts を参照。
 *
 * 認識する形（webpack 5 の production 出力）:
 * - チャンク: (self.webpackChunkX = self.webpackChunkX || []).push([[<chunk ids>], { <id>: <factory>, ... }, <runtime>?])
 * - ランタイム（エントリ）: (() => { var m = { <id>: <factory>, ... }; function r(id) { ... m[id](...) ... } ... })()
 * どちらも、ファクトリ関数の本体（波括弧の内側）を 1 モジュールとする。コードは書き換えず、範囲だけを返す。
 * 認識できなければ、import / export があれば esm、無ければ unknown として範囲を返さない（呼び出し側がファイル全体を 1 つにする）。
 */
import { parse } from '@babel/parser';
import type { BlockStatement, CallExpression, Expression, Node, ObjectExpression } from '@babel/types';
import { skip, toByteOffsets, walk } from './shared.ts';

export interface UnpackInput {
  /** raw のバイト列（UTF-8） */
  bytes: Uint8Array;
}

export interface UnpackModule {
  /** バンドラのモジュール ID（webpack のモジュールマップのキー） */
  moduleId: string;
  /** raw 内の開始バイト（含む） */
  startByte: number;
  /** raw 内の終了バイト（含まない） */
  endByte: number;
}

export interface UnpackOutput {
  bundler: 'webpack' | 'esm' | 'unknown';
  /** チャンクの push に書かれたチャンク ID（ランタイムのチャンクマップ上の ID） */
  chunkIds: string[];
  /** raw 内の位置順 */
  modules: UnpackModule[];
}

interface CharRange {
  moduleId: string;
  start: number;
  end: number;
}

type Factory = Extract<Node, { type: 'ArrowFunctionExpression' | 'FunctionExpression' }>;

export default function unpack(input: UnpackInput): UnpackOutput {
  let text: string;
  try {
    // BOM も 1 文字として残す（落とすと文字位置とバイト位置の対応がずれる）
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.bytes);
  } catch {
    throw skip('parse_failed', 'not valid UTF-8');
  }

  let program;
  try {
    program = parse(text, { sourceType: 'unambiguous', errorRecovery: false }).program;
  } catch (err) {
    throw skip('parse_failed', err instanceof Error ? err.message : String(err));
  }

  let webpack = false;
  const chunkIds: string[] = [];
  const ranges: CharRange[] = [];
  for (const stmt of program.body) {
    if (stmt.type !== 'ExpressionStatement') continue;
    const exprs = stmt.expression.type === 'SequenceExpression' ? stmt.expression.expressions : [stmt.expression];
    for (const expr of exprs) {
      const chunk = matchChunkPush(expr);
      if (chunk) {
        webpack = true;
        chunkIds.push(...chunk.chunkIds);
        ranges.push(...factoryRanges(chunk.modules));
        continue;
      }
      const runtimeModules = matchRuntimeModules(expr);
      if (runtimeModules) {
        webpack = true;
        ranges.push(...factoryRanges(runtimeModules));
      }
    }
  }

  if (!webpack) {
    return { bundler: program.sourceType === 'module' ? 'esm' : 'unknown', chunkIds: [], modules: [] };
  }
  const bytesAt = toByteOffsets(text, ranges.flatMap((r) => [r.start, r.end]).concat(text.length));
  if (bytesAt.get(text.length) !== input.bytes.byteLength) {
    throw skip('tool_error', 'character to byte offset conversion does not cover the input');
  }
  const modules = ranges
    .map((r) => ({ moduleId: r.moduleId, startByte: bytesAt.get(r.start) ?? -1, endByte: bytesAt.get(r.end) ?? -1 }))
    .sort((a, b) => a.startByte - b.startByte);
  return { bundler: 'webpack', chunkIds, modules };
}

/** (self.webpackChunkX = self.webpackChunkX || []).push([[ids], { modules }, runtime?]) */
function matchChunkPush(expr: Expression): { chunkIds: string[]; modules: ObjectExpression } | undefined {
  if (expr.type !== 'CallExpression' || expr.callee.type !== 'MemberExpression') return undefined;
  if (propertyName(expr.callee) !== 'push' || !isChunkGlobal(expr.callee.object)) return undefined;
  const arg = expr.arguments[0];
  if (arg?.type !== 'ArrayExpression') return undefined;
  const [ids, modules] = arg.elements;
  if (ids?.type !== 'ArrayExpression' || modules?.type !== 'ObjectExpression' || !isModuleMap(modules)) return undefined;
  const chunkIds: string[] = [];
  for (const id of ids.elements) {
    if (id?.type === 'NumericLiteral' || id?.type === 'StringLiteral') chunkIds.push(String(id.value));
  }
  return { chunkIds, modules };
}

function isChunkGlobal(node: Node): boolean {
  const target = node.type === 'AssignmentExpression' && node.operator === '=' ? node.left : node;
  return target.type === 'MemberExpression' && (propertyName(target)?.startsWith('webpackChunk') ?? false);
}

/** (() => { var m = { <id>: <factory> }; ... m[id](...) ... })() の m の中身 */
function matchRuntimeModules(expr: Expression): ObjectExpression | undefined {
  const call = expr.type === 'UnaryExpression' ? expr.argument : expr;
  if (call.type !== 'CallExpression') return undefined;
  const fn = call.callee;
  if ((fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') || fn.body.type !== 'BlockStatement') {
    return undefined;
  }
  for (const stmt of fn.body.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const decl of stmt.declarations) {
      if (decl.id.type !== 'Identifier' || decl.init?.type !== 'ObjectExpression') continue;
      if (decl.init.properties.length > 0 && isModuleMap(decl.init) && callsModuleOf(fn.body, decl.id.name)) {
        return decl.init;
      }
    }
  }
  return undefined;
}

/** 値がすべてファクトリ関数（引数 3 つ以下）で、キーが ID（数値・文字列・識別子）のオブジェクト */
function isModuleMap(obj: ObjectExpression): boolean {
  return obj.properties.every(
    (p) =>
      p.type === 'ObjectProperty' &&
      !p.computed &&
      (p.key.type === 'NumericLiteral' || p.key.type === 'StringLiteral' || p.key.type === 'Identifier') &&
      isFactory(p.value),
  );
}

function isFactory(node: Node): node is Factory {
  return (
    (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
    node.params.length <= 3 &&
    node.params.every((p) => p.type === 'Identifier')
  );
}

/** body の中に name[x](...) か name[x].call(...) の呼び出し（webpack の require 関数）があるか */
function callsModuleOf(body: BlockStatement, name: string): boolean {
  const isModuleLookup = (n: Node) =>
    n.type === 'MemberExpression' && n.computed && n.object.type === 'Identifier' && n.object.name === name;
  let found = false;
  walk(body, (n) => {
    if (n.type !== 'CallExpression') return;
    const callee = (n as CallExpression).callee;
    if (isModuleLookup(callee)) found = true;
    else if (callee.type === 'MemberExpression' && propertyName(callee) === 'call' && isModuleLookup(callee.object)) found = true;
  });
  return found;
}

function factoryRanges(obj: ObjectExpression): CharRange[] {
  const out: CharRange[] = [];
  for (const p of obj.properties) {
    if (p.type !== 'ObjectProperty' || !isFactory(p.value)) continue;
    const key = p.key;
    const moduleId =
      key.type === 'NumericLiteral' || key.type === 'StringLiteral' ? String(key.value) : key.type === 'Identifier' ? key.name : '';
    const body = p.value.body;
    // 波括弧の内側。式本体のアロー関数なら式そのもの
    const [start, end] = body.type === 'BlockStatement' ? [body.start! + 1, body.end! - 1] : [body.start!, body.end!];
    out.push({ moduleId, start, end });
  }
  return out;
}

function propertyName(m: Extract<Node, { type: 'MemberExpression' }>): string | undefined {
  if (!m.computed && m.property.type === 'Identifier') return m.property.name;
  if (m.computed && m.property.type === 'StringLiteral') return m.property.value;
  return undefined;
}
