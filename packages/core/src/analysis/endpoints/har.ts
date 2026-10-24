/**
 * HAR で観測した呼び出しを api_endpoint と照合する（design.md §7.1 import_har）。
 * - 照合は endpoint のテンプレートをパターンにする: path_norm の {} は任意の 1 セグメント、origin が '' の endpoint はどの origin にも、
 *   method が '' の endpoint はどのメソッドにも当たる。当たったうち、origin・method が一致し固定のセグメントが多いものを採る（同点はすべて）
 * - 当たらない呼び出しは「HAR にしか無い endpoint」として作る（静的抽出の見逃し）
 * - GraphQL の operation は operation 名か persisted query のハッシュで照合する（送信先のパスが分かっている endpoint はパスも見る）
 * - sighting は endpoint ごとに 1 つ（extracted_by='har'、位置なし）。パラメータは同じ版の前回の HAR の分と足し合わせる
 * 照合は取り込む時点の endpoint に対して行うので、extract_endpoints を先に掛けておく。
 */
import type { EndpointParam, Protocol } from '@sa/types';
import type { SaContext } from '../../context';
import { withTxn } from '../../db/connection';
import { type EndpointRow, listEndpointRows, unlocatedSightingParams, upsertEndpoint, upsertSighting } from '../../db/repo/endpoint';

/** HAR の呼び出し 1 つから残すもの（すべて許可リストの項目） */
export interface HarObservation {
  protocol: Protocol;
  /** scheme://host[:port] */
  origin: string;
  /** 大文字 */
  method: string;
  /** normalizeEndpointUrl の path_norm（ID・トークン・メールアドレスは {}） */
  pathNorm: string;
  pathTemplate: string;
  /** 名前だけ */
  params: EndpointParam[];
  /** GraphQL の operation（一括送信なら複数） */
  operations: HarOperation[];
}

export interface HarOperation {
  /** operationName。無名は '' */
  name: string;
  /** QUERY / MUTATION / SUBSCRIPTION。本文が無い（persisted query）なら '' */
  kind: string;
  persistedHash: string | null;
  /** 変数名 */
  variables: string[];
}

export interface HarMatchResult {
  /** 照合した呼び出しの数（GraphQL の operation は含めない） */
  requests: number;
  /** 取り込む前からあった endpoint に当たった呼び出し・operation の数 */
  matched: number;
  /** HAR にしか無い endpoint として作った数 */
  harOnly: number;
  /** sighting を書いた endpoint の数 */
  endpoints: number;
}

export function recordHarObservations(
  ctx: SaContext,
  r: { targetId: string; versionId: string; runId: string; observations: HarObservation[] },
): HarMatchResult {
  return withTxn(ctx, () => {
    const endpoints = listEndpointRows(ctx, r.targetId);
    const out: HarMatchResult = { requests: 0, matched: 0, harOnly: 0, endpoints: 0 };
    const params = new Map<string, EndpointParam[]>();
    const sight = (ids: string[], p: EndpointParam[]) => {
      for (const id of ids) params.set(id, mergeParams(params.get(id) ?? [], p));
    };
    /** この取り込みで作った endpoint（後の呼び出しが当たっても matched には数えない） */
    const created = new Set<string>();
    /** 当たったものの ID。無ければ作る */
    const resolve = (found: EndpointRow[], create: () => Omit<EndpointRow, 'id' | 'targetId'>): string[] => {
      if (found.length > 0) {
        if (found.some((e) => !created.has(e.id))) out.matched++;
        return found.map((e) => e.id);
      }
      const key = { targetId: r.targetId, ...create() };
      const { persistedHash, ...endpointKey } = key;
      const id = upsertEndpoint(ctx, { ...endpointKey, ...(persistedHash !== null && { persistedHash }) });
      // 同じ取り込みの後の呼び出しが当たるように足しておく
      endpoints.push({ id, ...key });
      created.add(id);
      out.harOnly++;
      return [id];
    };

    for (const o of r.observations) {
      out.requests++;
      const segments = o.pathNorm.split('/').filter(Boolean);
      const transport = best(
        endpoints.filter(
          (e) =>
            e.operation === '' &&
            e.protocol === o.protocol &&
            (e.method === o.method || e.method === '') &&
            (e.origin === o.origin || e.origin === '') &&
            pathMatches(e.pathNorm, segments),
        ),
        o,
      );
      sight(
        resolve(transport, () => ({ protocol: o.protocol, origin: o.origin, method: o.method, pathNorm: o.pathNorm, operation: '', persistedHash: null })),
        o.params,
      );

      for (const op of o.operations) {
        if (op.name === '' && op.persistedHash === null) continue;
        const found = best(
          endpoints.filter(
            (e) =>
              e.protocol === 'graphql' &&
              e.operation !== '' &&
              (e.operation === op.name || (op.persistedHash !== null && e.persistedHash === op.persistedHash)) &&
              (op.kind === '' || e.method === '' || e.method === op.kind) &&
              (e.origin === o.origin || e.origin === '') &&
              (e.pathNorm === '' || pathMatches(e.pathNorm, segments)),
          ),
          o,
        );
        sight(
          resolve(found, () => ({
            protocol: 'graphql',
            origin: o.origin,
            method: op.kind,
            pathNorm: o.pathNorm,
            // 名前の無い persisted query は名前の代わりにハッシュで区別する
            operation: op.name || `sha256:${op.persistedHash}`,
            persistedHash: op.persistedHash,
          })),
          op.variables.map((name) => ({ name, in: 'graphql_var' as const })),
        );
      }
    }

    for (const [endpointId, p] of params) {
      const previous = unlocatedSightingParams(ctx, { endpointId, versionId: r.versionId, extractedBy: 'har' }) ?? [];
      upsertSighting(ctx, { endpointId, versionId: r.versionId, params: mergeParams(previous, p), extractedBy: 'har', runId: r.runId });
    }
    out.endpoints = params.size;
    return out;
  });
}

/** path_norm のパターン（{} は任意の 1 セグメント）に、観測したパスのセグメントが当たるか */
function pathMatches(pattern: string, segments: string[]): boolean {
  if (pattern === '') return false;
  const p = pattern.split('/').filter(Boolean);
  return p.length === segments.length && p.every((seg, i) => seg === '{}' || seg === segments[i]);
}

/** origin・method が一致するもの、固定のセグメントが多いものを優先する（同点はすべて） */
function best(found: EndpointRow[], o: HarObservation): EndpointRow[] {
  const score = (e: EndpointRow) =>
    (e.origin === o.origin ? 1000 : 0) + (e.method === o.method ? 100 : 0) + e.pathNorm.split('/').filter((s) => s !== '' && s !== '{}').length;
  const top = Math.max(...found.map(score));
  return found.filter((e) => score(e) === top);
}

function mergeParams(a: EndpointParam[], b: EndpointParam[]): EndpointParam[] {
  const out = [...a];
  for (const p of b) if (!out.some((q) => q.name === p.name && q.in === p.in)) out.push(p);
  return out;
}
