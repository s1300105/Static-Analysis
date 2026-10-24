# 実装アーキテクチャ設計書（全体設計）

対象: `docs/design.md` rev.3（commit 4763608）と `docs/plan.md`。
この文書の役割は、設計書（要件・概念設計）と実装計画（マイルストーン）の間を埋める**コードの設計図**で、
「個々の部分のコーディングに着手できる粒度」までモジュール境界・公開インターフェース・主要な型・関数シグネチャ・
横断的な規約を固めることにある。概念・根拠は設計書に、段取り・合格条件は計画書に置き、ここでは繰り返さず参照する（例: §6.3 は design.md の §6.3）。

> 方針の原則（design.md より）: **ロジックと DB アクセスは sa-core に集約**、入口（CLI / MCP / UI）は薄い層、
> **DB の書き手は sa-core だけ**、**人間の判定を書く操作は MCP に出さない**、**座標の唯一の基準は raw バイト範囲**。
> この文書の全ての設計はこの原則に従う。

---

## 1. パッケージ構成と依存方向

モノレポ（pnpm workspace）。依存は一方向で、循環を作らない。

```
@sa/types ──────────────┐  （純粋な型・列挙・定数だけ。実装・I/O を持たない）
                         ▼
                     @sa/core ────────────┐  （ロジック・検証・状態遷移・DB・ジョブ実行）
                         ▲                 │
          ┌──────────────┼─────────────────┤
          │              │                 │
      @sa/cli        @sa/mcp          @sa/eval
     (sa コマンド)  (sa-mcp サーバ)   (採点・コーパス)
                         ▲
                         │ MCP (stdio) — プロセス境界。TypeScript の import では繋がない
                  @sa/orchestrator
                 (Claude Agent SDK。sa-mcp を子プロセスとして起動)
```

