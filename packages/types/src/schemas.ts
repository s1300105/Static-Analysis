/**
 * 入口（CLI / MCP / 取り込み）が共有する zod スキーマの器。
 * いまは target.scope（design.md §6.1）と load_artifact の入力。以降の手順でツール入力ごとにスキーマを足していく。
 */
import { z } from 'zod';
import { LLM_CODE_POLICIES, OWNERSHIPS } from './vocab';

/** 未設定は deny 扱い（design.md §7.2） */
export const LlmCodePolicySchema = z.enum(LLM_CODE_POLICIES).default('deny');

export const ThirdPartyCodeSchema = z.enum(['in_scope', 'out_of_scope', 'report_to_vendor']);

/** target.scope: 許可ドメイン・対象外・プログラム規約メモ・LLM 送信可否（design.md §6.1） */
export const TargetScopeSchema = z
  .object({
    allowed_domains: z.array(z.string().min(1)).default([]),
    out_of_scope: z.array(z.string().min(1)).default([]),
    llm_code_policy: LlmCodePolicySchema,
    /** llm_code_policy の確認日（日付か日時）と根拠の URL（プログラム規約のページ）（design.md §6.1） */
    llm_code_policy_confirmed_at: z.union([z.string().date(), z.string().datetime({ offset: true })]).optional(),
    llm_code_policy_source_url: z.string().url().optional(),
    third_party_code: ThirdPartyCodeSchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

export type TargetScope = z.infer<typeof TargetScopeSchema>;
/** 入力側の形（既定値のある項目は省ける） */
export type TargetScopeInput = z.input<typeof TargetScopeSchema>;

export const OwnershipSchema = z.enum(OWNERSHIPS);

/** load_artifact に渡す 1 ファイル（design.md §7.1）。path は人間が指定した手元のファイル（作業パスではない） */
export const LoadArtifactFileSchema = z
  .object({
    path: z.string().min(1),
    /** 表示用の名前（既定はファイル名）。パスには使わない */
    origName: z.string().min(1).optional(),
    /** 配信 URL（HAR または人間の入力） */
    sourceUrls: z.array(z.string().url()).optional(),
    /** その script を読み込んだ文書のオリジン */
    loadedByOrigins: z.array(z.string().url()).optional(),
    ownership: OwnershipSchema.optional(),
    /** ランタイムのチャンクマップ上の ID/名前。省けば unpack_bundle がチャンクの push から埋める */
    chunkKey: z.string().min(1).optional(),
  })
  .strict();

/**
 * load_artifact の入力（design.md §7.1）。versionId を渡せば既存の版にファイルを足す。
 * 版を新しく作るときは collectedAt（人間が取得した日時）が要る。label / baseVersionId / collectionNotes も版を作るときだけ。
 */
export const LoadArtifactInputSchema = z
  .object({
    targetId: z.string().min(1),
    files: z.array(LoadArtifactFileSchema).min(1),
    versionId: z.string().min(1).optional(),
    baseVersionId: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    collectedAt: z.string().datetime({ offset: true }).optional(),
    collectionNotes: z.record(z.unknown()).optional(),
  })
  .strict();

export type LoadArtifactFile = z.input<typeof LoadArtifactFileSchema>;
export type LoadArtifactInput = z.input<typeof LoadArtifactInputSchema>;

const PositiveInt = z.number().int().positive();

/**
 * 設定ファイル（<home>/config.json）の形（docs/architecture.md §3.5）。すべて省略でき、省いた項目は既定値。
 * パスは設定ファイルの場所からの相対でもよい。
 */
export const SaConfigFileSchema = z
  .object({
    /** SQLite の DB ファイル。既定 <home>/sa.db */
    dbPath: z.string().min(1).optional(),
    /** blob ストア。既定 <home>/blobs */
    blobDir: z.string().min(1).optional(),
    /** 作業ディレクトリ（ツールが生成するパスはすべてこの下）。既定 <home>/workspace */
    workspaceDir: z.string().min(1).optional(),
    busyTimeoutMs: z.number().int().nonnegative().optional(),
    maxWorkers: PositiveInt.optional(),
    maxChildren: PositiveInt.optional(),
    workerLimits: z
      .object({ maxOldGenMb: PositiveInt.optional(), stackSizeMb: PositiveInt.optional(), timeoutMs: PositiveInt.optional() })
      .strict()
      .optional(),
    /** sourcemap の簡易検証の一致率の閾値（0〜1） */
    mapCheckThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();

export type SaConfigFile = z.infer<typeof SaConfigFileSchema>;
