/**
 * worker の間で共有する道具（Babel の AST・位置の変換・スキップの投げ方）。
 * worker から `import ... from './shared.ts'` で読む（規約は ./index.ts）。
 */
import type { Node } from '@babel/types';

/** 深い AST でもスタックを使い切らないよう、明示的なスタックで辿る */
export function walk(root: Node, visit: (n: Node) => void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
      continue;
    }
    if (v === null || typeof v !== 'object' || typeof (v as { type?: unknown }).type !== 'string') continue;
    visit(v as Node);
    for (const [k, child] of Object.entries(v)) {
      if (k === 'loc' || k === 'extra' || k.endsWith('Comments')) continue;
      if (child !== null && typeof child === 'object') stack.push(child);
    }
  }
}

/**
 * 文字位置（UTF-16 のコード単位。Babel の start/end）を UTF-8 のバイト位置に変える。全位置を 1 回の走査で求める。
 * 入力は fatal な UTF-8 デコードを通っているので、サロゲートは必ず対になっている。
 */
export function toByteOffsets(text: string, indices: number[]): Map<number, number> {
  const targets = [...new Set(indices)].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let byte = 0;
  let i = 0;
  for (const target of targets) {
    while (i < target) {
      const c = text.charCodeAt(i);
      if (c < 0x80) byte += 1;
      else if (c < 0x800) byte += 2;
      else if (c >= 0xd800 && c <= 0xdbff) {
        byte += 4;
        i++;
      } else byte += 3;
      i++;
    }
    out.set(target, byte);
  }
  return out;
}

/**
 * UTF-8 のバイト位置を文字位置（UTF-16 のコード単位）に変える（toByteOffsets の逆）。全位置を 1 回の走査で求める。
 * BOM も 1 文字に数える（デコードは ignoreBOM: true で BOM を残す）
 */
export function toCharOffsets(bytes: Uint8Array, offsets: number[]): Map<number, number> {
  const targets = [...new Set(offsets)].sort((a, b) => a - b);
  const out = new Map<number, number>();
  let chars = 0;
  let i = 0;
  for (const target of targets) {
    const end = Math.min(target, bytes.length);
    for (; i < end; i++) {
      const b = bytes[i]!;
      // 続きのバイト（0x80〜0xbf）は数えない。4 バイトの文字（0xf0〜）は UTF-16 で 2 単位
      if (b < 0x80 || b >= 0xc0) chars += b >= 0xf0 ? 2 : 1;
    }
    out.set(target, chars);
  }
  return out;
}

/** スキップ理由（JobSkipError と同じ skipReason）を持つ Error。worker の起動コードがこの理由で失敗を返す */
export function skip(reason: string, message: string): Error {
  return Object.assign(new Error(message), { skipReason: reason });
}
