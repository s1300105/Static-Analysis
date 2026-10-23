# 静的解析 AI Agent + MCP Server 設計書（Web/JS 特化版）

Bug Bounty 向け。**エージェントはターゲットに一切通信しない**（静的解析に特化）。
対象は **Web / JavaScript・TypeScript のソースおよびバンドル** に一本化（モバイルは対象外）。
動的な確認は人間が行い、その結果を構造化して静的側へ還元し、ループで精度を上げる。

---

## 1. 設計原則

1. **No egress**: 解析エージェントはネットワーク遮断環境で動く。入力は人間が用意したファイルのみ。
2. **証拠の鎖**: 入口→経路→欠けた防御→攻撃者制御値、の4点が静的に揃わない候補は報告しない。
3. **反証の分離**: 発見役と反証役を別コンテキストで動かす。反証できなかったものだけ残す。
4. **二層の事実**: LLM の推測（低信頼）と、人間が動的で確認した事実（確定）を別レイヤーで持つ。矛盾したら確定を信じる。
5. **人間待ちで止めない**: 判定待ちは `needs_human` キューに積み、エージェントは別作業を続ける。
6. **鮮度管理**: コード変更で該当する確定事実は自動失効（再確認待ち）に戻す。古い「安全」を信じない。

---

## 2. スコープ：対象とする脆弱性クラスと段階導入

**Web/JS 静的解析エンジン1本**に集約する。対象は次の **3クラスのみ**（すべてクライアント側 JS で完結し、サーバソース不要）。エンジンの作りで2タイプに分かれる。

### 列挙型（taint 不要）
- **E1. 隠しエンドポイント・パラメータ** — JSから URL/ルート/パラメータを機械抽出。差分で新機能を発見。

### taint 型（source→sink データフロー。確定事実レイヤーが効く）
- **T1. DOM XSS / postMessage origin 未検証**（クライアント側 source）
- **T2. prototype pollution**（クライアント側 source）

この3クラスに絞る理由：いずれも **配信される JS バンドルだけで静的に完結**し、サーバ側ソースが要らない。
ソース非公開の Web ターゲットでも成立するため、Bug Bounty で最も適用範囲が広い。

### 段階導入

| 段 | クラス | 根拠 |
|---|---|---|
| **第1段** | E1 | taint 不要で最速。`diff_versions` の価値を即検証。確定事実レイヤーなしで成立 |
| **第2段** | T1, T2 | source が URL/postMessage 等でクライアント側に静的特定しやすい。ここで taint エンジン＋確定事実レイヤーを組む |

### 静的で扱わず人間に回すもの
レース / サーバ状態依存ロジック / コードに出ない設定ミス / 秘密情報の有効性 / WAF・インフラ挙動。

### 将来拡張（今回のスコープ外）
サーバソースが得られる場合に限り、T3 パストラバーサル / T4 SSRF / T5 デシリアライズ / T6 認可漏れ へ
taint エンジンと確定事実レイヤーをそのまま拡張できる。本書は E1・T1・T2 に集中する。

---

## 3. taint 型クラス（T1・T2）の source / sink 定義

taint エンジンが読む設定。`sink_catalog` に格納し、フレームワーク別に拡張する。
**sanitizer** は「経路上にこれがあれば除外」。ただし人間が `fake_sanitizer` と確定した関数は無効化する。

| クラス | source（攻撃者制御） | sink（危険地点） | sanitizer / 無効化条件 |
|---|---|---|---|
| **T1 DOM XSS** | `location.*`, `document.URL`, `referrer`, `window.name`, フォーム入力 | `innerHTML`, `outerHTML`, `document.write`, `eval`, `insertAdjacentHTML`, jQuery `.html()`, framework の dangerouslySetInnerHTML | DOMPurify, textContent 代入, 既知エスケープ |
| **T1 postMessage** | `message` イベントの `event.data` | 上記 XSS sink / 機密操作 | ハンドラ先頭での `event.origin` 検証の有無（**無ければ候補**） |
| **T2 prototype pollution** | ユーザ入力の key（`JSON.parse`結果, クエリ, body, URLハッシュ） | 再帰マージ/`_.merge`/`Object.assign`連鎖/動的 `obj[k1][k2]=v` | `__proto__`/`constructor`/`prototype` のキー検査 |

