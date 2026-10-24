/**
 * ドメイン語彙。design.md §3.1 と §6 を単一の出所にする。
 * 各語彙は `as const` のタプルで持ち、そこから union 型を導く（実行時に反復・検証できるようにするため）。
 */

// --- 脆弱性クラス（design.md §3.1） ---
export const VULN_CLASSES = [
  'dom_xss',
  'postmessage_recv',
  'postmessage_send',
  'proto_pollution',
  'pp_gadget',
  'chain_pp_xss',
  'chain_msg_storage_xss',
] as const;
export type VulnClass = (typeof VULN_CLASSES)[number];

// --- source 種別（design.md §3.1） ---
export const SOURCE_KINDS = [
  'hash',
  'search',
  'href',
  'referrer',
  'window_name',
  'cookie',
  'storage',
  'api_response',
  'message_data',
  'secret_value',
  'polluted_prop',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

// client_entry.kind: SOURCE_KINDS のうちクライアント入口に当たる部分集合（design.md §6.2）
export const CLIENT_ENTRY_KINDS = [
  'hash',
  'search',
  'href',
  'referrer',
  'window_name',
  'storage',
  'message_data',
  'api_response',
] as const;
export type ClientEntryKind = (typeof CLIENT_ENTRY_KINDS)[number];

// --- 防御状態（design.md §3.1。有効な防御は候補にならないので値に含めない） ---
export const DEFENSE_STATES = ['none', 'weak', 'unknown'] as const;
export type DefenseState = (typeof DEFENSE_STATES)[number];

// --- 成果物の層（design.md §6.6） ---
export const LAYERS = ['raw', 'unpacked', 'relinked', 'pretty', 'original', 'renamed'] as const;
export type Layer = (typeof LAYERS)[number];

// --- バンドラ（unpack_bundle が記録。design.md §6.1） ---
export const BUNDLERS = ['webpack', 'browserify', 'turbopack', 'esm', 'unknown'] as const;
export type Bundler = (typeof BUNDLERS)[number];

// --- API プロトコル（design.md §6.2） ---
export const PROTOCOLS = ['rest', 'graphql', 'websocket'] as const;
export type Protocol = (typeof PROTOCOLS)[number];

// --- 候補の状態（3軸。design.md §6.3） ---
export const PIPELINE_STATES = ['new', 'refuted', 'suppressed', 'needs_human', 'closed'] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];

export const VERDICTS = ['unverified', 'real', 'false', 'inconclusive'] as const;
export type Verdict = (typeof VERDICTS)[number];

// report_state は外部の信号で増えうるので固定の union にはせず string 扱い。代表値だけ定数で置く。
export const REPORT_STATES = [
  'none',
  'reported',
  'accepted',
  'duplicate_by_program',
  'informative',
  'wontfix',
] as const;
export type ReportState = (typeof REPORT_STATES)[number] | (string & {});

// --- 関数同一性の対応種別（design.md §6.1） ---
export const MATCH_KINDS = ['exact', 'fuzzy', 'sourcemap', 'ambiguous'] as const;
export type MatchKind = (typeof MATCH_KINDS)[number];

// --- LLM 送信可否ポリシー（design.md §7.2。未設定は deny 扱い） ---
export const LLM_CODE_POLICIES = ['deny', 'no_original', 'allow'] as const;
export type LlmCodePolicy = (typeof LLM_CODE_POLICIES)[number];

// --- 確定事実の種別と極性（design.md §6.4） ---
export const EXPAND_FACT_TYPES = [
  'tainted_source',
  'fake_sanitizer',
  'reachable',
  'weak_origin_check',
] as const;
export const SUPPRESS_FACT_TYPES = ['effective_sanitizer', 'unreachable', 'not_controllable'] as const;
export const FACT_TYPES = [...EXPAND_FACT_TYPES, ...SUPPRESS_FACT_TYPES] as const;
export type FactType = (typeof FACT_TYPES)[number];

export const POLARITIES = ['expand', 'suppress'] as const;
export type Polarity = (typeof POLARITIES)[number];

export interface FactMeta {
  /** 候補を広げる側か、消す側か */
  readonly polarity: Polarity;
  /** サーバ挙動に依存する事実は valid_until（TTL）必須（design.md §6.4） */
  readonly serverDependent: boolean;
}

