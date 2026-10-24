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
  return row && toTarget(row);
}

export function listTargets(ctx: HasDb): Target[] {
  const rows = dbCall(() => ctx.db.prepare('SELECT * FROM target ORDER BY id').all() as TargetDbRow[]);
  return rows.map(toTarget);
}

export function findTargetsByName(ctx: HasDb, name: string): Target[] {
  const rows = dbCall(() => ctx.db.prepare('SELECT * FROM target WHERE name = ? ORDER BY id').all(name) as TargetDbRow[]);
  return rows.map(toTarget);
}

/** scope を丸ごと置き換える（検証済みの値を渡す。CLI 専用の操作かどうかの検査は呼び出し側） */
export function setTargetScope(ctx: HasDb, id: string, scope: TargetScope): void {
  dbCall(() => ctx.db.prepare('UPDATE target SET scope = ? WHERE id = ?').run(JSON.stringify(scope), id));
}

function toTarget(row: TargetDbRow): Target {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope === null ? null : (JSON.parse(row.scope) as TargetScope),
    createdAt: row.created_at,
  };
}
