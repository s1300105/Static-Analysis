/**
 * 入口（CLI / MCP / 取り込み）が共有する zod スキーマの器。
 * ここでは target.scope（design.md §6.1）だけを定義して方針を示す。
 * 以降の手順でツール入力ごとにスキーマを足していく。
 */
import { z } from 'zod';
import { LLM_CODE_POLICIES } from './vocab';

/** 未設定は deny 扱い（design.md §7.2） */
export const LlmCodePolicySchema = z.enum(LLM_CODE_POLICIES).default('deny');

export const ThirdPartyCodeSchema = z.enum(['in_scope', 'out_of_scope', 'report_to_vendor']);

/** target.scope: 許可ドメイン・対象外・プログラム規約メモ・LLM 送信可否（design.md §6.1） */
export const TargetScopeSchema = z
  .object({
    allowed_domains: z.array(z.string()).default([]),
    out_of_scope: z.array(z.string()).default([]),
    llm_code_policy: LlmCodePolicySchema,
    /** llm_code_policy の確認日と URL（design.md §6.1） */
    llm_code_policy_confirmed_at: z.string().optional(),
    llm_code_policy_source_url: z.string().optional(),
    third_party_code: ThirdPartyCodeSchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

export type TargetScope = z.infer<typeof TargetScopeSchema>;
