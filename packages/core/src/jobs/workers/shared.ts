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

/** スキップ理由（JobSkipError と同じ skipReason）を持つ Error。worker の起動コードがこの理由で失敗を返す */
export function skip(reason: string, message: string): Error {
  return Object.assign(new Error(message), { skipReason: reason });
}
