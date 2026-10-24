/**
 * sa target: 対象とスコープの管理（design.md §8「開始前」）。scope を書けるのは CLI だけ（sa-core も caller で拒否する）。
 */
import {
  type Target,
  type TargetDetail,
  type TargetScopePatch,
  createTarget,
  describeTarget,
  listTargets,
  updateTargetScope,
} from '@sa/core';
import { LLM_CODE_POLICIES, type LlmCodePolicy } from '@sa/types';
import { type Command, Option } from 'commander';
import { type CliIo, emit, withContext } from '../io';

interface ScopeOptions {
  allow?: string[];
  outOfScope?: string[];
  llmCodePolicy?: LlmCodePolicy;
  policyConfirmedAt?: string;
  policySource?: string;
  thirdPartyCode?: 'in_scope' | 'out_of_scope' | 'report_to_vendor';
  notes?: string;
}

const collect = (value: string, previous: string[] | undefined) => [...(previous ?? []), value];

function addScopeOptions(cmd: Command): Command {
  return cmd
    .option('--allow <domain>', '許可ドメイン（繰り返し指定。指定すると一覧を置き換える）', collect)
    .option('--out-of-scope <pattern>', '対象外（繰り返し指定。指定すると一覧を置き換える）', collect)
    .addOption(new Option('--llm-code-policy <policy>', 'コードを LLM に送ってよいか（未設定は deny）').choices(LLM_CODE_POLICIES))
    .option('--policy-confirmed-at <date>', 'llm-code-policy を規約で確認した日（YYYY-MM-DD か ISO 日時）')
    .option('--policy-source <url>', 'llm-code-policy の根拠にした規約ページの URL')
    .addOption(
      new Option('--third-party-code <mode>', 'サードパーティ由来コードの扱い').choices(['in_scope', 'out_of_scope', 'report_to_vendor']),
    )
    .option('--notes <text>', 'プログラム規約のメモ');
}

function toScopePatch(o: ScopeOptions): TargetScopePatch {
  return {
    ...(o.allow !== undefined && { allowed_domains: o.allow }),
    ...(o.outOfScope !== undefined && { out_of_scope: o.outOfScope }),
    ...(o.llmCodePolicy !== undefined && { llm_code_policy: o.llmCodePolicy }),
    ...(o.policyConfirmedAt !== undefined && { llm_code_policy_confirmed_at: o.policyConfirmedAt }),
    ...(o.policySource !== undefined && { llm_code_policy_source_url: o.policySource }),
    ...(o.thirdPartyCode !== undefined && { third_party_code: o.thirdPartyCode }),
    ...(o.notes !== undefined && { notes: o.notes }),
  };
}

function targetLines(t: Target): string[] {
  const s = t.scope;
  return [
    `${t.name} (${t.id})`,
    `  allowed domains : ${s?.allowed_domains.join(', ') || '-'}`,
    `  out of scope    : ${s?.out_of_scope.join(', ') || '-'}`,
    `  llm_code_policy : ${s?.llm_code_policy ?? 'deny'}${
      s?.llm_code_policy_confirmed_at ? ` (confirmed ${s.llm_code_policy_confirmed_at}, ${s.llm_code_policy_source_url})` : ''
    }`,
    ...(s?.third_party_code ? [`  third-party code: ${s.third_party_code}`] : []),
    ...(s?.notes ? [`  notes           : ${s.notes}`] : []),
  ];
}

function detailLines(d: TargetDetail): string[] {
  const versions = d.versions.map((v) => {
    const files = Object.entries(v.files)
      .map(([layer, n]) => `${layer} ${n}`)
      .join(', ');
    return `  ${v.id}  ${v.collectedAt}  ${v.label ?? '-'}${v.baseVersionId ? `  base=${v.baseVersionId}` : ''}  [${files}]`;
  });
  return [...targetLines(d), `  versions        : ${d.versions.length}`, ...versions];
}

export function registerTargetCommands(program: Command, io: CliIo): void {
  const target = program.command('target').description('対象とスコープ（許可ドメイン・llm_code_policy など）の管理');

  addScopeOptions(target.command('add').description('対象を作る（llm_code_policy の既定は deny）').argument('<name>', '対象の名前（一意）')).action(
    async (name: string, opts: ScopeOptions, cmd: Command) => {
      const t = await withContext(cmd, io, (ctx) => createTarget(ctx, { name, scope: toScopePatch(opts) }));
      emit(cmd, io, t, () => [`created target`, ...targetLines(t)]);
    },
  );

  target
    .command('list')
    .description('対象の一覧')
    .action(async (_opts: unknown, cmd: Command) => {
      const ts = await withContext(cmd, io, (ctx) => listTargets(ctx));
      emit(cmd, io, ts, () =>
        ts.length === 0
          ? ['no targets (create one with: sa target add <name>)']
          : ts.map((t) => `${t.id}  ${t.name}  llm_code_policy=${t.scope?.llm_code_policy ?? 'deny'}  ${t.scope?.allowed_domains.join(',') ?? ''}`),
      );
    });

  target
    .command('show')
    .description('対象のスコープと版の一覧')
    .argument('<target>', '対象の ID か名前')
    .action(async (idOrName: string, _opts: unknown, cmd: Command) => {
      const d = await withContext(cmd, io, (ctx) => describeTarget(ctx, idOrName));
      emit(cmd, io, d, () => detailLines(d));
    });

  addScopeOptions(
    target.command('set-scope').description('スコープを書き換える（指定した項目だけ）').argument('<target>', '対象の ID か名前'),
  ).action(async (idOrName: string, opts: ScopeOptions, cmd: Command) => {
    const t = await withContext(cmd, io, (ctx) => updateTargetScope(ctx, idOrName, toScopePatch(opts)));
    emit(cmd, io, t, () => [`updated scope`, ...targetLines(t)]);
  });
}