| パッケージ | 役割 | 主な外部依存 | design.md |
|---|---|---|---|
| `@sa/types` | ドメイン型・列挙・`vuln_class` などの語彙・`fact_type` 対応表の定数。`zod` スキーマも置く | zod | §3.1, §6 |
| `@sa/core` | 全ロジック。唯一の DB 書き手。層生成・解析・状態遷移・事実・較正・エクスポート | better-sqlite3, @babel/*, webcrack, graphql, ulid | §4〜§7 |
| `@sa/cli` | `sa` コマンド。人間と自動化の入口。**判定の書き込みはここだけ**。採点も CLI から回す | commander（または clipanion） | §4, §8 |
| `@sa/mcp` | 薄い MCP サーバ。読み取り・解析・パイプライン書き込み**だけ**を公開 | @modelcontextprotocol/sdk | §4, §7 |
| `@sa/orchestrator` | サブエージェント（Recon/Hunter/Refuter/Triage/Reporter）。ツールは sa-mcp だけ | @anthropic-ai/claude-agent-sdk | §4, §9 |
| `@sa/eval` | 評価コーパスのビルド定義・正解・採点スクリプト（LLM 無しで回る） | — | §10 |

依存規約（CI の `dependency-cruiser` 等で機械的に守る）:
- `@sa/cli` / `@sa/mcp` / `@sa/eval` は `@sa/core` と `@sa/types` だけに依存する。入口にロジックを書かない。
- `@sa/orchestrator` は `@sa/core` を **import しない**（MCP 越しにだけ sa-core を使う）。型の共有が要れば `@sa/types` のみ可。
- `@sa/core` は入口パッケージを import しない。
- `catalog/`・`codeql/`・`docker/`・`eval/corpus`・`eval/truth` はコードではなくデータ/定義。パッケージにしない。

ディレクトリ:

```
/
├─ package.json / pnpm-workspace.yaml / tsconfig.base.json / .github/workflows/ci.yml
├─ packages/
│  ├─ types/          @sa/types
│  ├─ core/           @sa/core   (詳細は §3)
│  ├─ cli/            @sa/cli
│  ├─ mcp/            @sa/mcp
│  ├─ orchestrator/   @sa/orchestrator
│  └─ eval/           @sa/eval
├─ codeql/sa-queries/ 自前クエリパック（標準設定の委譲＋extensible predicate）
├─ catalog/           sink_catalog / known_gadgets / vulnerable_libs（git 管理・出所付き JSON）
└─ docker/            実行イメージ（jsluice・CodeQL・Semgrep の版固定、egress 制限）
```

---

## 2. ランタイム構成とプロセス境界

1 つの SQLite ファイル＋1 つの blob ストアを、3 つの入口が `@sa/core` 経由で共有する（外部キーが DB をまたげないので 1 ファイル。design.md §4）。

```
┌ プロセス A: 入口（sa-cli / sa-mcp のどれか1つ）───────────────┐
│  @sa/core を in-process で持つ（= DB 書き手）                 │
│    ├─ SQLite(WAL)  ├─ blob ストア  ├─ CodeQL DB キャッシュ     │
│    └─ JobRunner ─┬─ worker_threads: Babel parse/generate     │
│                  └─ child_process: codeql / semgrep /        │
│                       jsluice / webcrack(deobfuscate 任意)    │
└───────────────────────────────────────────────────────────────┘
┌ プロセス B: @sa/orchestrator（Claude Agent SDK）──────────────┐
│  sa-mcp を stdio の子プロセスとして起動し MCP でだけ呼ぶ        │
│  使えるツールは sa-mcp のものだけ（Bash/WebFetch 等は外す）     │
└───────────────────────────────────────────────────────────────┘
```

- **同時書き込み**: WAL でも書き込みは直列化される。CLI と MCP サーバを同時に動かす運用では、書き込みは `BEGIN IMMEDIATE`＋`busy_timeout` で衝突を待つ（design.md §6）。MVP の既定運用は「人間が CLI を叩くとき MCP サーバは止めておく」で単純化してよいが、ロックは最初から正しく張る。
- **重い処理の隔離**: 攻撃者入力をパース/実行する工程はプロセス内で直接呼ばない（JobRunner 経由。§3.4、design.md §4・§6.6）。
- **外向き通信の境界は OS/ネットワーク層**（`--network none`＋egress プロキシ、または sandbox-runtime）。SDK の設定は境界に数えない（design.md §9）。

---

## 3. `@sa/core` の内部設計

### 3.1 ディレクトリとレイヤ

```
packages/core/src/
├─ context.ts        SaContext / SaConfig の型と既定値（生成の openContext は PR-5）
├─ validate.ts       入口の値を @sa/types の zod スキーマで検証して SaError('INVALID_INPUT') にそろえる
├─ errors.ts         SaError 階層（コード付き。握りつぶさない）
├─ ids.ts            ulid() ラッパ、nowIso()
├─ db/
│  ├─ connection.ts  接続初期化（PRAGMA）、BEGIN IMMEDIATE ヘルパ withTxn()
│  ├─ migrate.ts     user_version による移行、移行前の自動複製
│  ├─ migrations/    0001_init.sql, 0002_*.sql …（番号順）
│  └─ repo/          表ごとのリポジトリ関数（SQL はここだけ。プレースホルダ必須）
│       target.ts  artifactVersion.ts  artifactFile.ts  codeLocation.ts
│       analysisRun.ts  endpoint.ts  pageContext.ts  candidate.ts  evidence.ts
│       confirmedFact.ts  factBinding.ts  dynamicResult.ts  calibration.ts …
├─ store/
│  ├─ blob.ts        content_hash による blob 保存・重複排除・読み出し
│  └─ backup.ts      VACUUM INTO / .backup
├─ jobs/
│  ├─ runner.ts      JobRunner: runWorker() / runChild()（上限・タイムアウト）
│  ├─ skips.ts       SkipLog（理由別のスキップ記録 → analysis_run.skipped_detail）
│  └─ workers/       unpack / sourcemap / endpoints / chunks の *.worker.ts（worker_threads のエントリ。index.ts が src/dist の置き場所を解決）
│                    と shared.ts（AST の走査・位置の変換）・bindings.ts（範囲ごとの変数の値）・graphql.ts（GraphQL の operation）
├─ policy/
│  ├─ paths.ts       generateWorkPath() / generateOriginalSourcePath() / assertWithinWorkspace() / writeWorkFile()（原則8）
│  ├─ llm.ts         enforceLlmCodePolicy()（コード本文を返す出口で検査）
│  └─ transitions.ts 状態遷移の権限表（誰がどの state 遷移を許されるか）
├─ artifact/         load / unpack / relink / pretty / sourcemap / chunks / har（import_har）/ position
├─ intel/            resolveLocation / getFunction / findReferences / callPath
├─ analysis/         endpoints/（normalize・extract・babel・jsluice・sightings・list）/ diffVersions / detectStack / taintPaths / originValidation
├─ findings/         candidate / evidence / refutation / triage / facts / calibration / export
└─ index.ts          公開 API（入口が呼ぶ関数だけ re-export）
```

レイヤ規約: `artifact/intel/analysis/findings` は `db/repo` と `store` と `jobs` と `policy` を使う。
`db/repo` は他のドメインモジュールを import しない（下から上への依存を作らない）。

### 3.2 コンテキストと関数スタイル

sa-core は「コンテキスト＋関数」で構成する（巨大クラスにしない）。入口はコンテキストを 1 つ作り、関数に渡す。

```ts
// context.ts
export interface SaContext {
  db: Database;               // better-sqlite3 の接続（PRAGMA 設定済み）
  store: BlobStore;
  jobs: JobRunner;
  config: SaConfig;           // workspaceDir, blobDir, codeqlPath, semgrepPath, limits, timeouts …
  logger: Logger;
  caller: CallerKind;         // 'cli' | 'mcp' | 'orchestrator' — 権限と公開範囲の判定に使う
}

export function openContext(opts: OpenContextOptions): SaContext; // 接続を開き migrate を適用
export function closeContext(ctx: SaContext): void;
```

- **トランザクション**: 読んでから書く操作（較正再計算・事実登録＋fact_event・事実評価）は `withTxn(ctx, () => {...})` で `BEGIN IMMEDIATE`。CodeQL 実行や LLM 呼び出しをまたいで開いたままにしない（design.md §6）。
- **冪等性**: `recompute_calibration`・`evaluate_facts` は冪等に作る。
- **戻り値**: ドメイン関数は作った/更新した行の ID と必要な派生値を返す。失敗は throw（SaError）、握りつぶさない。

### 3.3 DB レイヤ

- ドライバは **better-sqlite3**（同期 API。`BEGIN IMMEDIATE`＋読んで書くトランザクションが素直。`busy_timeout` 既定 5000ms）。
  将来 `node:sqlite` に差し替えられるよう、`repo/` は `Database` インターフェース越しに使う（薄い型エイリアスで可）。
- 接続初期化（接続ごと。design.md §6）:
  ```sql
  PRAGMA foreign_keys = ON;  PRAGMA busy_timeout = 5000;  PRAGMA journal_mode = WAL;
  ```
- 移行: `PRAGMA user_version` と `migrations/NNNN_*.sql`。適用前に DB ファイルを複製（`<db>.pre-NNNN.bak`）。
- 索引: 子側外部キー列に索引（`evidence(candidate_id)`、`candidate_fact(fact_id)`、`function_lineage(next_fn_id)` など）。UNIQUE 自動索引と重複させない。
- CHECK: スキーマが固まるまでは、同じ行で完結する安全上重要なもの（`confirmed_fact` の polarity×fact_type、dynamic_result の `candidate_id OR endpoint_id`）だけ。
- **スキーマ確定の順序**（計画書どおり）: §6.1 は M1、§6.2 は M2、**候補・証拠（§6.3）は M4 冒頭**、**事実（§6.4）は M5**、較正（§6.5）は M6。
  migration ファイルはこの段階に合わせて分ける（0001 骨格 → 0002 E1 → 0003 関数同一性（M3）→ 0004 候補 → 0005 事実 → 0006 較正）。
- **まだ無い表への外部キーは書かない**: `foreign_keys=ON` では、存在しない表を `REFERENCES` する列があると NULL でも INSERT が失敗する。
  そのため `code_location.fn_id → function_identity` は 0001 に置かず、`function_identity` を作る移行で `ALTER TABLE code_location ADD COLUMN fn_id TEXT REFERENCES function_identity(id)` として足す。
- 未適用の移行はまとめて 1 つの `BEGIN IMMEDIATE` で適用し、最後に `foreign_key_check` を掛ける。移行 SQL に BEGIN/COMMIT は書かない。

リポジトリ関数の形（例）:

```ts
// db/repo/candidate.ts
export function insertCandidate(ctx: SaContext, c: NewCandidate): string;   // 返り値は candidate id
export function getCandidate(ctx: SaContext, id: string): CandidateRow | undefined;
export function updatePipelineState(ctx: SaContext, id: string, to: PipelineState, ev: CandidateEventInput): void;
// 状態遷移は policy/transitions.ts を必ず経由（§3.6）
```

### 3.4 ジョブ実行器（`jobs/runner.ts`）

攻撃者入力を触る処理はすべてここを通す。失敗・タイムアウトは `analysis_run.skipped_detail` に理由別で積む（design.md §6.6）。

```ts
export interface JobRunner {
  // Babel parse/generate 等。resourceLimits と stackSizeMb を指定、wall-clock タイムアウト
  runWorker<I, O>(worker: WorkerSpec<I, O>, input: I, limits: WorkerLimits): Promise<JobResult<O>>;
  // codeql / semgrep / jsluice / webcrack。引数は配列で渡す（シェル文字列を組み立てない。原則8）
  runChild(spec: ChildSpec): Promise<JobResult<ChildOutput>>;
}
export interface WorkerLimits { maxOldGenMb: number; stackSizeMb: number; timeoutMs: number; }
export interface ChildSpec {
  bin: string; args: string[]; cwd: string; env: Record<string,string>; timeoutMs: number;
  okExitCodes?: number[]; maxOutputBytes?: number;
}
export type JobResult<O> =
  | { ok: true; value: O; durationMs: number }
  | { ok: false; reason: SkipReason; detail: string; durationMs: number };   // 呼び出し側が SkipLog に積み analysis_run に記録
// SkipReason / SkippedDetail は採点（@sa/eval）も読むので @sa/types に置く（SKIP_REASONS）:
//   parse_failed / timeout / oom / tool_error / extraction_error / unresolved_require / minified_excluded / path_excluded / unmapped
```

- worker は `worker_threads`、`resourceLimits`（`maxOldGenerationSizeMb` 等）＋`stackSizeMb`（例 64）。
  `WorkerSpec` は「入力を受けて結果を返す関数を default export する ES モジュール」の file: URL。起動コードは文字列（eval）で持ち、src と dist で置き場所を変えない。
  スキップ理由を指定して失敗させるときは worker 内で `JobSkipError` を投げる。worker には親の環境変数を渡さない（衛生のため。同一プロセスなので境界ではない）。
- 子プロセスは新しいプロセスグループで起動し、タイムアウトでグループごと `SIGKILL`（CodeQL の java など孫まで止める）。終了後に残った孫も止める。
  env は明示したものだけ（親の環境を引き継がない）、`bin` と `cwd` は絶対パス。stdout/stderr を上限付きで捕捉。
  exit code は `okExitCodes` で判定し、ツール固有の errors JSON の解釈は呼び出し側でスキップに写す。
- 同時実行数は worker・子プロセスそれぞれ上限を持ち、タイムアウトは実行枠を得てから数える。
- 失敗・タイムアウトは throw せず `JobResult` で返す（throw は引数の誤りだけ）。`SkipLog`（`jobs/skips.ts`）に積み、
  `finishAnalysisRun`（`db/repo/analysisRun.ts`）で `files_skipped` と `skipped_detail` に書く。明細は理由ごとに上限件まで、総数は必ず残す。
- 中間結果（AST など）は content_hash をキーにディスクにキャッシュし、再起動後に作り直さない（worker を使う最初の PR で入れる）。

### 3.5 設定（`SaConfig`）

環境変数と設定ファイルから作る。解析ツールのパス・上限・タイムアウト・workspace 位置を集約。CodeQL 向けの固定環境変数（`CODEQL_EXTRACTOR_JAVASCRIPT_ALLOW_MINIFIED_FILES=true` 等。design.md §6.6）もここで持ち、子プロセス env に注入する。

PR-5 で入れたもの（`config.ts`・`context.ts`）:
- home（データの置き場所）は 引数 > `SA_HOME` > `~/.sa`。既定の配置は `<home>/sa.db`・`<home>/blobs`・`<home>/workspace`。
- 設定ファイルは 引数 > `SA_CONFIG` > `<home>/config.json`（無ければ既定値だけ）。形は `@sa/types` の `SaConfigFileSchema`
  （`dbPath`・`blobDir`・`workspaceDir`・`busyTimeoutMs`・`maxWorkers`・`maxChildren`・`workerLimits`・`mapCheckThreshold`）。パスは設定ファイルからの相対でもよい。
- `openContext({ config, caller })` はディレクトリを無ければ 0700 で作り、DB を開いて移行し、blob ストアとジョブ実行器を用意する。`closeContext` で閉じる。
- 外部ツール（PR-9 で jsluice）: `tools.<name>`（`path`・`version`・`timeoutMs`。既定 120 秒）を設定ファイルに書くか、
  環境変数 `SA_TOOLS` で実行イメージの `/opt/sa/tools.json` を指す（イメージは `SA_TOOLS` を設定済み）。設定ファイルが優先。
  `version` が無ければ実行ファイルの sha256 の先頭を版として残す。CodeQL の固定環境変数は M4 で足す。

### 3.6 状態遷移の権限（`policy/transitions.ts`）

design.md §6.3 の「どのツールがどの遷移を許されるか」をコードの表で持ち、`repo` の更新関数が必ず経由する。

```ts
// 例: record_refutation は pipeline_state の new→refuted だけ。verdict/report_state は CLI/UI だけ
export function assertTransitionAllowed(caller: CallerKind, field: StateField, from: string, to: string): void;
```

- `caller='mcp'` からは verdict / report_state / fact 系・`target.scope`・`api_endpoint.triage` を**変更不可**（design.md §4・§7）。
  この境界は「MCP サーバがそのツールを公開しない」ことと、「sa-core が caller を見て拒否する」ことの**二重**で守る。
- すべての state 変更は `candidate_event` / `fact_event` に追記する（追記専用・監査ログ）。

---

## 4. ドメイン型（`@sa/types`）

DB の列と 1:1 ではなく、コードで扱う形で定義する。語彙は design.md §3.1 を単一の出所にする。

```ts
export type VulnClass =
  | 'dom_xss' | 'postmessage_recv' | 'postmessage_send'
  | 'proto_pollution' | 'pp_gadget' | 'chain_pp_xss' | 'chain_msg_storage_xss';

export type SourceKind =
  | 'hash' | 'search' | 'href' | 'referrer' | 'window_name' | 'cookie'
  | 'storage' | 'api_response' | 'message_data' | 'secret_value' | 'polluted_prop';

export type DefenseState = 'none' | 'weak' | 'unknown';
export type Layer = 'raw' | 'unpacked' | 'relinked' | 'pretty' | 'original' | 'renamed';
export type PipelineState = 'new' | 'refuted' | 'suppressed' | 'needs_human' | 'closed';
export type Verdict = 'unverified' | 'real' | 'false' | 'inconclusive';
export type LlmCodePolicy = 'deny' | 'no_original' | 'allow';   // 未設定は deny 扱い

export type FactType =
  | 'tainted_source' | 'fake_sanitizer' | 'reachable' | 'weak_origin_check'   // expand
  | 'effective_sanitizer' | 'unreachable' | 'not_controllable';               // suppress
export type Polarity = 'expand' | 'suppress';

// design.md §6.4 の対応表をコードの単一定義にする（DB にマスタ表は作らない）
export const FACT_META: Record<FactType, { polarity: Polarity; serverDependent: boolean }> = {
  tainted_source:      { polarity: 'expand',   serverDependent: true  },
  fake_sanitizer:      { polarity: 'expand',   serverDependent: false },
  reachable:           { polarity: 'expand',   serverDependent: false },
  weak_origin_check:   { polarity: 'expand',   serverDependent: false },
  effective_sanitizer: { polarity: 'suppress', serverDependent: false },
  unreachable:         { polarity: 'suppress', serverDependent: false }, // TTL は種別ごとに判断
  not_controllable:    { polarity: 'suppress', serverDependent: true  },
};

// 唯一の基準座標（design.md §6.6）
export interface RawRange { rawFileId: string; startByte: number; endByte: number; }
```

- 入口から入ってくる値（CLI 引数・MCP ツール入力・取り込みファイル）はすべて **zod スキーマで検証**してからドメイン関数に渡す。zod スキーマも `@sa/types` に置き、CLI/MCP/取り込みで共有する。

---

## 5. 機能モジュールの公開インターフェース

design.md §7 のツール表を、sa-core の関数シグネチャに落とす。すべての関数の第一引数は `ctx: SaContext`。
「MCP」列は sa-mcp が公開するか（design.md §7 と一致）。「手順」は計画書の実装手順。

### 5.1 Artifact（`artifact/`）

```ts
loadArtifact(ctx, { targetId, files: LoadArtifactFile[], versionId?, baseVersionId?, label?, collectedAt?, collectionNotes? })
  : { versionId; createdVersion; fileIds; added };                                                              // ×  手順1
importSourcemap(ctx, { versionId, mapFileId, generatedFileId? })
  : Promise<{ runId?; generatedFileId; mapCheck: MapCheck | null; accepted; originalFileIds }>;                  // ×  手順1
unpackBundle(ctx, { versionId, retryFailed? })
  : Promise<{ runId; files; moduleCount; bundlers: Record<Bundler, number>; noBoundaryCount; skipped }>;        // ×  手順1
pretty(ctx, { fileId }): { prettyFileId: string; positionMapHash: string };                                    // ×  手順3
relinkBundle(ctx, { versionId }): { relinkedFileIds: string[]; unresolvedRequire: number };                    // ×  手順4
indexFunctions(ctx, { versionId }): { functionCount: number; lineage: LineageStats };                          // ×  手順5/6
findMissingChunks(ctx, { versionId }): Promise<{ runId; chunks: ExpectedChunk[]; missing; skipped }>;          // ○読 手順2
markChunkUnavailable(ctx, versionId, chunkKey): void;  // 人間が取りに行って取れなかった印                        // ×  手順2
importHar(ctx, { targetId, harPath, versionId?, collectedAt?, label?, baseVersionId?, collectionNotes? })
  : ImportHarResult;  // ingestHar は続けて unpack・sourcemap を掛ける                                           // ×  手順2
```

`importHar` は HAR を保存せず、許可リスト項目だけ抽出する（design.md §7.1）。完了条件に「HAR を保存しないこと/値を残さないことのテスト」を含める（計画書 M2）。

PR-11 での取り決め（`artifact/har.ts`・`analysis/endpoints/har.ts`）:
- 残すもの: API の呼び出しのメソッド・パス（`normalizeEndpointUrl`。ID・UUID・16進・トークン（英数字 20 文字以上で英字と数字を含む）・
  メールアドレス（`@`・`%40`）のセグメントは `{}`）・クエリと本文（フォーム・JSON の最上位・x-www-form-urlencoded）のパラメータ名、
  GraphQL の operationName・種類・変数名・persisted query のハッシュ、JS / sourcemap の本文（raw 層。配信 URL はクエリを除く、
  読み込んだ文書のオリジンは pageref の page の title か最初の文書から）、文書のセキュリティヘッダ（CSP・CSP-Report-Only・
  X-Frame-Options・COOP・`<meta http-equiv=CSP>`。nonce と report-uri のクエリは除く。文書の URL はクエリを除きパスをテンプレート化）。
  それ以外（ヘッダ・Cookie・値・本文）はメモリの中で読むだけで書かない。テストは目印の文字列を HAR のあらゆる場所に置き、
  DB・blob・作業ディレクトリのどこにも現れないことを確かめる
- 画像・CSS・フォント・メディアと CORS のプリフライトは何も残さない。2xx 以外の文書と本文の無い JS は取り込まない
- API の照合: endpoint の path_norm の `{}` を任意の 1 セグメントとし、origin が `''`・method が `''` の endpoint はどれにも当たる。
  origin・method が一致し固定のセグメントが多いものを採る。GraphQL の operation は名前か persisted query のハッシュで照合する。
  当たらない呼び出しは HAR にしか無い endpoint として作る（名前の無い persisted query の operation は `sha256:<hash>`）。
  sighting は endpoint ごとに 1 つ（位置なし）で、同じ版の前回の HAR のパラメータと足し合わせる。照合は取り込む時点の endpoint に対して
  行うので、`sa extract-endpoints` を先に掛ける
- 版を新しく作るときの取得日時は、省けば HAR の最初の記録（page か entry）の日時。analysis_run は kind=ingest・tool=import_har

PR-12 での取り決め（`artifact/chunks.ts`・`jobs/workers/chunks.worker.ts`）:
- 参照の収集（worker）: webpack 5 のランタイムの `X.u`（チャンク ID → ファイル名。文字列・ID・`{id: …}[e]`・`({…}[e]||e)` の連結）と
  同じ X の `X.p`（文字列なら公開パス、式なら auto）、`X.e(id)`（非同期）と `X.O(void 0, [id…])`（起動時の依存）のリテラルの ID、
  `import("…")`、`new URL("….js|.mjs|.cjs|.wasm", import.meta.url)`、`sourceMappingURL`（data: を除く）と `/*! For license information please see … */`
- チャンク ID のファイル名は版のどこかのランタイムで作る（読むコードは別のファイルにあることがある）。起動時の依存は HTML が読むので、
  組み立て方の表に ID があるときだけファイル名を作る（チャンクが 1 つのとき webpack は組み立て方を定数に畳む）
- URL: 公開パスが絶対ならそれ、`/` で始まれば文書（`loaded_by_origins`）かスクリプトのオリジンから、auto ならスクリプトの配信 URL
  （`source_urls`）の場所から解く。ほかの参照はスクリプトの URL から解く。解けなければ URL は null で、書かれた値をキーにする
- `chunk_key` はチャンク ID、それ以外は URL（解けなければ書かれた値）。取得済みは raw の `chunk_key`（unpack が push の ID を入れる）、
  配信 URL（クエリを除く）、ファイル名（`orig_name`）で判定する。`host_in_scope` は `policy/scope.ts`
- 掛け直しは版の行を作り直す（参照が無くなった行は消す）。人間が付けた `unavailable` は、計算が `missing` の間は残す

手順1 の実装上の取り決め（PR-4）:
- `loadArtifact` はファイルごとに配信 URL・読み込み元オリジン・帰属・チャンクキーを受ける（`LoadArtifactFile`。zod スキーマは `@sa/types`）。
  版の中で同じ中身は 1 行にまとめて観測を足し合わせる。HAR（拡張子か `{"log":` で始まる中身）は拒否する。パースはしない。
- `unpackBundle` は webpack 5 の production 出力（チャンクの `webpackChunk*.push` とランタイムのモジュールマップ）を認識し、
  ファクトリ本体を raw の部分範囲として切り出す。モジュール ID は unpacked の `orig_name`、push のチャンク ID は raw の `chunk_key`（未設定なら）に入れる。
  認識できない形式と ESM はファイル全体を 1 つの unpacked にし、認識できなかったものは `no_module_boundary` として記録する。
  Babel の位置（UTF-16）はバイト位置に変換してから返す（BOM も 1 文字として残す）。まだ unpack していない raw だけを処理するので、版にファイルを足したら掛け直せばよい。
- `importSourcemap` の簡易検証は、生成側を「識別子の先頭か」で近似し、元側は「その位置か同じ行のそれ以降に names[i] が識別子として現れるか」で数える
  （webpack の map は元側の位置を文の先頭に丸めるため）。閾値の既定は 0.7（fixture で正しい map 0.83〜1.0、別ビルド・別チャンク 0.01〜0.25。design.md §13 で決め直す）。
  生成元は sourceMappingURL、次に `<name>.map` ↔ `<name>` で探し、決まらなければ `generatedFileId` を求める。
- worker のモジュール（`jobs/workers/*.worker.ts`）の相対 import は同じ階層の worker 用モジュール（`./shared.ts` など）だけにして拡張子を付け
  （型だけの import は可。PR-8 で tsconfig に `allowImportingTsExtensions` を足した）、消せる型構文だけを使う。
  テストでは Node の型除去でソースを、ビルド後は `dist/workers/<name>.js`（tsup が shared.ts を取り込む）を読む。後者は CI の `pnpm smoke` で確かめる。

### 5.2 Code intel（`intel/`）

```ts
resolveLocation(ctx, { layer, fileId, pos }): { locationId: string; rawRange: RawRange; astKind: string };     // ○  手順3
getFunction(ctx, { fileId?, fnId?, pos?, layer?, stripComments? }): GetFunctionResult;                         // ○  手順3
findReferences(ctx, { locationId }): Reference[];                                                               // ○  手順3
callPath(ctx, { candidateId? , pathResultId }): CallPathResult;                                                // ○  手順4
```

- `getFunction` は上限（例 40K 文字）超で内側関数をプレースホルダに畳んだ骨格＋窓を返し `truncated=true`（design.md §7.2）。
- **LLM 送信可否の強制**: コード本文を返す関数（`getFunction`/`callPath`/`findReferences` など）は戻り値を作る**出口**で `policy/llm.ts` の `enforceLlmCodePolicy(ctx, targetId, result)` を必ず通す。`deny`→エラー、`no_original`→original 層本文を外す。ローカル完結の解析（CodeQL/jsluice）は制限しない（design.md §7.2）。

### 5.3 Analysis（`analysis/`）

```ts
detectStack(ctx, { versionId }): DetectedLibrary[];                                                             // ○  手順4
extractEndpoints(ctx, { versionId, extractors? /* ast_url / jsluice / graphql */ })
  : Promise<{ versionId; extractors: { [name]: { runId; inputs; found; dropped; sightings; skipped } }; unavailable; endpoints; sightings }>; // ○ 手順2
