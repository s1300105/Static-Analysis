-- 0002_e1: 第1段 E1 の表（design.md §6.2。docs/architecture.md §10 PR-7）
--   api_endpoint / endpoint_sighting / page_context と、派生値の VIEW api_endpoint_summary
--   client_entry（T1/T2 の入口）は taint_paths を入れる M4 で足す。
--
-- 規約は 0001_init.sql と同じ（ULID・UTC の TEXT、JSON 列はオブジェクト/配列だけ、外部キーの子側に索引、列挙値に CHECK を入れない）。

-- JS から見つかったサーバ API。脆弱性候補ではなく「人間が叩く対象」
CREATE TABLE api_endpoint (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES target(id),
  protocol TEXT NOT NULL,           -- rest / graphql / websocket
  origin TEXT NOT NULL DEFAULT '',  -- スキーム＋ホスト(＋既定以外のポート)。不明は ''
  method TEXT NOT NULL DEFAULT '',  -- 不明は ''(NULL だと UNIQUE が効かない)
  path_norm TEXT NOT NULL,          -- 正規化パス。例 "/api/docs/{}/share"
  path_template TEXT,               -- 表示用。例 "/api/docs/:id/share"
  operation TEXT NOT NULL DEFAULT '',  -- GraphQL の operation 名など
  persisted_hash TEXT,              -- persisted query の sha256
  ui_guard TEXT,                    -- 参照元のクライアント側ルートガード(推定。サーバ側の認可ではない)
  triage TEXT DEFAULT 'untested',   -- untested / tested / interesting / ignore (人間が CLI/UI で付ける)
  triaged_params_hash TEXT,         -- triage 時点のパラメータ集合のハッシュ。変われば再浮上
  UNIQUE (target_id, protocol, origin, method, path_norm, operation)
);

-- 版ごとの事実の置き場。first/last_seen・observed_in_har・params の和集合はここから導く
CREATE TABLE endpoint_sighting (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES api_endpoint(id),
  version_id TEXT NOT NULL REFERENCES artifact_version(id),
  location_id TEXT REFERENCES code_location(id),  -- HAR 由来は NULL
  params JSON,                      -- [{name, in: query/body/path/header/graphql_var}]
  extracted_by TEXT NOT NULL,       -- jsluice / ast_url / graphql_text / graphql_ast / relay / har
  run_id TEXT REFERENCES analysis_run(id)
);
CREATE UNIQUE INDEX sighting_uniq
  ON endpoint_sighting(endpoint_id, version_id, IFNULL(location_id, ''), extracted_by);
CREATE INDEX endpoint_sighting_version ON endpoint_sighting(version_id);
CREATE INDEX endpoint_sighting_location ON endpoint_sighting(location_id);
CREATE INDEX endpoint_sighting_run ON endpoint_sighting(run_id);

-- HAR から取り込んだ文書のセキュリティヘッダ(参考情報。抑制には使わない)
CREATE TABLE page_context (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES artifact_version(id),
  document_url TEXT NOT NULL,
  headers JSON,                     -- CSP(Report-Only と区別) / trusted-types / X-Frame-Options / frame-ancestors / COOP / <meta http-equiv=CSP>
  observed_at TEXT                  -- HAR の観測日時。新しい HAR で上書き
);
CREATE INDEX page_context_version ON page_context(version_id);

-- 派生値（design.md §6.2）。読み取りビューア（sqlite3 CLI・Datasette）でも同じ値が見えるよう、独自の SQL 関数は使わない。
--   first_seen / last_seen: その endpoint を見た版の collected_at の最小・最大
--   observed_in_har: HAR で観測したか
--   in_scope: origin のホストが target.scope の allowed_domains に当たり、out_of_scope に当たらないか
--             （"example.com" は完全一致、"*.example.com" はサブドメインだけ）。origin が不明か allowed_domains が空なら NULL
--   sa-core の policy/scope.ts が同じ規則を持つ（テストで一致を確かめる）
CREATE VIEW api_endpoint_summary AS
SELECT
  e.id, e.target_id, e.protocol, e.origin, e.host, e.method, e.path_norm, e.path_template, e.operation,
  e.persisted_hash, e.ui_guard, e.triage, e.triaged_params_hash,
  (SELECT min(v.collected_at) FROM endpoint_sighting s JOIN artifact_version v ON v.id = s.version_id
    WHERE s.endpoint_id = e.id) AS first_seen,
  (SELECT max(v.collected_at) FROM endpoint_sighting s JOIN artifact_version v ON v.id = s.version_id
    WHERE s.endpoint_id = e.id) AS last_seen,
  EXISTS (SELECT 1 FROM endpoint_sighting s WHERE s.endpoint_id = e.id AND s.extracted_by = 'har') AS observed_in_har,
  (SELECT count(*) FROM endpoint_sighting s WHERE s.endpoint_id = e.id) AS sightings,
  CASE
    WHEN e.host = '' OR coalesce(json_array_length(t.scope, '$.allowed_domains'), 0) = 0 THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM json_each(t.scope, '$.out_of_scope') d
      WHERE e.host = lower(d.value)
         OR (substr(d.value, 1, 2) = '*.' AND length(e.host) > length(d.value) - 1
             AND substr(e.host, -(length(d.value) - 1)) = lower(substr(d.value, 2)))
    ) THEN 0
    WHEN EXISTS (
      SELECT 1 FROM json_each(t.scope, '$.allowed_domains') d
      WHERE e.host = lower(d.value)
         OR (substr(d.value, 1, 2) = '*.' AND length(e.host) > length(d.value) - 1
             AND substr(e.host, -(length(d.value) - 1)) = lower(substr(d.value, 2)))
    ) THEN 1
    ELSE 0
  END AS in_scope
FROM (
  -- origin（scheme://host[:port]）からホストを取り出す
  SELECT x.*, lower(CASE WHEN instr(x.hostport, ':') > 0 THEN substr(x.hostport, 1, instr(x.hostport, ':') - 1)
                          ELSE x.hostport END) AS host
  FROM (
    SELECT a.*, CASE WHEN instr(a.origin, '://') > 0 THEN substr(a.origin, instr(a.origin, '://') + 3)
                     ELSE ltrim(a.origin, '/') END AS hostport
    FROM api_endpoint a
  ) x
) e
JOIN target t ON t.id = e.target_id;
