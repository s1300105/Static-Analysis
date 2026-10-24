/**
 * import_har（design.md §7.1、計画書 M2）: 人間が取得した HAR から許可リストの項目だけを抜き出す。HAR は保存しない。
 * 残すもの:
 * - API の呼び出し: メソッド・URL のパス（ID・トークン・メールアドレスに見えるセグメントは {}）・クエリと本文のパラメータ名・
 *   GraphQL の operationName と persisted query のハッシュと変数名 → api_endpoint と照合して sighting（analysis/endpoints/har.ts）
 * - JS / sourcemap のレスポンス本文 → raw 層（load_artifact と同じ。配信 URL はクエリを除く。読み込んだ文書のオリジンも残す）
 * - HTML 文書のセキュリティヘッダ（CSP・CSP-Report-Only・X-Frame-Options・COOP と <meta http-equiv=CSP>）→ page_context。
 *   文書の URL はクエリを除いてパスをテンプレート化し、CSP の nonce と report-uri のクエリは残さない
 * 残さないもの: 上の値以外のすべて（その他のヘッダ・Cookie・パラメータの値・JSON や HTML の本文・JS / sourcemap 以外の中身）。
 * 拒否リストでマスクする方式は独自ヘッダや本文中のトークンを取りこぼすので採らない。元の HAR は人間の手元に残す。
 * 本文（GraphQL の query・JSON・HTML）はメモリの中で読むだけで、名前と種類のほかは書かない。
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { type ImportHarInput, ImportHarInputSchema, type EndpointParam, type Protocol } from '@sa/types';
import { parse as parseGraphql } from 'graphql';
import { type HarMatchResult, type HarObservation, type HarOperation, recordHarObservations } from '../analysis/endpoints/har';
import { normalizeEndpointUrl } from '../analysis/endpoints/normalize';
import type { SaContext } from '../context';
import { withTxn } from '../db/connection';
import { finishAnalysisRun, startAnalysisRun } from '../db/repo/analysisRun';
import { type PageSecurityHeaders, upsertPageContext } from '../db/repo/pageContext';
import { SaError } from '../errors';
import { parseInput } from '../validate';
import { CORE_VERSION } from '../version';
import { type RawFileInput, type VersionSpec, addRawFiles, checkVersionSpec } from './load';

export interface ImportHarResult {
  versionId: string;
  createdVersion: boolean;
  runId: string;
  /** HAR の記録の数 */
  entries: number;
  /** URL かメソッドが読めず飛ばした記録 */
  invalid: number;
  /** JS / sourcemap: raw にした行（入力の順）、新しく作った数、本文が無く取り込めなかった数 */
  scripts: { fileIds: string[]; added: number; withoutBody: number };
  /** page_context に書いた文書の数 */
  pages: number;
  api: HarMatchResult;
  /** 画像・CSS・フォント・プリフライトなど、何も残さなかった記録 */
  ignored: number;
}

/** HAR の記録のうち読む部分（それ以外は触らない） */
interface HarEntry {
  pageref?: unknown;
  startedDateTime?: unknown;
  _resourceType?: unknown;
  request?: {
    method?: unknown;
    url?: unknown;
    headers?: unknown;
    postData?: { mimeType?: unknown; text?: unknown; params?: unknown };
  };
  response?: { status?: unknown; headers?: unknown; content?: { mimeType?: unknown; text?: unknown; encoding?: unknown } };
}

type PostData = NonNullable<HarEntry['request']>['postData'];

interface HarPage {
  id?: unknown;
  title?: unknown;
  startedDateTime?: unknown;
}

type EntryKind = 'script' | 'sourcemap' | 'document' | 'api' | 'ignored';

const STATIC_RESOURCE_TYPES = new Set(['image', 'stylesheet', 'font', 'media', 'manifest', 'texttrack', 'preflight', 'csp_violation_report']);
const STATIC_EXT_RE = /^\.(png|jpe?g|gif|svg|ico|webp|avif|bmp|css|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|ogg)$/;
const GRAPHQL_PATH_RE = /\/(graphql|gql)$/i;
/** GraphQL の本文の封筒（パラメータとしては残さない） */
const GRAPHQL_ENVELOPE = new Set(['query', 'variables', 'operationName', 'extensions']);
const SHA256_RE = /^[0-9a-f]{64}$/i;