listEndpoints(ctx, { targetId, all? }): EndpointListItem[];  // VIEW の派生値＋パラメータの和集合                  // ○読 手順2
diffVersions(ctx, { versionId, baseVersionId }): DiffResult;                                                    // ○  手順2/6
exportEndpoints(ctx, { targetId, filter }): { openapi?: object; graphql?: string };                            // ×  手順2
taintPaths(ctx, { versionId, classes }): { candidates: number; clientEntries: number; skipped: SkipDetail };   // ○  手順4/7
checkOriginValidation(ctx, { versionId }): OriginFinding[];                                                     // ○  手順4
findPpGadgets(ctx, { versionId }): Gadget[];                                                                    // ○  手順7
runRules(ctx, { versionId }): RuleHit[];                                                                        // ○  手順7
```

`extractEndpoints` は 3 抽出器（jsluice 子プロセス＋位置戻し / ast_url=Babel AST / GraphQL=graphql-js）。並び順は学習しない決定的規則（design.md §7.3）。

E1 の取り決め（PR-7・PR-8）:
- `path_norm` は `analysis/endpoints/normalize.ts` の `normalizeEndpointUrl` だけで作る（全抽出器で共通）。スコープ判定は `policy/scope.ts` と
  VIEW `api_endpoint_summary` が同じ規則を持ち、テストで一致を確かめる。
- 抽出器ごとに analysis_run を 1 行作る（tool は `extract_endpoints/ast_url`・`extract_endpoints/jsluice`・`extract_endpoints/graphql`）。
  sighting の run_id はその行。既定では使える抽出器をすべて掛ける。jsluice の設定が無ければ `unavailable` に入れて続ける（明示したときは誤り）。
  ast_url と graphql は Babel のパースを共有し（`analysis/endpoints/babel.ts`）、書き込みは ast_url → jsluice → graphql の順。
- ast_url は **HTTP クライアントの呼び出し**（fetch / new Request、`x.get/post/…`、`{ url, method, … }` の設定オブジェクトと `$.ajax`、
  `xhr.open`、`sendBeacon`、`new WebSocket` / `new EventSource`）だけを拾う。呼び出しに渡らない URL らしい文字列は jsluice（PR-9）に任せる
  （SPA のルート定義・静的ファイルのパスを拾わないため）。method の無い fetch / 設定オブジェクトは GET、method が式なら不明（`''`）。
- ベース URL は同じモジュールの中だけで推定する（`baseURL` 等の文字列、または `fetch("/api" + path)` のような送信部）。候補が 1 つのときだけ、
  メソッド名の呼び出しの相対 URL に付ける。送信部そのものはエンドポイントにしない。
- ast_url は raw の JS をファイルごと読み、unpack が切り出したモジュールの範囲を「範囲」として渡す（ベース URL と変数の値は範囲ごと。
  minify はモジュールごとに短い名前を使い回すため）。モジュールだけを読むと、webpack がランタイムの中に埋め込むエントリ
  （モジュールマップの外）を落とす。変数の値は、その範囲で値の出所が 1 つだけで、引数・for-in/of・`+=`・`++` などの別の束縛が
  無い名前だけ使う（`jobs/workers/bindings.ts`）。位置は呼び出し式の raw 基準のバイト範囲で `code_location` に置き、表示用の行・列も入れる。
- 相対 URL の origin は raw の `loaded_by_origins`（http(s) のオリジン）で補う（design.md §6.2）。複数あればそれぞれの endpoint にし、
  無ければ `''`。相対の WebSocket は ws(s) にする。パスに固定の部分が無く origin も分からない URL は捨てる（`dropped`）。
- GraphQL（PR-10。sighting の extracted_by は graphql_text / graphql_ast / relay）:
  - graphql_text: テンプレートリテラル（タグの名前は minify で変わるので問わない）・文字列・変換後のタグ付きテンプレート（文字列の配列）のうち、
    先頭が query / mutation / subscription / fragment で graphql-js が読めるもの。`${...}` は除いて読む。名前の無い `{ ... }` はタグが gql / graphql のときだけ
  - graphql_ast: `kind: "Document"` のオブジェクトリテラル。`loc.source.body` があれば読み、無ければ definitions を静的に評価する
    （リテラル・配列・オブジェクト・`!0`・代入式・`[...].concat(...)`・値の決まる変数）
  - relay: params に name と operationKind を持つオブジェクト。params.text があれば読み、無ければ argumentDefinitions から変数名。params.id を persisted_hash に
  - 生成物と DocumentNode の中の文字列は graphql_text で重ねて数えない。fragment だけの文書はエンドポイントにしない
  - endpoint: protocol は graphql、method は operation の種類（QUERY / MUTATION / SUBSCRIPTION）、operation は名前（無名は ''）、
    パラメータは変数（graphql_var）。送信先は版の GraphQL のエンドポイント（operation の無いもの）のパスが 1 つに決まればそれ（origin が複数ならそれぞれ）、
    決まらなければ origin・パスとも ''。operation の文書（本文）は保存せず、`export_endpoints`（PR-13）が位置から読み直す
- jsluice（PR-9）は raw ファイルごとに子プロセスで掛ける（tree-sitter なので Babel が読めなかったファイルも読む）。出力の癖を直す:
  同じ式の重複（method の有無だけ違う）は 1 つにまとめ、報告済みの呼び出しの範囲に入る文字列リテラルは捨て、`x.get(...)` などの
  method は `type` から補い、送信部（ast_url と同じ規則）と文字列リテラルだけの静的ファイルのパスは捨てる。
  同じ本文は同じ結果になるので、本文が何度も現れればそのすべての位置に置く。テストは記録した出力（fixture の `jsluice-urls.jsonl`）と
  偽の実行ファイルで回し、実物とは `SA_TEST_JSLUICE` があれば一致を確かめる（CI では Docker の verify.sh が実行イメージで確かめる）。
- 掛け直し: 抽出器が raw ファイルを全部読めたら、その raw にあるその抽出器の sighting を作り直す（読めない部分があれば足すだけ）。
  `api_endpoint` は triage を持つので消さない。`listEndpoints` は既定で、sighting の無くなった endpoint と、同じ protocol・origin・パスに
  メソッドの分かる endpoint があるメソッド不明の endpoint を省く（`--all` で出す）。
`taintPaths` は標準 .ql をそのまま流さず**自前クエリパック**を使い、確定事実を data extension YAML で注入する（design.md §3.4）。

### 5.4 Findings（`findings/`）★ループの心臓部

```ts
// エンジン/LLM 側（MCP ○）
registerLlmRun(ctx, run: LlmRunInput): string;                                                                 // ○  手順4
addCandidate(ctx, c: NewCandidate): string;                                                                    // ○  手順4
attachEvidence(ctx, e: NewEvidence): string;   // locationId は resolveLocation 産のみ・run_id 必須             // ○  手順4
recordRefutation(ctx, r: RefutationInput): void;                                                               // ○  手順4
applyTriage(ctx, { versionId }): TriageResult;                                                                 // ○  手順4
findChains(ctx, { versionId }): Chain[];                                                                       // ○  手順7
getConfirmedFacts(ctx, { versionId, asOf }): ConfirmedFact[];                                                  // ○読 手順6
pastVerdicts(ctx, { fingerprint?, featureKey? }): PastVerdict[];   // 他 target はコード本文を返さない           // ○読 手順6
exportTestPlan(ctx, { candidateId? , questionId? }): { files: string[] };                                      // ○  手順5
exportReportDraft(ctx, { candidateId }): ReportDraft;                                                           // ○  手順5