/**
 * fact_type -> polarity・サーバ依存の対応表（design.md §6.4）。
 * DB にマスタ表は作らず、ここをコードの単一定義にする。confirm_fact は polarity をここから自動設定する。
 */
export const FACT_META: Record<FactType, FactMeta> = {
  tainted_source: { polarity: 'expand', serverDependent: true },
  fake_sanitizer: { polarity: 'expand', serverDependent: false },
  reachable: { polarity: 'expand', serverDependent: false },
  weak_origin_check: { polarity: 'expand', serverDependent: false },
  effective_sanitizer: { polarity: 'suppress', serverDependent: false },
  // unreachable の TTL は種別ごとに判断（design.md §6.4）。既定では必須にしない
  unreachable: { polarity: 'suppress', serverDependent: false },
  not_controllable: { polarity: 'suppress', serverDependent: true },
};

export function polarityOf(factType: FactType): Polarity {
  return FACT_META[factType].polarity;
}

// --- 成果物ファイルの種別（artifact_file.kind。design.md §6.1。HAR は保存しない） ---
export const ARTIFACT_KINDS = ['js', 'sourcemap', 'html'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// --- 実行記録の種別（analysis_run.kind。design.md §6.1） ---
export const RUN_KINDS = ['engine', 'llm', 'ingest'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

// --- スキップの理由（analysis_run.skipped_detail のキー。design.md §6.6「ツールが黙って読み飛ばす罠」） ---
export const SKIP_REASONS = [
  'parse_failed', // Babel 等のパース失敗。raw 層だけ残す
  'timeout', // worker / 子プロセスの wall-clock タイムアウト
  'oom', // worker のメモリ上限
  'tool_error', // 外部ツール・worker の異常終了、未分類の失敗
  'extraction_error', // CodeQL の抽出エラーと「投入予定と抽出済みの差分」
  'unresolved_require', // relink で解決できなかった n(<id>)
  'minified_excluded', // ツールが minified と見なして除外したもの
  'path_excluded', // パスの規則で除外したもの（node_modules 既定除外、正規化できない sources 名など）
  'unmapped', // raw へ正確に戻せなかった位置
  'no_module_boundary', // unpack_bundle がモジュール境界を検出できなかったファイル（ファイル全体を 1 つの unpacked にした）
  'no_source_content', // sourcemap の sources に sourcesContent が無く original 層を作れなかったもの
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

// --- 成果物の帰属（artifact_file.ownership。design.md §6.1。推定値で、人間が上書きできる） ---
export const OWNERSHIPS = ['first_party', 'vendored_lib', 'third_party_service', 'unknown'] as const;
export type Ownership = (typeof OWNERSHIPS)[number];

// --- パースの結果（artifact_file.parse_status。design.md §6.1。失敗時は raw 層だけ残す） ---
export const PARSE_STATUSES = ['ok', 'parse_failed', 'timeout'] as const;
export type ParseStatus = (typeof PARSE_STATUSES)[number];

// --- sa-core を呼ぶ入口（権限と公開範囲の判定に使う。docs/architecture.md §3.2） ---
export const CALLER_KINDS = ['cli', 'mcp', 'orchestrator'] as const;
export type CallerKind = (typeof CALLER_KINDS)[number];

// --- E1: エンドポイントの抽出器（endpoint_sighting.extracted_by。design.md §6.2・§7.3） ---
export const ENDPOINT_EXTRACTORS = ['jsluice', 'ast_url', 'graphql_text', 'graphql_ast', 'relay', 'har'] as const;
export type EndpointExtractor = (typeof ENDPOINT_EXTRACTORS)[number];

// --- E1: パラメータの置き場所（endpoint_sighting.params[].in） ---
export const PARAM_LOCATIONS = ['query', 'body', 'path', 'header', 'graphql_var'] as const;
export type ParamLocation = (typeof PARAM_LOCATIONS)[number];

// --- E1: 人間の triage（api_endpoint.triage。CLI/UI だけが書く） ---
export const ENDPOINT_TRIAGES = ['untested', 'tested', 'interesting', 'ignore'] as const;
export type EndpointTriage = (typeof ENDPOINT_TRIAGES)[number];