export function importHar(ctx: SaContext, input: ImportHarInput): ImportHarResult {
  const req = parseInput(ImportHarInputSchema, input, 'import_har');
  const { pages, entries } = readHar(req.harPath);
  const collectedAt = req.versionId === undefined ? (req.collectedAt ?? earliest(pages, entries)) : undefined;
  if (req.versionId === undefined && collectedAt === undefined) {
    throw new SaError('INVALID_INPUT', 'the HAR has no timestamps; give collectedAt to create a version');
  }
  const spec: VersionSpec = {
    targetId: req.targetId,
    ...(req.versionId !== undefined && { versionId: req.versionId }),
    ...(req.baseVersionId !== undefined && { baseVersionId: req.baseVersionId }),
    ...(req.label !== undefined && { label: req.label }),
    ...(collectedAt !== undefined && { collectedAt }),
    ...(req.collectionNotes !== undefined && { collectionNotes: req.collectionNotes }),
  };
  checkVersionSpec(ctx, spec);

  const pageOrigins = pageOriginsOf(pages, entries);
  const scripts: RawFileInput[] = [];
  const documents: { documentUrl: string; headers: PageSecurityHeaders; observedAt: string | null }[] = [];
  const observations: HarObservation[] = [];
  let invalid = 0;
  let ignored = 0;
  let withoutBody = 0;
  for (const e of entries) {
    const url = entryUrl(e);
    if (!url || typeof e.request?.method !== 'string') {
      invalid++;
      continue;
    }
    switch (classify(e, url)) {
      case 'script':
      case 'sourcemap': {
        const body = okStatus(e) ? responseBody(e) : undefined;
        if (!body) {
          withoutBody++;
          break;
        }
        const origin = typeof e.pageref === 'string' ? pageOrigins.get(e.pageref) : undefined;
        scripts.push({
          name: url.pathname,
          bytes: body,
          origName: basename(url.pathname) || url.host,
          sourceUrls: [`${url.origin}${url.pathname}`],
          ...(origin !== undefined && { loadedByOrigins: [origin] }),
        });
        break;
      }
      case 'document':
        if (okStatus(e)) documents.push(pageContextOf(e, url));
        else ignored++;
        break;
      case 'api':
        observations.push(observationOf(e, url));
        break;
      default:
        ignored++;
    }
  }

  const load = addRawFiles(ctx, spec, scripts);
  const runId = startAnalysisRun(ctx, { versionId: load.versionId, kind: 'ingest', tool: 'import_har', toolVersion: `sa-core ${CORE_VERSION}` });
  const pageIds = withTxn(ctx, () => new Set(documents.map((d) => upsertPageContext(ctx, { versionId: load.versionId, ...d }))));
  const api = recordHarObservations(ctx, { targetId: req.targetId, versionId: load.versionId, runId, observations });
  finishAnalysisRun(ctx, runId, { filesTotal: entries.length, filesAnalyzed: entries.length - invalid, filesSkipped: invalid });
  return {
    versionId: load.versionId,
    createdVersion: load.createdVersion,
    runId,
    entries: entries.length,
    invalid,
    scripts: { fileIds: load.fileIds, added: load.added, withoutBody },
    pages: pageIds.size,
    api,
    ignored,
  };
}

function readHar(path: string): { pages: HarPage[]; entries: HarEntry[] } {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new SaError('INVALID_INPUT', `file not found: ${path}`, { path }, { cause: err });
    throw new SaError('INVALID_INPUT', `not a HAR file (cannot read it as JSON): ${path}`, { path }, { cause: err });
  }
  const log = (json as { log?: { pages?: unknown; entries?: unknown } } | null)?.log;
  if (!log || !Array.isArray(log.entries)) throw new SaError('INVALID_INPUT', `not a HAR file (no log.entries): ${path}`, { path });
  const isObject = (x: unknown) => typeof x === 'object' && x !== null;
  return {
    pages: (Array.isArray(log.pages) ? log.pages : []).filter(isObject) as HarPage[],
    entries: log.entries.filter(isObject) as HarEntry[],
  };
}

function entryUrl(e: HarEntry): URL | undefined {
  if (typeof e.request?.url !== 'string') return undefined;
  try {
    return new URL(e.request.url);
  } catch {
    return undefined;
  }
}

