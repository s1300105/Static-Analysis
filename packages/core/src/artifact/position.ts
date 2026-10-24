/**
 * raw のバイト位置から表示用の行・列を求める（design.md §6.6。line:col は表示用の派生値で、基準はバイト範囲）。
 * 行は 1 始まり、列は 0 始まりで行頭からの UTF-16 の単位数（エディタと Babel の loc.column に合わせる）。
 * minify されたファイルは 1 行が長いので、位置ごとに数え直さず、ファイルを 1 回だけ走査する。
 */
import type { DisplayPosition } from '@sa/types';

export function displayPositions(bytes: Uint8Array, offsets: Iterable<number>): Map<number, DisplayPosition> {
  const wanted = [...new Set(offsets)].sort((a, b) => a - b);
  const out = new Map<number, DisplayPosition>();
  let line = 1;
  let col = 0;
  let i = 0;
  for (const target of wanted) {
    const end = Math.min(target, bytes.length);
    for (; i < end; i++) {
      const b = bytes[i]!;
      if (b === 0x0a) {
        line++;
        col = 0;
      } else if (b < 0x80 || b >= 0xc0) {
        // 続きのバイト（0x80〜0xbf）は数えない。4 バイトの文字（0xf0〜）は UTF-16 で 2 単位
        col += b >= 0xf0 ? 2 : 1;
      }
    }
    out.set(target, { line, col });
  }
  return out;
}
