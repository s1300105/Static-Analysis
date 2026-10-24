import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type SaContext,
  createTarget,
  describeTarget,
  findTarget,
  ingestArtifacts,
  listTargets,
  newId,
  updateTargetScope,
} from '@sa/core';
import { catchError, useContext } from './helpers';

const makeCtx = useContext();
const code = (fn: () => unknown) => (catchError(fn) as { code: string }).code;
const asMcp = (ctx: SaContext): SaContext => ({ ...ctx, caller: 'mcp' });
const evidence = {
  llm_code_policy_confirmed_at: '2026-10-20',
  llm_code_policy_source_url: 'https://hackerone.com/example/policy',
};

describe('targets', () => {
  it('creates a target with an explicit deny policy by default', () => {
    const ctx = makeCtx();
    const t = createTarget(ctx, { name: ' example ', scope: { allowed_domains: ['example.com', '*.example.com'] } });
    expect(t).toMatchObject({
      name: 'example',
      scope: { allowed_domains: ['example.com', '*.example.com'], out_of_scope: [], llm_code_policy: 'deny' },
    });
    expect(listTargets(ctx).map((x) => x.id)).toEqual([t.id]);
    expect(findTarget(ctx, 'example').id).toBe(t.id);
    expect(findTarget(ctx, t.id).name).toBe('example');
  });

  it('rejects duplicate, empty and ID-shaped names', () => {
    const ctx = makeCtx();
    createTarget(ctx, { name: 'example' });
    expect(code(() => createTarget(ctx, { name: 'example' }))).toBe('INVALID_INPUT');
    expect(code(() => createTarget(ctx, { name: '  ' }))).toBe('INVALID_INPUT');
    expect(code(() => createTarget(ctx, { name: newId() }))).toBe('INVALID_INPUT');
    expect(code(() => findTarget(ctx, 'missing'))).toBe('NOT_FOUND');
  });

  it('requires a confirmation date and source URL before allowing code to go to an LLM', () => {
    const ctx = makeCtx();
    expect(code(() => createTarget(ctx, { name: 'a', scope: { llm_code_policy: 'allow' } }))).toBe('INVALID_INPUT');
    expect(
      code(() =>
        createTarget(ctx, { name: 'a', scope: { llm_code_policy: 'no_original', llm_code_policy_confirmed_at: '2026-10-20' } }),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      code(() => createTarget(ctx, { name: 'a', scope: { llm_code_policy: 'allow', ...evidence, llm_code_policy_source_url: 'policy page' } })),
    ).toBe('INVALID_INPUT');
    expect(createTarget(ctx, { name: 'a', scope: { llm_code_policy: 'allow', ...evidence } }).scope?.llm_code_policy).toBe('allow');
  });

  it('patches the scope, keeping fields that are not given', () => {
    const ctx = makeCtx();
    createTarget(ctx, { name: 'example', scope: { allowed_domains: ['example.com'], notes: 'program rules v2' } });
    const t = updateTargetScope(ctx, 'example', { llm_code_policy: 'no_original', ...evidence, out_of_scope: ['blog.example.com'] });
    expect(t.scope).toEqual({
      allowed_domains: ['example.com'],
      out_of_scope: ['blog.example.com'],
      llm_code_policy: 'no_original',
      ...evidence,
      notes: 'program rules v2',
    });
    // 証拠を外して deny 以外のままにはできない
    expect(code(() => updateTargetScope(ctx, 'example', { llm_code_policy: 'allow', llm_code_policy_source_url: 'x' }))).toBe(
      'INVALID_INPUT',
    );
    expect(code(() => updateTargetScope(ctx, 'example', { bogus: 1 } as never))).toBe('INVALID_INPUT');
  });

  it('refuses to create targets or change scope from the MCP server', () => {
    const ctx = makeCtx();
    createTarget(ctx, { name: 'example' });
    expect(code(() => createTarget(asMcp(ctx), { name: 'other' }))).toBe('POLICY_DENIED');
    expect(code(() => updateTargetScope(asMcp(ctx), 'example', { llm_code_policy: 'allow', ...evidence }))).toBe('POLICY_DENIED');
    expect(findTarget(ctx, 'example').scope?.llm_code_policy).toBe('deny');
  });

  it('describes a target with its versions and file counts per layer', async () => {
    const ctx = makeCtx();
    const t = createTarget(ctx, { name: 'example' });
    const out = new URL('./fixtures/webpack5-basic/output/', import.meta.url).pathname;
    await ingestArtifacts(ctx, {
      targetId: t.id,
      collectedAt: '2026-10-01T09:00:00Z',
      label: 'v1',
      files: readdirSync(out).map((f) => ({ path: join(out, f) })),
    });
    const d = describeTarget(ctx, 'example');
    expect(d.versions).toHaveLength(1);
    expect(d.versions[0]).toMatchObject({ label: 'v1', files: { raw: 6, unpacked: 4, original: 16 } });
  });
});