function classify(e: HarEntry, url: URL): EntryKind {
  const resourceType = typeof e._resourceType === 'string' ? e._resourceType.toLowerCase() : '';
  const mime = mimeOf(e.response?.content?.mimeType);
  const ext = extname(url.pathname).toLowerCase();
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return 'api';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'ignored';
  // CORS のプリフライトは本当の呼び出しの写し
  if (STATIC_RESOURCE_TYPES.has(resourceType) || header(e.request?.headers, 'access-control-request-method') !== undefined) return 'ignored';
  if (ext === '.map') return 'sourcemap';
  if (resourceType === 'script' || /javascript|ecmascript/.test(mime) || ((ext === '.js' || ext === '.mjs') && !/html|json/.test(mime))) {
    return 'script';
  }
  if (resourceType === 'document' || (mime === 'text/html' && resourceType !== 'xhr' && resourceType !== 'fetch' && e.request?.method === 'GET')) {
    return 'document';
  }
  if (/^(image|font|audio|video)\//.test(mime) || mime === 'text/css' || STATIC_EXT_RE.test(ext)) return 'ignored';
  return 'api';
}

function observationOf(e: HarEntry, url: URL): HarObservation {
  const n = normalizeEndpointUrl(`${url.origin}${url.pathname}`)!;
  const websocket = url.protocol === 'ws:' || url.protocol === 'wss:';
  const method = websocket ? '' : String(e.request!.method).toUpperCase();
  const operations = graphqlOperations(url, e.request?.postData, method);
  const protocol: Protocol = websocket ? 'websocket' : operations.length > 0 || GRAPHQL_PATH_RE.test(n.pathNorm) ? 'graphql' : 'rest';
  const params: EndpointParam[] = [];
  const add = (name: string, loc: EndpointParam['in']) => {
    if (protocol === 'graphql' && GRAPHQL_ENVELOPE.has(name)) return;
    if (!params.some((p) => p.name === name && p.in === loc)) params.push({ name, in: loc });
  };
  for (const name of url.searchParams.keys()) add(name, 'query');
  for (const name of bodyParamNames(e.request?.postData)) add(name, 'body');
  return { protocol, origin: n.origin, method, pathNorm: n.pathNorm, pathTemplate: n.pathTemplate, params, operations };
}

/** 本文のパラメータ名（フォーム・JSON のオブジェクトの最上位のキー・x-www-form-urlencoded）。値は読まない */
function bodyParamNames(pd: PostData): string[] {
  if (!pd) return [];
  if (Array.isArray(pd.params) && pd.params.length > 0) {
    return pd.params.map((p) => (p as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string');
  }
  const mime = mimeOf(pd.mimeType);
  const text = typeof pd.text === 'string' ? pd.text : '';
  if (mime.includes('json') || /^\s*\{/.test(text)) {
    const v = parseJson(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v);
    return [];
  }
  if (mime === 'application/x-www-form-urlencoded') return [...new URLSearchParams(text).keys()];
  return [];
}

/** GraphQL の呼び出し（本文の JSON か、GET のクエリ）から operation 名・種類・persisted query のハッシュ・変数名を読む */
function graphqlOperations(url: URL, pd: PostData, method: string): HarOperation[] {
  const bodies: unknown[] = [];
  const text = typeof pd?.text === 'string' ? pd.text : '';
  const json = /^\s*[{[]/.test(text) ? parseJson(text) : undefined;
  if (Array.isArray(json)) bodies.push(...json);
  else if (json !== undefined) bodies.push(json);
  if (method === 'GET' && (url.searchParams.has('query') || url.searchParams.has('operationName') || url.searchParams.has('extensions'))) {
    bodies.push({
      query: url.searchParams.get('query') ?? undefined,
      operationName: url.searchParams.get('operationName') ?? undefined,
      variables: parseJson(url.searchParams.get('variables') ?? ''),
      extensions: parseJson(url.searchParams.get('extensions') ?? ''),
    });
  }
  const ops: HarOperation[] = [];
  for (const b of bodies) {
    const body = b as { query?: unknown; operationName?: unknown; variables?: unknown; extensions?: { persistedQuery?: { sha256Hash?: unknown } } };
    if (!body || typeof body !== 'object') continue;
    const hash = body.extensions?.persistedQuery?.sha256Hash;
    const persistedHash = typeof hash === 'string' && SHA256_RE.test(hash) ? hash.toLowerCase() : null;
    if (typeof body.query !== 'string' && typeof body.operationName !== 'string' && persistedHash === null) continue;
    let name = typeof body.operationName === 'string' ? body.operationName : '';
    let kind = '';
    const variables = new Set<string>(
      body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables) ? Object.keys(body.variables) : [],
    );
    if (typeof body.query === 'string') {
      try {
        const defs = parseGraphql(body.query, { noLocation: true }).definitions;
        const op = defs.find((d) => d.kind === 'OperationDefinition' && (name === '' || d.name?.value === name));
        if (op && op.kind === 'OperationDefinition') {
          kind = op.operation.toUpperCase();
          if (name === '') name = op.name?.value ?? '';
          for (const v of op.variableDefinitions ?? []) variables.add(v.variable.name.value);
        }
      } catch {
        // GraphQL として読めない本文は名前とハッシュだけ使う
      }
    }
    ops.push({ name, kind, persistedHash, variables: [...variables] });
  }
  return ops;
}

function pageContextOf(e: HarEntry, url: URL): { documentUrl: string; headers: PageSecurityHeaders; observedAt: string | null } {
  const n = normalizeEndpointUrl(`${url.origin}${url.pathname}`)!;
  const h = e.response?.headers;
  const headers: PageSecurityHeaders = {};
  const csp = headerValues(h, 'content-security-policy').map(sanitizeCsp);
  if (csp.length > 0) headers['content-security-policy'] = csp;
  const cspRo = headerValues(h, 'content-security-policy-report-only').map(sanitizeCsp);
  if (cspRo.length > 0) headers['content-security-policy-report-only'] = cspRo;
  const xfo = header(h, 'x-frame-options');
  if (xfo !== undefined) headers['x-frame-options'] = xfo.trim();
  const coop = header(h, 'cross-origin-opener-policy');
  if (coop !== undefined) headers['cross-origin-opener-policy'] = coop.trim();
  const body = responseBody(e);
  if (body) {
    const meta = metaCsp(Buffer.from(body).toString('utf8')).map(sanitizeCsp);
    if (meta.length > 0) headers['meta-content-security-policy'] = meta;
  }
  return { documentUrl: `${n.origin}${n.pathNorm}`, headers, observedAt: isoOrNull(e.startedDateTime) };
}

/** CSP の値から、nonce と report-uri のクエリ（キーやトークンが入ることがある）を除く */
function sanitizeCsp(value: string): string {
  return value
    .replace(/'nonce-[^']*'/gi, "'nonce-{}'")
    .replace(/(report-uri\s+)([^;]+)/gi, (_m, d: string, urls: string) => d + urls.split(/\s+/).map((u) => u.replace(/[?#].*$/, '')).join(' '));
}

/** <meta http-equiv="Content-Security-Policy" content="..."> の content */
function metaCsp(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/http-equiv\s*=\s*["']?content-security-policy["'\s>]/i.test(tag)) continue;
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (content) out.push((content[1] ?? content[2] ?? '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&'));
  }
  return out;
}

/** pageref → 文書のオリジン（page の title が URL ならそれ、無ければその page の最初の文書の URL） */
function pageOriginsOf(pages: HarPage[], entries: HarEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of pages) {
    if (typeof p.id !== 'string' || typeof p.title !== 'string') continue;
    const origin = httpOrigin(p.title);
    if (origin) out.set(p.id, origin);
  }
  for (const e of entries) {
    if (typeof e.pageref !== 'string' || out.has(e.pageref)) continue;
    const url = entryUrl(e);
    if (url && classify(e, url) === 'document') out.set(e.pageref, url.origin);
  }
  return out;
}

function httpOrigin(s: string): string | undefined {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

function okStatus(e: HarEntry): boolean {
  const status = e.response?.status;
  return typeof status === 'number' && status >= 200 && status < 300;
}

function responseBody(e: HarEntry): Uint8Array | undefined {
  const c = e.response?.content;
  if (typeof c?.text !== 'string' || c.text === '') return undefined;
  return c.encoding === 'base64' ? Buffer.from(c.text, 'base64') : Buffer.from(c.text, 'utf8');
}

function headerValues(headers: unknown, name: string): string[] {
  if (!Array.isArray(headers)) return [];
  return headers
    .filter((h) => typeof h?.name === 'string' && h.name.toLowerCase() === name && typeof h.value === 'string')
    .map((h) => h.value as string);
}

function header(headers: unknown, name: string): string | undefined {
  return headerValues(headers, name).at(-1);
}

function mimeOf(v: unknown): string {
  return typeof v === 'string' ? (v.split(';')[0] ?? '').trim().toLowerCase() : '';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** HAR の最初の記録（page か entry）の日時 */
function earliest(pages: HarPage[], entries: HarEntry[]): string | undefined {
  const times = [...pages.map((p) => isoOrNull(p.startedDateTime)), ...entries.map((e) => isoOrNull(e.startedDateTime))].filter(
    (t): t is string => t !== null,
  );
  return times.sort()[0];
}