// 人間の判定・事実（MCP ×。CLI/UI だけ）
evaluateFacts(ctx, { versionId }): void;                                                                       // ×  手順6
recordDynamicResult(ctx, d: DynamicResultInput): string;                                                       // ×  手順5
confirmFact(ctx, f: ConfirmFactInput): string;    // polarity は FACT_META から自動設定、運用ルール検査          // ×  手順5
revokeFact(ctx, { factId, reason }): void;                                                                     // ×  手順6
setVerdict(ctx, { candidateId, verdict, actor }): void;                                                        // ×  手順5
setReportState(ctx, { candidateId, state, actor }): void;                                                      // ×  手順5
recordSubmission(ctx, s: SubmissionInput): string;                                                             // ×  手順5
recomputeCalibration(ctx, { targetId? }): void;                                                                // ×  手順6
promoteToRule(ctx, r: PromoteInput): string;      // 保存は ○ / 有効化は ×                                      // 保存○/有効化×  手順7
```

- `attachEvidence` は **`resolveLocation` が作った code_location の id と run_id だけ**を受ける（LLM 単独の座標は受け付けない。design.md §7.4・原則3）。
- `confirmFact` は design.md §6.4 の運用ルールを検査: inconclusive から抑制事実を作らない / 抑制は既定 scope=version / `observed_version_id` と `anchor_fn_id` の版一致 / `depends_on`・`valid_until` 自動補完。
- `recordRefutation` は理由種別必須＋実行コード位置の裏付け必須、on_path/off_path の軽い関連性チェック（design.md §7.4）。

---

## 6. 入口パッケージ

### 6.1 `@sa/cli`（`sa` コマンド）

sa-core の関数に 1:1 で薄く割り当てる。`caller='cli'`。判定・事実・評価はここだけ。

| コマンド | 呼ぶ関数 | 手順 |
|---|---|---|
| `sa target add` / `list` / `show` / `set-scope` | createTarget / listTargets / describeTarget / updateTargetScope（scope・llm_code_policy） | 1 |
| `sa load`（取り込み → unpack → sourcemap）/ `sa import-har` | ingestArtifacts（loadArtifact → unpackBundle → importSourcemap）/ ingestHar（importHar → 同じ流れ） | 1/2 |
| `sa extract-endpoints` / `sa endpoints` / `sa diff` / `sa export-endpoints` / `sa triage-endpoint` | extractEndpoints / listEndpoints / diffVersions / exportEndpoints / endpoint triage | 2 |
| `sa missing-chunks`（`--unavailable <key>` で取れなかった印） | findMissingChunks / markChunkUnavailable | 2 |
| `sa analyze`（detect-stack→relink→taint→triage の一括 or 個別） | detectStack / relinkBundle / taintPaths / applyTriage | 4 |
| `sa plan` | exportTestPlan | 5 |
| `sa ingest <file>` | recordDynamicResult / confirmFact / setVerdict …（ファイルの判定欄を取り込む） | 5 |
| `sa fact revoke` / `sa verdict` / `sa submission` / `sa report-draft` | revokeFact / setVerdict / recordSubmission / exportReportDraft | 5/6 |
| `sa calibrate` | recomputeCalibration | 6 |
| `sa rule activate` | promoteToRule の有効化 | 7 |
| `sa backup` | backupDatabase → verifyBackup | 1 |
| `sa purge-target` | （手順は design.md §13 で未決。決まってから） | — |
| `sa score <suite>` | @sa/eval の採点（LLM 無し） | 0'〜 |

出力は人間が読む/記入する形式（表・Markdown＋YAML）。`sa ingest` は `export_test_plan` が出したファイルの判定欄を読み、sa-core の同じ検証を通す（design.md §8）。

PR-5 での取り決め:
- 共通オプション: `--home <dir>`（既定 `$SA_HOME` か `~/.sa`）、`--config <file>`、`--json`（結果を JSON で出す）。
- `run(argv, io)` が入口。標準出力・環境変数・カレントディレクトリを `io` で受け取り、終了コードを返す（テストはプロセス内で回す）。
  終了コード: 成功 0、`INVALID_INPUT` 2、`NOT_FOUND` 3、`POLICY_DENIED` 4、その他 1。commander の使い方の誤りは commander の終了コード。
- 対象は ID か名前で指定できる（名前は一意。ID の形の名前は作れない）。
- `target.scope` の `llm_code_policy` を deny 以外にするには、規約を確認した日（`--policy-confirmed-at`）と規約ページの URL（`--policy-source`）が要る。
- `sa load` はファイルを位置引数か `--manifest`（`LoadArtifactFile` の JSON 配列。配信 URL 等を持てる）で受ける。新しい版には `--collected-at`（ISO 8601 か `now`）が要る。
  生成元が決まらない sourcemap はその map だけ取り込まずに続け、理由を表示する。
- ビルド後の `sa` を実際に起動して一通り動かす `pnpm smoke` を CI で回す。
- `sa extract-endpoints <target>` は `--version-id` を省けば取得日時が最も新しい版を読む（PR-8）。`--extractor` で抽出器を選べる（PR-9）。`sa endpoints <target>` は
  メソッド・URL（origin＋path_template）・パラメータ（置き場所:名前）・スコープ・sighting の数を 1 行ずつ出す。

### 6.2 `@sa/mcp`（sa-mcp サーバ）

MCP TypeScript SDK（stdio）。`caller='mcp'`。design.md §7 で「MCP ○」のツールだけを登録する。

- 各 MCP ツールは「zod で入力検証 → sa-core 関数 → 結果を MCP レスポンスに整形」だけ。ロジックを書かない。
- `sink_catalog`・`known_gadgets`・`vulnerable_libs` は tool ではなく **MCP resource**（静的データ・git 管理。design.md §4）。
- 人間判定・事実・`target.scope`・`api_endpoint.triage` の書き込みツールは**登録しない**（二重防御の一層。もう一層は §3.6 の caller 拒否）。
- MCP からエージェントを起動しない（反証役の起動は Orchestrator の責務）。

### 6.3 `@sa/orchestrator`（Claude Agent SDK）

MVP では手順4（M4）で導入。それまでは §5.3 の決定的な並びとクラス既定値で動く（計画書）。

- サブエージェント: **Recon → Hunter(クラス別) → Refuter → Triage → Reporter**（design.md §5）。
- **ツールは sa-mcp の MCP ツールだけ**にする。`mcpServers` に sa-mcp を stdio で登録し、Bash/WebFetch/WebSearch は与えない。
  `allowedTools`（自動承認）は制限ではないので境界に使わない。境界は OS/ネットワーク層と、MCP が危険ツールを公開しないこと（design.md §9）。
- LLM 実行記録: Orchestrator が各サブエージェントの結果メッセージから **モデル ID（fallback 後の実値）とトークン使用量**を取り出し、`registerLlmRun` で `analysis_run` に登録して run_id を得る。その run_id を `addCandidate`/`attachEvidence` に渡す。
- セッション記録の保持方針は design.md §9（`persistSession` 相当の設定・`cleanupPeriodDays`）に従う。

> 注: Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）の正確な API 名（サブエージェント定義・`mcpServers`・結果メッセージからの usage 取得・セッション保持フラグ）は、この部分の実装（M4）時に公式ドキュメントで確認してから確定する。MVP 前半（M0〜M3）はこのパッケージを必要としない。

---

## 7. 外部ツール連携（子プロセス仕様）

すべて版を固定（`docker/` でピン留め）し、`analysis_run.tool_version` に残す。引数は配列、オフライン設定（design.md §1・§9）。

| ツール | 実行 | 主なフラグ/環境 | 位置の戻し | design.md |
|---|---|---|---|---|
| CodeQL CLI | child | `CODEQL_EXTRACTOR_JAVASCRIPT_ALLOW_MINIFIED_FILES=true` 常設、`--ram` 指定、パック事前取得、`LGTM_INDEX_FILTERS` で include 制御 | SARIF 位置 → relinked/pretty の position_map → raw | §3.4, §6.6 |
| Semgrep | child | `--metrics=off` `--disable-version-check` `--timeout` `--max-target-bytes`、対象ファイル明示 | モジュール/pretty → raw | §6.6 |
| jsluice | child(Go) | `urls --include-source --placeholder EXPR <blob の絶対パス>`、env は空。http(s) の引数は取りに行くので渡さない | `source` を raw のバイト列で探し、出現するすべての位置へ（見つからなければ unmapped） | §7.3 |
| webcrack unminify/unpack | worker | AST 操作のみ | AST 元位置（renamed は証拠に使わない） | §6.6 |
| webcrack deobfuscate | child（別プロセス） | **既定オフ**、`--network none`、isolated-vm の `memoryLimit`/`timeout`、入出力ファイルのみ受け渡し | — | §6.6 |

- **安全網**（design.md §6.6）: CodeQL DB 作成後に「投入予定ファイル一覧」と「DB に抽出されたファイル一覧」を突き合わせ、差分を理由付きでスキップに記録し、想定外の差分は失敗にする。これは `analysis/taintPaths` の中で必ず実行する。

---

## 8. 座標系と層（実装上の要点）

design.md §6.6 の規約を実装規則として固定する。

- `code_location` を作るのは **`resolveLocation` とエンジン出力の取り込みだけ**。他のモジュールは既存の locationId を参照する。
- 層 → raw の逆写像:
  - `unpacked`: `raw_offset` の加算だけ。
  - `relinked`/`pretty`/`original`: position_map（blob）。**完全一致のセグメントのみ**採用し、最近傍丸めはしない。0 件はスキップ記録、複数件は各々 code_location 化、経路途中だけ戻せないものは needs_human。
- **往復テスト**を CI 必須にする: pretty 層・relinked 層の全トークンで「raw に戻した範囲の文字列が同じトークン」を検証（計画書 M1/M3/M4 の完了条件）。
- 機械解析を掛ける層の既定: CodeQL は original→relinked→pretty、Semgrep は unpacked→pretty（design.md §6.6）。

---

## 9. 横断的規約

- **ID/時刻**: ULID（`ids.ts`）、ISO 8601 UTC。
- **エラー**: `SaError`（`code`・`message`・`detail`）。MCP は MCP エラーへ、CLI は非 0 終了＋メッセージへ変換。書き込み失敗は握りつぶさない（design.md §6）。
- **入力検証**: 入口の入力はすべて zod（`@sa/types`）。SQL はプレースホルダのみ。パスは `generateWorkPath()` 生成＋`assertWithinWorkspace()`（原則8）。
- **信頼しない入力**: ターゲット由来文字列・LLM 出力・人間記入値はデータとして扱う。`orig_name` は表示専用列に置きパスに使わない（design.md 原則8）。
- **ログ**: 構造化ログ（JSON 行）。送信記録は Orchestrator 側。秘匿値（HAR 由来の値など）はログに出さない。
- **テスト**: 単体は sa-core の関数単位。入口のテストは薄く。往復テスト・HAR 非保存テスト・ポリシー強制テスト（deny/no_original で本文が返らない）・事実の回帰（陽性/陰性 1 組）を各マイルストーンの完了条件に紐付ける。
- **CI**: lint（eslint）＋型検査（tsc --noEmit）＋テスト（vitest 想定）＋依存方向チェック＋往復テスト。
- **モデル識別子**: コミット・PR・コード・コメント等の成果物に LLM のモデル名を書かない（`analysis_run.model_id` は実行時に記録する DB 値であり、ソースに定数で埋めない）。

---

## 10. コーディング着手の順序（最初の PR 単位）

計画書 M0〜M1 を、レビューしやすい PR に割る。各 PR はテストと CI を伴う。

1. **PR-1 モノレポ雛形**: pnpm workspace、tsconfig.base、eslint、vitest、CI、依存方向チェック、`@sa/types` の空実装と語彙定数（§4）。
2. **PR-2 DB 基盤**: `db/connection`（PRAGMA）、`db/migrate`（user_version＋自動複製）、`0001_init.sql`（§6.1 の target/artifact_version/artifact_file/code_location/analysis_run/expected_chunk）、`withTxn`、`ids`、`errors`、`store/blob`、`store/backup`。
3. **PR-3 ジョブ実行器**: `jobs/runner`（worker＋child、上限・タイムアウト・スキップ記録）、`policy/paths`。
4. **PR-4 取り込みと層（最小）**: `loadArtifact`、`unpackBundle`（webpack 5 production 1 種）、`importSourcemap`、unpacked 往復テスト。
5. **PR-5 CLI 骨格**: `sa target` / `sa load`、`openContext`/`closeContext`、設定読み込み。
6. **PR-6 実行イメージ**: `docker/`（jsluice・CodeQL・Semgrep の版固定、egress 制限）と D4 の確認。
   → D4 は既定案で決定。LLM を使わない解析は `docker run --network none`、LLM を使うときは内部ネットワーク（`internal: true`）＋
   `api.anthropic.com:443` だけを通す squid（`docker/compose.yaml`）。確認は `docker/verify.sh`（CI: `.github/workflows/docker.yml`）。

M2（第1段 E1。計画書 M2）の PR 単位:

7. **PR-7 E1 のスキーマ**: `0002_e1.sql`（`api_endpoint`・`endpoint_sighting`・`page_context`、派生値の VIEW `api_endpoint_summary`）、
   `path_norm` の正規化（`analysis/endpoints/normalize.ts`）、スコープ判定（`policy/scope.ts`。VIEW の in_scope と同じ規則）、リポジトリ関数。
8. **PR-8 ast_url 抽出器**: Babel AST から HTTP クライアントの呼び出しを拾う `extractEndpoints`（worker）、`listEndpoints`、`sa extract-endpoints` / `sa endpoints`。
9. **PR-9 jsluice 抽出器**: 子プロセス＋raw への位置戻し。ツールのパスを設定（`tools`・`SA_TOOLS`）に足す。
10. **PR-10 GraphQL 抽出**: graphql-js（本文・DocumentNode・Relay・persisted hash）。あわせて ast_url を raw のファイルごとの読み取りに直した
    （webpack のランタイムに埋め込まれたエントリを落としていた）。
11. **PR-11 `import_har`**: 許可リスト抽出（HAR を保存しない・値を残さないテスト）、`page_context`、`extracted_by='har'` の sighting。
12. **PR-12 `find_missing_chunks`**: チャンクマップ・動的 import・`sourceMappingURL`・`*.LICENSE.txt`、対象外ホストの区別。
13. **PR-13 `diff_versions`・並び順・`export_endpoints`・triage**: 版間差分（未収集による差を別枠）、決定的な並び順、OpenAPI 3 / GraphQL 文書、`sa triage-endpoint`。
14. **PR-14 sa-mcp の最小版**: `extract_endpoints` / `diff_versions` / `find_missing_chunks` を読み取りとして公開。
15. **PR-15 手順6の前提確認**: 実デプロイ 2 版で関数の exact / fuzzy / 不一致の割合を記録するスクリプト。

並行して `@sa/eval` 側で M0（E1 採点基盤）を進められる（計画書 §3 の依存関係）。
以降は計画書のマイルストーン（M2 以降）に従い、本文書の §5 のシグネチャを実装していく。

---

## 11. この文書と design.md / plan.md の関係

- **design.md rev.3**: 何を・なぜ作るか（要件・概念設計・スキーマ・評価）。意味論の最終的な出所。
- **plan.md**: いつ・どの順で作るか（マイルストーン・合格/撤退条件）。
- **architecture.md（本書）**: どう作るか（パッケージ境界・モジュール・型・シグネチャ・規約）。
  design.md と食い違いがあれば design.md を正とし、本書を直す。スキーマの確定段階は plan.md の手順に合わせる。
```
