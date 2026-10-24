/**
 * エンドポイントの triage（人間の判断。design.md §6.2・§7.3）と、並び順の規則（学習しない決定的な規則）。
 * - triage は CLI からだけ書ける（policy/caller.ts）。書いた時点のパラメータの集合のハッシュを triaged_params_hash に残し、
 *   後で新しいパラメータが見つかればハッシュが変わるので、人間のキューに再浮上させる
 * - 並び順（design.md §7.3）: 1. 最新版で初出 2. HAR で未観測 3. 状態を変えるメソッド（POST/PUT/PATCH/DELETE・GraphQL の MUTATION）
 *   4. ui_guard が管理者・内部ロールを示す 5. ID らしいパラメータを含む。どれに当たったかを rules に併記する。
 *   その前に、triage していないものとパラメータが変わったもの（needsTriage）を先に出す
 * 「最新版で初出」は静的な抽出器（HAR を除く）が最初に見つけた版で決める。未収集のチャンクを区別した差分は diff_versions が出す。
 */
import { createHash } from 'node:crypto';
import { ENDPOINT_TRIAGES, type EndpointParam, type EndpointTriage } from '@sa/types';
import type { SaContext } from '../../context';
import { listArtifactVersions } from '../../db/repo/artifactVersion';
import { endpointParams, firstStaticSeen, listEndpointRows, setEndpointTriage } from '../../db/repo/endpoint';
import { SaError } from '../../errors';
import { assertHumanCaller } from '../../policy/caller';
import { type EndpointListItem, listEndpoints } from './list';

export const ORDER_RULES = ['new_in_latest', 'not_in_har', 'state_changing', 'admin_guard', 'id_param'] as const;
export type OrderRule = (typeof ORDER_RULES)[number];

export interface RankedEndpoint extends EndpointListItem {
  /** 当たった並び順の規則（ORDER_RULES の順） */
  rules: OrderRule[];
  /** triage していないか、triage の後にパラメータが変わった */
  needsTriage: boolean;
  paramsChangedSinceTriage: boolean;
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'MUTATION']);
const ADMIN_GUARD_RE = /admin|internal|staff|super|root|moderator|operator/i;
const ID_PARAM_RE = /^(id|uuid|guid)$|(_id|Id|ID|_uuid|Uuid|UUID|_guid|Guid)$/;

/** パラメータの集合のハッシュ（置き場所と名前。並びに依らない） */
export function paramsHash(params: EndpointParam[]): string {
  const keys = [...new Set(params.map((p) => `${p.in}:${p.name}`))].sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex');
}

/** 人間が triage を付ける（CLI だけ） */
export function triageEndpoint(
  ctx: SaContext,
  input: { targetId: string; endpointId: string; triage: EndpointTriage },
): { endpointId: string; triage: EndpointTriage; paramsHash: string } {
  assertHumanCaller(ctx, 'setting api_endpoint.triage');
  if (!(ENDPOINT_TRIAGES as readonly string[]).includes(input.triage)) {
    throw new SaError('INVALID_INPUT', `triage must be one of ${ENDPOINT_TRIAGES.join(' / ')}: ${input.triage}`);
  }
  if (!listEndpointRows(ctx, input.targetId).some((e) => e.id === input.endpointId)) {
    throw new SaError('NOT_FOUND', `api_endpoint not found in the target: ${input.endpointId}`);
  }
  const hash = paramsHash(endpointParams(ctx, input.endpointId));
  setEndpointTriage(ctx, input.endpointId, input.triage, hash);
  return { endpointId: input.endpointId, triage: input.triage, paramsHash: hash };
}

/** 決定的な並び順で返す（needsTriage → 規則 1〜5 → パス・メソッド・origin・operation） */
export function rankEndpoints(ctx: SaContext, opts: { targetId: string; all?: boolean }): RankedEndpoint[] {
  const versions = listArtifactVersions(ctx, opts.targetId);
  const latest = versions.length >= 2 ? versions[versions.length - 1]!.collectedAt : undefined;
  const firstSeen = latest !== undefined ? firstStaticSeen(ctx, opts.targetId) : new Map<string, string>();
  const ranked = listEndpoints(ctx, { targetId: opts.targetId, ...(opts.all !== undefined && { all: opts.all }) }).map((e): RankedEndpoint => {
    const rules: OrderRule[] = [];
    if (latest !== undefined && firstSeen.get(e.id) === latest) rules.push('new_in_latest');
    if (!e.observedInHar) rules.push('not_in_har');
    if (STATE_CHANGING.has(e.method)) rules.push('state_changing');
    if (e.uiGuard !== null && ADMIN_GUARD_RE.test(e.uiGuard)) rules.push('admin_guard');
    if (e.pathNorm.split('/').includes('{}') || e.params.some((p) => ID_PARAM_RE.test(p.name))) rules.push('id_param');
    const changed = e.triage !== 'untested' && e.triagedParamsHash !== null && e.triagedParamsHash !== paramsHash(e.params);
    return { ...e, rules, needsTriage: e.triage === 'untested' || changed, paramsChangedSinceTriage: changed };
  });
  const key = (e: RankedEndpoint) => [e.needsTriage ? 0 : 1, ...ORDER_RULES.map((r) => (e.rules.includes(r) ? 0 : 1))];
  return ranked.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return (
      a.pathNorm.localeCompare(b.pathNorm) ||
      a.method.localeCompare(b.method) ||
      a.origin.localeCompare(b.origin) ||
      a.operation.localeCompare(b.operation)
    );
  });
}
