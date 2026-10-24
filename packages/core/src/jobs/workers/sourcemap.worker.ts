/**
 * sourcemap worker: sourcemap（v3）を読み、簡易検証（design.md §6.6）を掛けて、sources と sourcesContent を返す。
 * worker 側の規約（相対 import をしない・消せる型構文だけ）は ./index.ts を参照。
 *
 * 簡易検証: names 付きのセグメントを抜き取り、
 * - 生成側: 生成ファイルのその位置が識別子の先頭に当たるか（直前が識別子の文字でない）
 * - 元側: sourcesContent のその位置（か同じ行のそれ以降）に names[i] が識別子として現れるか
 * を数える。別ビルドの map を当てると両方がずれるので一致率が落ちる。
 * 生成側は完全なトークン分割ではなく識別子の境界で近似する（巨大なバンドルを毎回トークン化しないため）。
 */
import { decode } from '@jridgewell/sourcemap-codec';

export interface SourcemapInput {
  /** sourcemap ファイルのバイト列 */
  map: Uint8Array;
  /** 生成ファイル（raw の JS）のバイト列 */
  generated: Uint8Array;
  /** 検査する names 付きセグメントの上限（多ければ等間隔に抜き取る） */
  sampleLimit: number;
}

export interface SourcemapSource {
  /** sources の添字 */
  index: number;
  /** sources[i]（sourceRoot を前に付けたもの）。ターゲット由来の文字列で、表示用。パスにする前に必ず正規化する */
  name: string;
  /** sourcesContent[i]。無ければ null */
  content: string | null;
  /** ignoreList（x_google_ignoreList）に入っているか。ライブラリ・ランタイムの印 */
  ignored: boolean;
}

export interface SourcemapCheckCounts {
  sampled: number;
  generatedTokenStart: number;
  originalNameMatch: number;
  matched: number;
}

export interface SourcemapOutput {
  /** map の file 欄 */
  file: string | null;
  sources: SourcemapSource[];
  check: SourcemapCheckCounts;
}

interface RawMap {
  version: number;
  mappings: string;
  sources: (string | null)[];
  names: string[];
  sourcesContent: (string | null)[];
  sourceRoot: string;
  file: string | null;
  ignoreList: number[];
}

const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/;
const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/u;

export default function checkSourcemap(input: SourcemapInput): SourcemapOutput {
  const map = readMap(input.map);
  let generatedText: string;
  try {
    generatedText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.generated);
  } catch {
    throw skip('parse_failed', 'generated file is not valid UTF-8');
  }
  const generatedLines = generatedText.split(LINE_TERMINATOR);

  let decoded: number[][][];
  try {
    decoded = decode(map.mappings);
  } catch (err) {
    throw skip('parse_failed', `invalid mappings: ${err instanceof Error ? err.message : String(err)}`);
  }

  // names 付き（5 要素）のセグメントを集め、上限を超えたら等間隔に抜き取る
  const named: { line: number; seg: number[] }[] = [];
  decoded.forEach((segs, line) => {
    for (const seg of segs) if (seg.length === 5) named.push({ line, seg });
  });
  const limit = Math.max(1, Math.floor(input.sampleLimit));
  const sample =
    named.length <= limit ? named : Array.from({ length: limit }, (_, i) => named[Math.floor((i * named.length) / limit)]!);

  const contentLines = new Map<number, string[] | null>();
  const linesOf = (src: number): string[] | null => {
    if (!contentLines.has(src)) {
      const c = map.sourcesContent[src];
      contentLines.set(src, typeof c === 'string' ? c.split(LINE_TERMINATOR) : null);
    }
    return contentLines.get(src) ?? null;
  };

  const check: SourcemapCheckCounts = { sampled: sample.length, generatedTokenStart: 0, originalNameMatch: 0, matched: 0 };
  for (const { line, seg } of sample) {
    const [genCol, src, origLine, origCol, nameIdx] = seg as [number, number, number, number, number];
    const genOk = isIdentifierStart(generatedLines[line], genCol);
    const orig = linesOf(src)?.[origLine];
    const origOk = orig !== undefined && nameAtOrAfter(orig, origCol, map.names[nameIdx]);
    if (genOk) check.generatedTokenStart++;
    if (origOk) check.originalNameMatch++;
    if (genOk && origOk) check.matched++;
  }

  const ignored = new Set(map.ignoreList);
  const sources = map.sources.map((s, index) => ({
    index,
    name: withSourceRoot(map.sourceRoot, s ?? ''),
    content: typeof map.sourcesContent[index] === 'string' ? (map.sourcesContent[index] as string) : null,
    ignored: ignored.has(index),
  }));
  return { file: map.file, sources, check };
}