補足：T1 postMessage は「sink が危険」ではなく「**origin 検証が無い**」で候補化する点に注意。
ハンドラ内に `event.origin` / `event.source` の検証が存在しない受信口を異常として挙げる。
T2 も同様に、危険キーの検査が経路上に無いものを候補とする。

> E1 は taint 不要の列挙型のため本節の対象外（§7 Analysis の `extract_endpoints` / `diff_versions` が担当）。

---

## 4. 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│  Orchestrator (Agent SDK / LangGraph)                │
│   Recon → Hunter(クラス別) → Triage → Refuter → Reporter │
└───────────────┬─────────────────────────────────────┘
                │ MCP (stdio / streamable-http)
   ┌────────────┼───────────┬───────────┬──────────────┐
   ▼            ▼           ▼           ▼              ▼
┌────────┐ ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────────┐
│Artifact│ │Code     │ │Analysis │ │Knowledge │ │Findings  │
│(JS展開)│ │intel    │ │(enum+   │ │(sink辞書)│ │(状態+事実)│
│        │ │         │ │ taint)  │ │          │ │          │
└────────┘ └─────────┘ └─────────┘ └──────────┘ └────┬─────┘
                                                      │ SQLite
                                              ┌───────▼────────┐
                                              │ 人間レビューUI  │
                                              │ 動的結果の入力  │
                                              └────────────────┘
```

---

## 5. 処理フロー

```
[人間] 対象投入(ソース/JSバンドル) + スコープ定義
   ↓
Artifact  : 展開(webcrack)・sourcemap適用・正規化・バージョンsnapshot
   ↓
[開始時] Findings.get_confirmed_facts(対象バージョンに有効な確定事実を読込)
   ↓
Recon     : エントリポイント・認証境界・攻撃面マップ
   ↓
Hunter    : クラス別サブエージェント(E1 / T1 / T2)が候補生成(証拠の鎖つき)
   ↓
Triage    : 確信度を較正データ+確定事実で補正
   ↓
Refuter   : 別コンテキストで偽陽性の理由を探す。残りを needs_human へ
   ↓
Reporter  : 候補ごとに検証計画(定型フォーム)を出力
   ↓
[人間] 動的テスト → フォームに結果入力(本物/偽/到達可否/実際の値)
   ↓
Findings  : record_dynamic_result / confirm_fact で確定レイヤーに記録
   ↓
promote_to_rule: 本物の経路を Semgrep/CodeQL 化(要レビュー)
   ↓
   └──────→ 次回解析が確定事実+較正済み確信度で走る (ループ)
```

---

## 6. Findings DB スキーマ（システムの土台）

SQLite 想定。

### 6.1 対象・バージョン
```sql
CREATE TABLE target (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT,
  scope JSON, created_at TEXT
);
CREATE TABLE artifact_version (
  id TEXT PRIMARY KEY, target_id TEXT REFERENCES target(id),
  kind TEXT,                 -- source / js_bundle
  label TEXT, content_hash TEXT,
  source_map INTEGER, ingested_at TEXT
);

