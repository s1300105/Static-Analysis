/**
 * 対象（target）の管理（design.md §6.1・§8「開始前」、`sa target`）。
 * scope（許可ドメイン・対象外・llm_code_policy・サードパーティ由来コードの扱い）は人間の判断なので CLI からだけ書ける。
 * llm_code_policy を deny 以外にするときは、確認日と根拠の URL を必ず添える（design.md §6.1・§7.2。未設定は deny 扱い）。
 */
import { type Layer, type TargetScope, type TargetScopeInput, TargetScopeSchema } from '@sa/types';
import type { SaContext } from './context';
import { countArtifactFilesByLayer } from './db/repo/artifactFile';
import { type ArtifactVersion, listArtifactVersions } from './db/repo/artifactVersion';
import {
  type Target,
  findTargetsByName,
  getTarget,
  insertTarget,
  listTargets as listTargetRows,
  setTargetScope,
} from './db/repo/target';
import { SaError } from './errors';
import { isUlid } from './ids';
import { assertHumanCaller } from './policy/caller';
import { parseInput } from './validate';

export type { Target } from './db/repo/target';

export interface VersionSummary extends ArtifactVersion {
  /** 層ごとのファイル数 */
  files: Partial<Record<Layer, number>>;
}

export interface TargetDetail extends Target {
  /** 取得日時の順 */
  versions: VersionSummary[];
}

/** scope の一部を書き換える指定。省いた項目は今の値のまま */
export type TargetScopePatch = Partial<TargetScopeInput>;

export function createTarget(ctx: SaContext, input: { name: string; scope?: TargetScopeInput }): Target {
  assertHumanCaller(ctx, 'creating a target (it sets target.scope)');
  const name = input.name.trim();
  if (name === '') throw new SaError('INVALID_INPUT', 'target name must not be empty');
  // ID と名前のどちらでも指定できるように、ID の形の名前は使わせない
  if (isUlid(name)) throw new SaError('INVALID_INPUT', 'target name must not look like an ID');
  if (findTargetsByName(ctx, name).length > 0) throw new SaError('INVALID_INPUT', `target already exists: ${name}`);
  const scope = checkScope(parseInput(TargetScopeSchema, input.scope ?? {}, 'target.scope'));
  const id = insertTarget(ctx, { name, scope });
  return getTarget(ctx, id)!;
}

export function listTargets(ctx: SaContext): Target[] {
  return listTargetRows(ctx);
}

/** ID か名前で対象を探す */
export function findTarget(ctx: SaContext, idOrName: string): Target {
  if (isUlid(idOrName)) {
    const t = getTarget(ctx, idOrName);
    if (t) return t;
  }
  const byName = findTargetsByName(ctx, idOrName);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new SaError('INVALID_INPUT', `several targets are named ${idOrName}; use the ID`);
  throw new SaError('NOT_FOUND', `target not found: ${idOrName}`);
}

export function describeTarget(ctx: SaContext, idOrName: string): TargetDetail {
  const target = findTarget(ctx, idOrName);
  const versions = listArtifactVersions(ctx, target.id).map((v) => ({ ...v, files: countArtifactFilesByLayer(ctx, v.id) }));
  return { ...target, versions };
}

export function updateTargetScope(ctx: SaContext, idOrName: string, patch: TargetScopePatch): Target {
  assertHumanCaller(ctx, 'changing target.scope');
  const target = findTarget(ctx, idOrName);
  const current = target.scope ?? TargetScopeSchema.parse({});
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const scope = checkScope(parseInput(TargetScopeSchema, { ...current, ...defined }, 'target.scope'));
  setTargetScope(ctx, target.id, scope);
  return getTarget(ctx, target.id)!;
}

function checkScope(scope: TargetScope): TargetScope {
  if (scope.llm_code_policy !== 'deny' && (!scope.llm_code_policy_confirmed_at || !scope.llm_code_policy_source_url)) {
    throw new SaError(
      'INVALID_INPUT',
      `llm_code_policy=${scope.llm_code_policy} needs llm_code_policy_confirmed_at and llm_code_policy_source_url (the program rule you checked)`,
    );
  }
  return scope;
}
