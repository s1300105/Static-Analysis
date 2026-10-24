/**
 * target（対象）のリポジトリ関数（design.md §6.1）。
 * scope の変更は CLI/UI 専用の操作（design.md §4）。その権限の検査は target を扱うドメイン関数（PR-5 の sa target）で行う。
 */
import { type TargetScope, type TargetScopeInput, TargetScopeSchema } from '@sa/types';
import { SaError } from '../../errors';
import { newId, nowIso } from '../../ids';
import { parseInput } from '../../validate';
import { type HasDb, dbCall } from '../connection';

export interface Target {
  id: string;
  name: string;
  scope: TargetScope | null;
  createdAt: string | null;
}

interface TargetDbRow {
  id: string;
  name: string;
  scope: string | null;
  created_at: string | null;
}

export function insertTarget(ctx: HasDb, t: { name: string; scope?: TargetScopeInput }): string {
  if (t.name.trim() === '') throw new SaError('INVALID_INPUT', 'target name must not be empty');
  const scope = t.scope === undefined ? null : JSON.stringify(parseInput(TargetScopeSchema, t.scope, 'target.scope'));
  const id = newId();
  dbCall(() =>
    ctx.db.prepare('INSERT INTO target (id, name, scope, created_at) VALUES (?, ?, ?, ?)').run(id, t.name, scope, nowIso()),
  );
  return id;
}

export function getTarget(ctx: HasDb, id: string): Target | undefined {
  const row = dbCall(() => ctx.db.prepare('SELECT * FROM target WHERE id = ?').get(id) as TargetDbRow | undefined);
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    scope: row.scope === null ? null : (JSON.parse(row.scope) as TargetScope),
    createdAt: row.created_at,
  };
}