-- 1つの version は raw(配信そのまま) と normalized(整形後) の2系統を持つ。
-- 解析は normalized で行い、DBに残す location は必ず raw に逆写像してから保存する(§6.6)。
CREATE TABLE artifact_file (
  id TEXT PRIMARY KEY, version_id TEXT REFERENCES artifact_version(id),
  layer TEXT,                -- raw / normalized
  path TEXT,                 -- 展開後の相対パス
  origin_file_id TEXT,       -- normalized の場合、対応する raw ファイル
  position_map TEXT,         -- normalized→raw の sourcemap(位置逆写像用)
  struct_hash TEXT,          -- AST構造ハッシュ(名前に依存しない同一性判定用)
  rename_view INTEGER DEFAULT 0  -- LLMリネーム版か(可読ビュー専用・証拠に使わない)
);
```

### 6.2 コード地図
```sql
CREATE TABLE entrypoint (
  id TEXT PRIMARY KEY, version_id TEXT REFERENCES artifact_version(id),
  kind TEXT,                 -- route / client_handler / postmessage
  signature TEXT,            -- "POST /api/docs/:id/share"
  location TEXT,             -- file:line
  auth_required JSON,        -- {value, source: inferred|confirmed, confidence}
  discovered_by TEXT, created_at TEXT
);
```

### 6.3 候補・証拠の鎖
```sql
CREATE TABLE candidate (
  id TEXT PRIMARY KEY, version_id TEXT REFERENCES artifact_version(id),
  vuln_class TEXT,           -- hidden_endpoint / dom_xss / postmessage / proto_pollution
                             -- (将来拡張: path_traversal / ssrf / insecure_deser / broken_authz)
  entrypoint_id TEXT REFERENCES entrypoint(id),
  title TEXT,
  status TEXT,               -- new / needs_human / confirmed_real / false_positive / wontfix
  severity TEXT, confidence REAL,
  created_by TEXT, created_at TEXT
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, candidate_id TEXT REFERENCES candidate(id),
  role TEXT,                 -- entry / path_step / missing_defense /
                             -- attacker_controlled / refutation
  location TEXT, detail TEXT, order_idx INTEGER
);
```

### 6.4 確定事実レイヤー（人間の動的結果の還元先）★中核
```sql
CREATE TABLE confirmed_fact (
  id TEXT PRIMARY KEY, target_id TEXT REFERENCES target(id),
  fact_type TEXT,            -- tainted_source / fake_sanitizer / auth_boundary /
                             -- server_overwrites / new_entrypoint / reachable / unreachable
  subject TEXT,              -- 関数シグネチャ / パラメータ名 / raw基準の file:line
  value JSON, scope TEXT,    -- version:<id> | project
  fn_identity JSON,          -- 別バージョン引継ぎ用の同一性キー。
                             -- minifyで名前は変わるため struct_hash(AST構造)主体。名前は補助のみ
  confidence REAL, evidence_ref TEXT,
  confirmed_by TEXT, confirmed_at TEXT,
  stale INTEGER DEFAULT 0, superseded_by TEXT
);
CREATE TABLE dynamic_result (
  id TEXT PRIMARY KEY, candidate_id TEXT REFERENCES candidate(id),
  verdict TEXT,              -- real / false / inconclusive
  reached_sink INTEGER, observed TEXT, test_notes TEXT,
  tested_by TEXT, tested_at TEXT
);
```

### 6.5 較正・昇格ルール
```sql
CREATE TABLE calibration (
  id TEXT PRIMARY KEY, target_id TEXT,     -- NULL=グローバル
  vuln_class TEXT, feature_key TEXT,       -- "missing_owner_check+rest_handler"
  n_real INTEGER DEFAULT 0, n_false INTEGER DEFAULT 0,
  updated_at TEXT
);
CREATE TABLE promoted_rule (
  id TEXT PRIMARY KEY, origin_candidate_id TEXT REFERENCES candidate(id),
  engine TEXT, rule_body TEXT, scope TEXT,
  reviewed_by TEXT, active INTEGER DEFAULT 0, created_at TEXT
);
```

### 6.6 位置と整形のルール（整形で座標を壊さないための規約）★

整形は「解析用の正規化」であり、**元位置（raw）を唯一の基準座標とする**。

- **整形の2レベルを区別する**:
  (a) pretty-print = 改行/インデントのみ（変数名は `a,b,c` のまま）、
  (b) unminify = チャンク分割・webpackモジュール境界の復元（webcrack）。
  minify+バンドルが常態なので両方必要。
- **位置は常に raw 基準**: 解析・LLM閲覧は normalized で行うが、
  `evidence.location` / `confirmed_fact.subject` / `entrypoint.location` に保存する値は
  `position_map` で **raw の file:line に逆写像してから**書く。
- **sourcemap があれば最優先**: `apply_sourcemap` が効くなら元ソース＋正確な位置を使う。
  無い場合のみ beautify＋生成mapにフォールバック。
- **LLMリネームは証拠にしない**: humanify等の名前復元は推測。可読ビュー専用（`rename_view=1`）とし、
  同一性判定・confirmed_fact・similar_handlers は **struct_hash（AST構造）と元位置**で行い、名前に依存させない。

---

## 7. MCP Server / Tool 定義

### Artifact（JS取り込み・正規化・差分の基準）
| tool | 役割 |
|---|---|
| `load_artifact` | path, target_id, kind → version_id。raw レイヤーとして保存 |
| `unpack_bundle` | バンドル展開・モジュール境界復元（webcrack）→ normalized 生成 |
| `apply_sourcemap` | sourcemap 復元（あれば最優先）。元ソース＋正確な位置 |
| `beautify` | pretty-print（js-beautify）。**normalized→raw の position_map を必ず出す** ★ |
| `find_missing_chunks` | 取り込んだJSの import/`__webpack_require__`/chunkマップを静的解析し、**参照されているのに未取得のファイル名**を列挙（収集網羅の補助。通信はしない）★ |
| `snapshot_version` | content_hash 記録 |

### Code intel（座標系と関係）
| tool | 役割 |
|---|---|
| `list_entrypoints` | route / client_handler / postMessage を抽出 |
| `get_function` | file:line で関数本体（範囲限定） |
| `find_references` | 参照箇所 |
| `call_path` | source→sink 経路 |
| `similar_handlers` | 同種の postMessage/受信口を並べ、origin検証の有無を比較（将来拡張 T6 でも流用）|

### Analysis（列挙＋taint＋差分）
| tool | 役割 | 対応クラス |
|---|---|---|
| `extract_endpoints` | JSから隠しエンドポイント/パラメータ（jsluice） | E1 |
| `diff_versions` | 新旧差分→新規入口・新機能 ★ | E1 |
| `taint_paths` | source→sink データフロー（確定 source/fake sanitizer を反映）| T1, T2 |
| `check_missing_check` | postMessage の origin検証 / T2 の危険キー検査の欠落を検出 | T1, T2 |
| `semgrep_scan` / `codeql_query` | 既存エンジン・昇格ルール実行 | 全般 |

> 将来拡張（T3-T6）時に `taint_paths` のサーバ側 source 追加、`check_missing_defense`（認可欠落）を足す。

### Knowledge（事前取り込み。外部通信は別プロセス）
| tool | 役割 |
|---|---|
| `sink_catalog` | §3 の source/sink/sanitizer 辞書をクラス別に返す |
| `cwe_lookup` | CWE 参照 |
| `past_verdicts` | 類似候補の過去判定 |

### Findings（状態・事実・還元）★ループの心臓部
| tool | 役割 |
|---|---|
| `add_candidate` / `attach_evidence_chain` | 候補と証拠の鎖 |
| `request_refutation` | 反証役を起動し evidence(role=refutation) に記録 |
| `get_confirmed_facts(version_id)` | 開始時に有効な確定事実を読込（stale=0 かつ scope一致）|
| `record_dynamic_result` | 人間の動的結果を記録 |
| `confirm_fact` | 確定事実をスコープ付きで登録 |
| `promote_to_rule` | 本物経路を Semgrep/CodeQL 化（要レビュー）|
| `expire_facts(version_id)` | 変更に影響する事実を stale=1 |
| `find_chains` | 確定/候補どうしを「出力が次の入力になる」関係で突き合わせ、チェーン候補を挙げる（例: open redirect の sink が別候補の SSRF source）。単体 needs_human でも連結で昇格 ★ |
| `export_test_plan(candidate_id)` | 定型フォーム付き検証計画 |
| `update_calibration` | 判定を較正へ反映 |

---

## 8. 人間を入れる6点

| タイミング | 人間 | 対応 |
|---|---|---|
| 開始前 | スコープ・許可リスト定義 | target.scope |
| Recon後 | 深掘り対象の選択 | UI |
| Triage後 | 本物/偽/要検証の判定 | status, dynamic_result |
| 能動検証 | テストアカウントで再現（手動のみ）| export_test_plan |
| 提出 | レポート清書・自分で送信（自動提出しない）| — |
| ルール採用 | 昇格ルールのレビュー | promoted_rule.reviewed_by |

検証計画は定型フォーム（本物/偽・到達可否・届いた値の選択式）にし、確認のついでに構造化データが貯まるようにする。

---

## 9. 技術スタック

- MCP: Python FastMCP（or TS SDK）
- Orchestrator: Claude Agent SDK / LangGraph（サブエージェント構成）
- パース: tree-sitter（JS/TS）, webcrack（難読化解除）, jsluice（エンドポイント/秘密抽出）
- taint/スキャナ: Semgrep（taint mode）, CodeQL（JS）
- 保存: SQLite
- 人間の承認: MCP elicitation / Agent SDK のツール実行前フック

---

## 10. 評価

- **ゴールデンセット**: DOM XSS / prototype pollution の既知CVE（JS/TSクライアント）の修正前後ペア →「修正前で検出・修正後で非検出」を正解
- 補助: Juice Shop のクライアント側 XSS, 公開 DOM XSS / postMessage / proto-pollution writeup の再現
- 指標: クラス別（E1/T1/T2）の検出率 / 偽陽性率 / 本物1件あたりトークンコスト /
  **ループ回数ごとの偽陽性率推移**（確定事実の還元が効いているかの検証）

---

## 11. 既存実装との関係

- **Anthropic defending-code-reference-harness**（Apache-2.0）: /threat-model /vuln-scan(読取専用) /triage /patch。ベース候補。
- **GitHub Security Lab Taskflow Agent**（MIT／公開taskflow利用にCopilotライセンス）: MCP+SQLite+YAML。思想が近い。

**隙間**: どちらも「ソースがある防御側」寄り。ソース非公開の JS バンドルを静的に読み、
**人間の動的結果で育つ確定事実レイヤー**を持つものは手薄。
→ harness をベースに (1) Artifact(JS取込) (2) 確定事実レイヤー＋較正 (3) レビューキュー を足すのが最短。

---

## 12. 実装順（MVP）

1. **Findings DB スキーマ確定**（§6、位置ルール§6.6 含む）← 土台
2. **前処理**: Artifact の `load_artifact` → `unpack_bundle`/`apply_sourcemap`/`beautify`（position_map付き）
   → 整形で座標を壊さない基盤を先に固める。ここが崩れると以降の記録が全部ズレる
3. **第1段 E1**: `extract_endpoints` + `diff_versions` + `find_missing_chunks`
   → taint も確定事実も不要で最速。収集網羅と `diff_versions` の価値を即検証
4. Code intel（list_entrypoints / get_function / call_path）
5. **第2段 T1,T2**: `taint_paths` + `check_missing_check` + Hunter(dom_xss/postmessage/proto_pollution) → Triage → Refuter
6. export_test_plan + 人間フォーム → record_dynamic_result / confirm_fact
7. `get_confirmed_facts` で2周目 → 偽陽性率の改善を評価（還元の効果測定）
8. `find_chains` でチェーン連結、`promote_to_rule` で variant analysis

※ T3-T6 への拡張は将来スコープ（§2 将来拡張）。本MVPは E1・T1・T2 で完結させる。

---

## 13. 設計上の要注意点（先に決める）

- `confirmed_fact.fn_identity`: 別バージョン引き継ぎの同一性を名前一致にするか構造ハッシュまで見るか
- `calibration.feature_key`: 特徴シグネチャの粒度（細かすぎると貯まらず、粗すぎると効かない）
- `confirmed_fact.stale`: 失効判定の契機（content_hash変化 / 該当 file:line の差分）
- 確定事実の取消・上書き（superseded_by）と監査ログ。人間の判定も誤りうる前提
