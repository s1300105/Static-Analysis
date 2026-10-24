-- 0001_init: 骨格（design.md §6.1 のうち M1 で使う表。docs/architecture.md §10 PR-2）
--   target / artifact_version / artifact_file / code_location / analysis_run / expected_chunk
--
-- 後続の移行で足すもの（スキーマ確定の段階は plan.md に合わせる）:
--   function_identity / function_lineage（M3）。そのとき code_location に
--     ALTER TABLE code_location ADD COLUMN fn_id TEXT REFERENCES function_identity(id);
--   を足す。foreign_keys=ON では、まだ無い表を REFERENCES すると NULL でも INSERT が失敗するので、ここでは列ごと持たない。
--   detected_library（M4 detect_stack）。
--
-- 規約:
--   - ID は ULID、時刻は ISO 8601 UTC の TEXT。
--   - JSON 列（宣言型 JSON = NUMERIC 親和性）には、リポジトリ関数が JSON.stringify したオブジェクト/配列だけを入れる。
--   - 外部キーの子側の列には索引を張る。UNIQUE / PRIMARY KEY の自動索引の先頭列と重なるものは張らない。
--   - 列挙値への CHECK はスキーマが固まるまで入れない（design.md §6）。
--   - BEGIN / COMMIT は書かない（migrate() が全移行を 1 トランザクションで適用する）。

CREATE TABLE target (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scope JSON,                    -- 許可ドメイン・対象外・プログラム規約メモ・llm_code_policy・third_party_code（@sa/types TargetScopeSchema）
  created_at TEXT
);

CREATE TABLE artifact_version (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES target(id),
  label TEXT,
  base_version_id TEXT REFERENCES artifact_version(id),  -- 比較の基準。初版だけ NULL
  collected_at TEXT NOT NULL,    -- 人間が取得した日時
  collection_notes JSON,         -- ログイン有無・ロール・言語・機能フラグ
  ingested_at TEXT
);
CREATE INDEX artifact_version_target ON artifact_version(target_id);
CREATE INDEX artifact_version_base ON artifact_version(base_version_id);

CREATE TABLE artifact_file (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES artifact_version(id),
  layer TEXT NOT NULL,           -- raw / unpacked / relinked / pretty / original / renamed (§6.6)
  kind TEXT,                     -- js / sourcemap / html  (HAR は保存しない)
  path TEXT NOT NULL,            -- ツールが生成する作業パス <version_id>/<layer>/<file_id>.js (原則8)
  orig_name TEXT,                -- sources 名・モジュール名・配信ファイル名(表示専用。パスに使わない)
  content_hash TEXT NOT NULL,    -- sha256。実体は blobs/<hash[0:2]>/<hash>
  parent_file_id TEXT REFERENCES artifact_file(id),  -- 1つ下の層。辿ると raw に着く
  raw_offset INTEGER,            -- unpacked: raw 内の開始バイト
  position_map_hash TEXT,        -- relinked / pretty / original / renamed: 親層への sourcemap(blob)
  -- raw 層のみ
  source_urls JSON,              -- 配信 URL(HAR または人間の入力)
  loaded_by_origins JSON,        -- その script を読み込んだ文書のオリジン。不明なら空
  ownership TEXT,                -- first_party / vendored_lib / third_party_service / unknown。unpacked にも付ける
  chunk_key TEXT,                -- ランタイムのチャンクマップ上の ID/名前
  bundler TEXT,                  -- webpack / browserify / turbopack / esm / unknown
  parse_status TEXT DEFAULT 'ok',-- ok / parse_failed / timeout (失敗時は raw 層だけ残す)
  map_check JSON                 -- sourcemap: 簡易検証の一致率(§6.6)
);
CREATE INDEX artifact_file_version ON artifact_file(version_id);
CREATE INDEX artifact_file_parent ON artifact_file(parent_file_id);

-- 位置は必ず raw 基準のバイト範囲で持つ(§6.6)。作るのは resolve_location とエンジン出力の取り込みだけ
CREATE TABLE code_location (
  id TEXT PRIMARY KEY,
  raw_file_id TEXT NOT NULL REFERENCES artifact_file(id),
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  line INTEGER,                  -- 表示用の派生値
  col INTEGER,
  orig_ref TEXT,                 -- sourcemap があれば 元ファイル:行:列(表示用)
  UNIQUE (raw_file_id, start_byte, end_byte)
);

-- 実行記録。スキップ数・ツール版・LLM のモデルの置き場所
CREATE TABLE analysis_run (
  id TEXT PRIMARY KEY,
  version_id TEXT REFERENCES artifact_version(id),
  kind TEXT NOT NULL,            -- engine / llm / ingest
  tool TEXT NOT NULL,            -- codeql / semgrep / jsluice / babel / extract_endpoints / hunter / refuter ...
  tool_version TEXT,             -- エンジンとクエリパックの版
  config_hash TEXT,              -- sink_catalog・known_gadgets・vulnerable_libs・有効な promoted_rule・クエリパックの版
  input_layer TEXT,
  model_id TEXT,                 -- LLM: 実際に応答したモデル ID(fallback 後の値。実行時に記録する)
  prompt_version TEXT,           -- LLM: サブエージェント定義の版またはハッシュ、effort
  files_total INTEGER,
  files_analyzed INTEGER,
  files_skipped INTEGER,
  skipped_detail JSON,           -- 理由別: minified 除外 / パス除外 / parse error / timeout / 抽出エラー / 未解決 / unmapped
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX analysis_run_version ON analysis_run(version_id);

-- 参照されているのに未取得のチャンク・sourcemap(収集網羅)
CREATE TABLE expected_chunk (
  version_id TEXT NOT NULL REFERENCES artifact_version(id),
  chunk_key TEXT NOT NULL,       -- チャンクマップの ID/名前。取れなければ URL
  url TEXT,
  referenced_from_location_id TEXT REFERENCES code_location(id),
  host_in_scope INTEGER,         -- target.scope の許可ドメインか
  status TEXT NOT NULL,          -- missing / fetched / unavailable
  PRIMARY KEY (version_id, chunk_key)
);
CREATE INDEX expected_chunk_location ON expected_chunk(referenced_from_location_id);
