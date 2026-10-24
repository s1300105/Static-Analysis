/**
 * エンドポイントの URL の正規化（design.md §6.2 path_norm）。抽出器（ast_url・jsluice・GraphQL・HAR）が共通に使う。
 *
 * 規則:
 * - オリジン（scheme://host[:port]）を分ける。ホストは小文字、既定のポート（http:80・https:443・ws:80・wss:443）は落とす
 * - 先頭が式（ベース URL。"EXPR/users"・"{base}/users"・"${API}/users"）なら除く（オリジンは不明 = ''）
 * - 可変の部分を {} にする: 式（EXPR・${...}・{name}・{}）・:name・数値・UUID・16進（8 文字以上で数字を含む）のセグメント
 * - クエリ文字列とフラグメントを除く（クエリのパラメータ名は別に返す。値は持たない）
 * - 空のセグメント・"."・末尾の "/" を除く。先頭 "/" の無い相対パスは "/" を補う（取得元ページのパスは使わない）
 * http(s)・ws(s) 以外のスキーム（mailto:・data:・javascript: など）は null。
 *
 * 抽出器が渡す可変部分の書き方: テンプレートリテラルは "${expr}" か "{name}"、jsluice は "EXPR"。
 */

export interface NormalizedEndpoint {
  /** scheme://host[:port]（ホストは小文字、既定のポートは除く）。不明は ''。プロトコル相対は //host */
  origin: string;
  /** 'http' / 'https' / 'ws' / 'wss'。不明は null */
  scheme: string | null;
  /** 例 "/api/docs/{}/share" */
  pathNorm: string;
  /** 表示用。例 "/api/docs/:docId/share"（名前が分からない可変部分は :param、数値・UUID・16進は :id） */
  pathTemplate: string;
  /** パスの名前付きの可変部分（"{docId}" → docId） */
  pathParams: string[];
  /** クエリ文字列のパラメータ名（値は持たない） */
  queryParams: string[];
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443' };
const EXPR_RE = /EXPR|\$\{[^}]*\}|\{[^}]*\}/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{8,}$/i;

export function normalizeEndpointUrl(input: string): NormalizedEndpoint | null {
  let s = input.trim();
  if (s === '') return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  if (scheme !== undefined && !(scheme in DEFAULT_PORTS && s.slice(scheme.length).startsWith('://'))) return null;

  s = s.replace(/#.*$/s, '');
  let query = '';
  const q = s.indexOf('?');
  if (q >= 0) {
    query = s.slice(q + 1);
    s = s.slice(0, q);
  }

  let origin = '';
  const abs = /^([a-z]+):\/\/([^/]*)/i.exec(s) ?? /^()\/\/([^/]*)/.exec(s);
  if (abs) {
    origin = normalizeOrigin(abs[1]!.toLowerCase(), abs[2]!);
    s = s.slice(abs[0].length);
  }

  let segments = s.split('/');
  // 先頭が式（ベース URL）: "EXPR/users"・"{base}/users"。"/{tenant}/users" のように "/" で始まるものはパスの一部
  if (!abs && segments.length > 1 && segments[0] !== '' && EXPR_RE.test(segments[0]!)) segments = segments.slice(1);
  segments = segments.filter((seg) => seg !== '' && seg !== '.');

  const norm: string[] = [];
  const template: string[] = [];
  const pathParams: string[] = [];
  for (const seg of segments) {
    const v = variableSegment(seg);
    if (v === undefined) {
      norm.push(seg);
      template.push(seg);
      continue;
    }
    norm.push('{}');
    template.push(`:${v.name ?? v.fallback}`);
    if (v.name !== undefined && !pathParams.includes(v.name)) pathParams.push(v.name);
  }

  return {
    origin,
    scheme: abs && abs[1] !== '' ? abs[1]!.toLowerCase() : null,
    pathNorm: `/${norm.join('/')}`,
    pathTemplate: `/${template.join('/')}`,
    pathParams,
    queryParams: queryParamNames(query),
  };
}

function normalizeOrigin(scheme: string, authority: string): string {
  const hostport = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase().replace(new RegExp(EXPR_RE, 'g'), '{}');
  const m = /^(.*?)(?::(\d+))?$/.exec(hostport)!;
  const port = m[2] !== undefined && m[2] !== DEFAULT_PORTS[scheme] ? `:${m[2]}` : '';
  return scheme === '' ? `//${m[1]}${port}` : `${scheme}://${m[1]}${port}`;
}

/** 可変のセグメントなら名前（分かれば）と既定名を返す */
function variableSegment(seg: string): { name: string | undefined; fallback: string } | undefined {
  if (seg.startsWith(':') && /^:[A-Za-z_$][\w$]*$/.test(seg)) return { name: seg.slice(1), fallback: 'param' };
  const expr = EXPR_RE.exec(seg);
  if (expr) return { name: placeholderName(expr[0]), fallback: 'param' };
  if (/^\d+$/.test(seg) || UUID_RE.test(seg) || (HEX_RE.test(seg) && /\d/.test(seg))) return { name: undefined, fallback: 'id' };
  return undefined;
}

/** "${user.id}" → id、"{docId}" → docId、"EXPR"・"{}"・複雑な式 → undefined */
function placeholderName(placeholder: string): string | undefined {
  const inner = placeholder.startsWith('${') ? placeholder.slice(2, -1) : placeholder.startsWith('{') ? placeholder.slice(1, -1) : '';
  const last = /([A-Za-z_$][\w$]*)\s*$/.exec(inner.trim())?.[1];
  return last !== undefined && /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*$/.test(inner.trim()) ? last : undefined;
}

function queryParamNames(query: string): string[] {
  const names: string[] = [];
  for (const part of query.split('&')) {
    const raw = part.split('=')[0] ?? '';
    if (raw === '' || EXPR_RE.test(raw)) continue;
    let name = raw;
    try {
      name = decodeURIComponent(raw.replace(/\+/g, ' '));
    } catch {
      // 壊れたエスケープはそのまま
    }
    if (!names.includes(name)) names.push(name);
  }
  return names;
}