function readMap(bytes: Uint8Array): RawMap {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  } catch (err) {
    throw skip('parse_failed', `sourcemap is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw skip('parse_failed', 'sourcemap is not an object');
  const m = json as Record<string, unknown>;
  if ('sections' in m) throw skip('parse_failed', 'index sourcemaps (sections) are not supported');
  if (m.version !== 3) throw skip('parse_failed', `unsupported sourcemap version: ${String(m.version)}`);
  if (typeof m.mappings !== 'string') throw skip('parse_failed', 'sourcemap has no mappings');
  if (!isArrayOf(m.sources, isStringOrNull)) throw skip('parse_failed', 'invalid sources');
  const names = m.names ?? [];
  if (!isArrayOf(names, isString)) throw skip('parse_failed', 'invalid names');
  const sourcesContent = m.sourcesContent ?? [];
  if (!isArrayOf(sourcesContent, isStringOrNull)) throw skip('parse_failed', 'invalid sourcesContent');
  const ignoreList = m.ignoreList ?? m.x_google_ignoreList ?? [];
  if (!isArrayOf(ignoreList, isInteger)) throw skip('parse_failed', 'invalid ignoreList');
  return {
    version: 3,
    mappings: m.mappings,
    sources: m.sources,
    names,
    sourcesContent,
    sourceRoot: typeof m.sourceRoot === 'string' ? m.sourceRoot : '',
    file: typeof m.file === 'string' ? m.file : null,
    ignoreList,
  };
}

function isArrayOf<T>(v: unknown, pred: (x: unknown) => x is T): v is T[] {
  return Array.isArray(v) && v.every(pred);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isInteger = (v: unknown): v is number => Number.isInteger(v);

function withSourceRoot(root: string, source: string): string {
  if (root === '' || /^[a-z][a-z0-9+.-]*:/i.test(source)) return source;
  return `${root.replace(/\/?$/, '/')}${source}`;
}

/** line の col（UTF-16 のコード単位）が識別子の先頭か */
function isIdentifierStart(line: string | undefined, col: number): boolean {
  if (line === undefined || col < 0 || col >= line.length) return false;
  if (!ID_START.test(String.fromCodePoint(line.codePointAt(col)!))) return false;
  if (col === 0) return true;
  const before = line.charCodeAt(col - 1);
  const prev =
    before >= 0xdc00 && before <= 0xdfff && col >= 2 ? String.fromCodePoint(line.codePointAt(col - 2)!) : line[col - 1]!;
  return !ID_PART.test(prev);
}

/**
 * 元側の検査。col の位置の識別子が name か、同じ行の col 以降に name が識別子として現れるか。
 * webpack の map（webpack-sources の OriginalSource）は元側の位置を文の先頭に丸めるので、位置ちょうどだけを見ると正しい map でも外れる。
 */
function nameAtOrAfter(line: string, col: number, name: string | undefined): boolean {
  if (name === undefined || col < 0 || col > line.length) return false;
  const rest = line.slice(col);
  if (IDENTIFIER.exec(rest)?.[0] === name) return true;
  for (let i = rest.indexOf(name); i !== -1; i = rest.indexOf(name, i + 1)) {
    const before = i === 0 ? '' : rest[i - 1]!;
    const after = rest[i + name.length] ?? '';
    if (!ID_PART.test(before) && !ID_PART.test(after)) return true;
  }
  return false;
}

function skip(reason: string, message: string): Error {
  return Object.assign(new Error(message), { skipReason: reason });
}
