# 静的解析 AI Agent + MCP Server 設計書（Web/JS 特化版）rev.2

Bug Bounty 向け。**エージェントはターゲットに一切通信しない**（静的解析に特化）。
対象は **Web / JavaScript・TypeScript のソースおよびバンドル** に一本化（モバイルは対象外）。
動的な確認は人間が行い、その結果を構造化して静的側へ還元し、ループで精度を上げる。

> **rev.2 の主な変更**
> - E1 を脆弱性候補から外し、攻撃面インベントリ（`api_endpoint`）として別系統にした
> - 座標を「raw ファイル＋バイト範囲」に統一（minify 済みバンドルは1行なので file:line では位置を特定できない）
> - taint は自前実装ではなく CodeQL 標準クエリ＋モデル拡張を土台にした（ライセンス確認つき）
> - T1 postMessage は「origin 検証の欠如」単独ではなく「欠如/不完全」かつ「sink への到達」で候補化。送信側も追加
> - T2 は gadget との連結（T2→T1）までを目標にした。`Object.assign` を sink から除外
> - サーバ側スコープの残骸（認証境界・`auth_required`・T6 の例など）を除去
> - 確定事実に極性（拡張/抑制）・観測条件・TTL・監査ログを追加し、失効を関数単位にした
> - 評価を「最小化済み・sourcemap 無し」の入力前提にし、再現率と見逃しも測るようにした

---

## 1. 設計原則

1. **ターゲットへの通信ゼロ**: 入力は人間が用意したファイル（JS / sourcemap / HAR）だけ。
   許可する外向き通信は LLM API の宛先のみ（allowlist）。解析ツールもオフライン設定で動かす
   （Semgrep はローカルルール＋`--metrics=off`、CodeQL パックは事前取得）。
   LLM に送るコード（特に sourcemap から復元したソース）がプログラム規約上問題ないかは、対象ごとに確認する。
2. **証拠の鎖（taint 型のみ）**: source（攻撃者制御値）→ 経路 → sink の各点と、経路上の防御が「無い / 不完全」であることが
   静的に揃ったものだけを候補にする。欠けている環が人間の動的確認で埋まる種類（例: API レスポンスの値が攻撃者制御か）なら、
   捨てずに「欠けた環」を明示して `needs_human` に積む。列挙型（E1）はこの原則の対象外（§2）。
3. **座標はツールが書く**: evidence の位置は必ずツール出力（AST ノード）由来とし、LLM は位置を生成しない。
   LLM が指した箇所は `resolve_location` で実在と種別を検証してから保存する。
4. **反証の分離**: 発見役と反証役を別コンテキストで動かす。反証された候補も消さず `refuted`＋理由で残し、
   一部を人間が抜き取り監査する（反証役の誤反証＝見逃しを測るため）。
5. **二層の事実**: エンジン/LLM の推論（低信頼）と、人間が動的に観測した事実（確定事実）を別レイヤーで持つ。
   確定事実は「その条件（アカウント権限・機能フラグ・ブラウザ・日時）で観測された」もの。矛盾時は確定事実を優先する。
   ただし**抑制方向の事実**（到達不能・サニタイザ有効など、候補を消す側）は誤ると見逃しを静かに生むので、
   拡張方向の事実（攻撃者制御・偽サニタイザなど）より厳しく扱う（§6.4）。
6. **人間待ちで止めない**: 判定待ちは `needs_human` キューに積み、エージェントは別作業を続ける。
7. **鮮度管理**: コード変更で影響を受ける事実は自動失効（再確認待ち）に戻す。影響判定は**関数単位の同一性**で行う
   （バンドル全体の content_hash はデプロイ毎に変わるので、それを契機にすると毎回全失効する）。
   サーバ挙動に依存する事実はコード差分では検知できないため TTL でも失効させる。

---

## 2. スコープ

対象はクライアント側 JS だけで静的に完結するもの。系統は2つ。

### 列挙型: 攻撃面インベントリ（脆弱性候補ではない）
- **E1. 隠しエンドポイント・パラメータ** — JS から REST のパス/メソッド/パラメータ、GraphQL の operation、
  WebSocket 等の URL を機械抽出し、バージョン差分で新機能を見つける。
  出力は「人間が動的に叩く対象の一覧」で、それ自体は脆弱性ではない。
  したがって candidate / 反証 / 較正のパイプラインには流さず、`api_endpoint` インベントリとして別管理する（§6.2）。

### taint 型: 脆弱性候補（確定事実レイヤーが効く）
- **T1a. DOM XSS** — URL 等のクライアント側 source → DOM 挿入 / JS 実行 / `javascript:` URL の sink
- **T1b. postMessage**
  - 受信: origin 検証が**無い or 不完全** かつ `event.data` が sink / 機密操作に届く
  - 送信: 機密データを `targetOrigin='*'` で送っている
- **T2. prototype pollution** — 危険キー未検査の再帰マージ / パス代入（汚染プリミティブ）。
  単体では影響を示しにくく報奨対象になりにくいので、**gadget（汚染されたプロパティを読んで sink に流す箇所）との連結**
  （T2→T1a）までを目標とする。gadget が見つからないものは低優先で `needs_human`。

### 段階導入

| 段 | 対象 | 根拠 |
|---|---|---|
| **第1段** | E1 | taint 不要で最速。`diff_versions` と収集網羅の価値を即検証。人間の HAR で再現率を測れる |
| **第2段** | T1a, T1b, T2 | CodeQL 標準クエリが土台にあり、source をクライアント側で静的に特定しやすい。ここで確定事実レイヤーを組む |
| **第3段** | T2→T1a 連結 | gadget 検出と `find_chains` |

### 静的で扱わず人間に回すもの
- レース / サーバ状態依存ロジック / コードに出ない設定ミス / 秘密情報の有効性 / WAF・インフラ挙動
- **CSP・Trusted Types・Cookie 属性**（レスポンスヘッダ依存。XSS の実害評価に必要）
- **API レスポンスのどのフィールドが攻撃者制御か**（人間が確認して `tainted_source` として還元する。確定事実レイヤーの主な用途）

### 対象外
- self-XSS（被害者自身のフォーム入力だけを source とするもの）
- サーバ側の脆弱性。サーバソースが得られる場合に限り、将来 T3 パストラバーサル / T4 SSRF / T5 デシリアライズ / T6 認可漏れ へ拡張する。

---

## 3. taint 型（T1・T2）の source / sink / 防御定義

`sink_catalog`（MCP resource）に格納し、フレームワーク別に拡張する。CodeQL を使う場合は同じ定義をモデル拡張として流し込む。
防御の有効性は **sink の文脈ごと** に判定する（HTML 本文で有効なエスケープが URL 文脈では無効、など）。
人間が `fake_sanitizer` と確定した関数は無効化する。

| クラス | source（攻撃者制御） | sink（危険地点） | 防御（有効条件つき） |
|---|---|---|---|
| **T1a DOM XSS** | `location.{hash,search,href}`, `document.{URL,documentURI,baseURI}`, `URLSearchParams`, `window.name`, `document.referrer`<br>二次 source: `localStorage` / `sessionStorage` / `document.cookie`（書き込み経路が別候補で立つ場合）、API レスポンス（`tainted_source` 事実がある場合） | HTML: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write(ln)`, `Range.createContextualFragment`, `iframe.srcdoc`, jQuery `.html()`/`.append()` 系と `$(html)`, `dangerouslySetInnerHTML`, `v-html`, Angular `bypassSecurityTrust*`<br>JS: `eval`, `Function`, 文字列引数の `setTimeout`/`setInterval`, `script.src`/`script.text`<br>URL: `location` 代入・`assign`・`replace`, `window.open`, `a.href`, `iframe.src`（`javascript:`） | DOMPurify（版と設定を確認。`ADD_TAGS` 等の緩和や sanitize 後の文字列加工があれば無効扱い）/ 安全な sink への置換（`textContent`, `createTextNode`）/ URL はスキーム許可リスト（`http:`/`https:`）/ HTML エスケープは HTML 本文文脈でのみ有効 |
| **T1b 受信** | `message` イベントの `event.data` | T1a の sink、ナビゲーション、storage 書き込み（二次 source 化）、資格情報付きリクエスト等の機密操作 | `event.origin` の**完全一致**比較（許可リスト）。`indexOf` / `includes` / `startsWith` / `endsWith`、未アンカーや `.` 未エスケープの正規表現、`'null'` の許容は**不完全**として候補化 |
| **T1b 送信** | トークン・PII 等の機密値 | `postMessage(x, '*')` | 具体的な `targetOrigin` の指定 |
| **T2 汚染** | 攻撃者制御のキー: クエリ/ハッシュのパース結果（`a[__proto__][x]=` 形式を解釈するパーサ）、URL/postMessage/storage 由来の `JSON.parse` 結果、postMessage のオブジェクト | 再帰マージ/extend（`$.extend(true, …)`, 旧版 `_.merge` / `_.defaultsDeep`）、パス指定代入（`_.set`, 自前の `obj[k1][k2]=v`） | `__proto__` / `constructor` / `prototype` キーの拒否（`constructor.prototype` 経路も）、`Object.create(null)` / `Map`、`Object.freeze(Object.prototype)` |
| **T2 gadget** | 汚染されうるプロパティ読み（自前プロパティを持たないオブジェクトの `opts.x` 等） | T1a の sink | `hasOwnProperty` 検査、プロトタイプなしオブジェクト |

補足:
- T1b 受信は「origin 検証が無い」だけでは候補にしない。解析用・iframe サイズ調整など無害なハンドラが大量にあり、
  原則2（証拠の鎖）とも矛盾するため。逆に「検証はあるが不完全」は見逃さず候補にする。
- `Object.assign` やスプレッド構文は浅いコピーで `Object.prototype` を汚染しないので T2 の sink から除く
  （`__proto__` キーで変わるのはコピー先オブジェクト自身のプロトタイプだけ）。
- ライブラリの既知脆弱版（例: jQuery < 3.4.0 の `$.extend(true, …)`）と既知 gadget は、
  バンドル内のライブラリ版数検出（`detect_stack`）と知識ベース（`known_gadgets` / `vulnerable_libs`）で当てる。

> E1 は列挙型のため本節の対象外（§7 の `extract_endpoints` / `diff_versions` が担当）。

---

## 4. 全体アーキテクチャ

```
┌────────────────────────────────────────────────────────┐
│ Orchestrator (Claude Agent SDK, サブエージェント構成)      │
│  Recon → Hunter(クラス別) → Refuter → Triage → Reporter   │
└───────────────┬────────────────────────────────────────┘
                │ MCP (stdio)
        ┌───────┴──────────────┐
        ▼                      ▼
┌───────────────────┐   ┌───────────────────┐
│ sa-analysis        │   │ sa-findings        │
│  Artifact          │   │  候補・証拠・事実   │
│  Code intel        │   │  較正・ルール・監査 │
│  Analysis          │   └─────────┬─────────┘
│  catalog(resource) │             │ SQLite (WAL)
│  AST / CodeQL DB   │     ┌───────▼─────────┐
│  キャッシュ共有      │     │ 人間レビューUI    │
└───────────────────┘     │ 動的結果・HAR 入力 │
                          └─────────────────┘
```

- **MCP サーバは2つに集約する**。解析系（Artifact / Code intel / Analysis）は同じバンドルの AST・CodeQL DB を共有するので、
  プロセスを分けると同じ解析を何度も行うことになる。すべてオフラインで動くので、分けても隔離上の利点が無い。
- Knowledge（sink_catalog・既知 gadget・ライブラリ脆弱版）は静的データなので tool ではなく **MCP resource** にする。
  `past_verdicts` は Findings 側の tool に統合する。
- **MCP サーバは決定的なデータ処理・解析だけを持つ**。反証役などのエージェント起動は Orchestrator の責務
  （MCP tool からエージェントを起動しない）。
- **候補の生成はエンジン**（CodeQL / jsluice / 自前クエリ）が行い、LLM は Recon の優先順位付け、経路の読解、反証、
  gadget の推論、検証計画の作成を担う（原則3）。
- Orchestrator は Claude Agent SDK に一本化する（LangGraph との併記はやめる）。

---

## 5. 処理フロー

```
[人間] 対象投入(JSバンドル / sourcemap / 任意で HAR) + スコープ定義
   ↓
Artifact : raw 保存 → unpack(モジュールを raw の部分範囲として切り出し)
           → pretty(位置マップ付き) → 関数同一性の計算と前バージョンとの対応付け
   ↓
[開始時] get_confirmed_facts(version) : 関数同一性で引き継げる有効な事実だけ読込
   ↓
Recon    : フレームワーク/ライブラリ版数の検出、クライアント側ルートガード(UI 上の権限境界。サーバ認可ではない)の推定、
           E1 インベントリ生成と差分、未取得チャンク・sourcemap の列挙
   ↓
Hunter   : クラス別(T1a / T1b / T2)。エンジン実行 → LLM が経路を読み証拠の鎖を整える
   ↓
Refuter  : 別コンテキスト・同じツールで反証を試みる。反証できたものは refuted(理由付き)
   ↓
Triage   : 較正データ＋確定事実で確信度を補正し needs_human へ
   ↓
Reporter : 候補ごとに検証計画(定型フォーム・PoC 入力値の案)
   ↓
[人間] 動的テスト → フォーム入力(本物/偽/到達可否/観測値/観測条件)、HAR 取り込み
   ↓
Findings : record_dynamic_result / confirm_fact / update_calibration
   ↓
promote_to_rule : 本物の経路を CodeQL/Semgrep ルール化(陽性・陰性テスト付き、要レビュー)
   ↓
   └──→ 次バージョンの解析へ(ループ)
```

Refuter を Triage の前に置くのは、較正データ（人間の判定）が「反証を通過した候補」に対して貯まるため。
較正済み確信度は同じ段階（反証通過後）の候補に掛けるのが整合する。

---

## 6. DB スキーマ（システムの土台）

SQLite。ID は ULID、時刻は ISO 8601 (UTC)。

```sql
PRAGMA foreign_keys = ON;   -- SQLite は既定で外部キー制約が無効
PRAGMA journal_mode = WAL;  -- レビューUIとエージェントの同時書き込み
```

### 6.1 対象・成果物・座標
```sql
CREATE TABLE target (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  scope JSON,                    -- 許可ドメイン・対象外・プログラム規約メモ(LLM送信可否を含む)
  created_at TEXT
);
CREATE TABLE artifact_version (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES target(id),
  label TEXT,
  collected_at TEXT,             -- 人間が取得した日時
  ingested_at TEXT
);
CREATE TABLE artifact_file (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES artifact_version(id),
  layer TEXT NOT NULL,           -- raw / unpacked / pretty / renamed / original (§6.6)
  kind TEXT,                     -- js / sourcemap / html / har
  path TEXT NOT NULL,
  content_hash TEXT,
  parent_file_id TEXT REFERENCES artifact_file(id),  -- 1つ下の層。辿ると raw に着く
  raw_offset INTEGER,            -- unpacked: raw 内の開始バイト(切り出しなので加算だけで逆写像)
  position_map TEXT              -- pretty / renamed / original: 親層への sourcemap
);

-- 関数単位の同一性。バージョン間の事実引き継ぎと失効判定の基準
CREATE TABLE function_identity (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES artifact_version(id),
  raw_file_id TEXT NOT NULL REFERENCES artifact_file(id),
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
  norm_hash TEXT,                -- 識別子を正規化した AST ハッシュ(完全一致用)
  anchors JSON,                  -- 文字列リテラル・プロパティ名・呼び出す API 名(minify で変わらない手掛かり)
  size INTEGER                   -- AST ノード数。小さすぎる関数は引き継ぎ対象外
);
CREATE TABLE function_lineage (  -- 前バージョンの関数との対応
  prev_fn_id TEXT NOT NULL REFERENCES function_identity(id),
  next_fn_id TEXT NOT NULL REFERENCES function_identity(id),
  match_kind TEXT,               -- exact / fuzzy
  similarity REAL,
  PRIMARY KEY (prev_fn_id, next_fn_id)
);

-- 位置は必ず raw 基準のバイト範囲で持つ(§6.6)
CREATE TABLE code_location (
  id TEXT PRIMARY KEY,
  raw_file_id TEXT NOT NULL REFERENCES artifact_file(id),
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
  line INTEGER, col INTEGER,     -- 表示用の派生値
  orig_ref TEXT,                 -- sourcemap があれば 元ファイル:行:列(表示用)
  fn_id TEXT REFERENCES function_identity(id)
);
```

### 6.2 攻撃面（E1 インベントリと T1/T2 の入口）
```sql
-- E1: JS から見つかったサーバ API。脆弱性候補ではなく「人間が叩く対象」
CREATE TABLE api_endpoint (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES target(id),
  protocol TEXT,                 -- rest / graphql / websocket
  method TEXT, path_template TEXT,   -- "POST /api/docs/:id/share"
  operation TEXT,                -- GraphQL の operation 名など
  params JSON,
  first_seen_version TEXT REFERENCES artifact_version(id),
  last_seen_version  TEXT REFERENCES artifact_version(id),
  observed_in_har INTEGER DEFAULT 0, -- 人間の通信記録で観測済みか
  ui_guard TEXT,                 -- 参照元のクライアント側ルートガード(推定。サーバ側の認可ではない)
  triage TEXT                    -- untested / tested / interesting / ignore (人間が付ける)
);
CREATE TABLE endpoint_sighting (
  endpoint_id TEXT NOT NULL REFERENCES api_endpoint(id),
  version_id TEXT NOT NULL REFERENCES artifact_version(id),
  location_id TEXT REFERENCES code_location(id),
  extracted_by TEXT              -- jsluice / graphql / custom
);

-- T1/T2: クライアント側で攻撃者の入力を受ける口
CREATE TABLE client_entry (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES artifact_version(id),
  kind TEXT,                     -- url_param / hash / window_name / postmessage_handler /
                                 -- storage_read / api_response
  location_id TEXT REFERENCES code_location(id),
  detail JSON, discovered_by TEXT
);
```

### 6.3 候補・証拠の鎖
```sql
CREATE TABLE candidate (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES artifact_version(id),
  vuln_class TEXT,               -- dom_xss / postmessage_recv / postmessage_send /
                                 -- proto_pollution / pp_gadget
  entry_id TEXT REFERENCES client_entry(id),
  fingerprint TEXT,              -- class + source種別 + sink の関数同一性 + sink種別。バージョン跨ぎの重複排除用
  prev_candidate_id TEXT REFERENCES candidate(id),  -- 前バージョンの同一候補
  title TEXT,
  status TEXT,                   -- new / refuted / needs_human / confirmed_real / false_positive /
                                 -- duplicate / stale / reported / wontfix
  missing_link TEXT,             -- 人間確認待ちの欠けた環(例: "api_response.bio が攻撃者制御か")
  impact_hypothesis TEXT,        -- 想定される影響(エージェントの仮説)
  severity TEXT,                 -- 人間が提出時に決める
  confidence REAL,
  created_by TEXT, created_at TEXT
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidate(id),
  role TEXT,                     -- source / path_step / sink / defense_missing / defense_weak /
                                 -- gadget / refutation
  location_id TEXT REFERENCES code_location(id),
  detail TEXT, order_idx INTEGER,
  produced_by TEXT               -- 生成したツール＋実行ID(LLM 単独の座標は受け付けない)
);
CREATE TABLE candidate_link (    -- find_chains の結果(例: T2 汚染 → T2 gadget → T1a sink)
  from_candidate_id TEXT NOT NULL REFERENCES candidate(id),
  to_candidate_id TEXT NOT NULL REFERENCES candidate(id),
  relation TEXT,                 -- pollutes_gadget / writes_storage_read_by / ...
  PRIMARY KEY (from_candidate_id, to_candidate_id)
);
```

### 6.4 確定事実レイヤー（人間の動的結果の還元先）★中核
```sql
CREATE TABLE dynamic_result (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES candidate(id),
  endpoint_id TEXT REFERENCES api_endpoint(id),   -- E1 を叩いた結果もここへ
  version_id TEXT REFERENCES artifact_version(id),
  verdict TEXT,                  -- real / false / inconclusive
  reached_sink INTEGER, observed TEXT,
  conditions JSON,               -- アカウント権限・機能フラグ・ブラウザ
  test_notes TEXT, tested_by TEXT, tested_at TEXT
);
CREATE TABLE confirmed_fact (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES target(id),
  fact_type TEXT,                -- 拡張: tainted_source / fake_sanitizer / reachable / weak_origin_check
                                 -- 抑制: effective_sanitizer / unreachable / not_controllable
  polarity TEXT NOT NULL,        -- expand / suppress (原則5)
  anchor_fn_id TEXT REFERENCES function_identity(id),   -- 関数に結びつく事実
  anchor_endpoint_id TEXT REFERENCES api_endpoint(id),  -- API レスポンスのフィールドに結びつく事実
  subject JSON,                  -- {"field":"bio"} / {"sanitizer_fn": "..."} のように型付きで
  depends_on JSON,               -- 経路系の事実: 経路上の fn_id 群(どれかが変われば失効)
  value JSON,
  scope TEXT NOT NULL,           -- version / target (抑制方向は既定 version)
  conditions JSON,               -- 観測条件(dynamic_result から引き継ぐ)
  valid_until TEXT,              -- サーバ挙動に依存する事実は TTL を必須にする
  dynamic_result_id TEXT REFERENCES dynamic_result(id),
  confirmed_by TEXT, confirmed_at TEXT,
  state TEXT DEFAULT 'active'    -- active / stale / revoked / superseded
);
CREATE TABLE fact_event (        -- 監査ログ(追記のみ。人間の判定も誤りうる前提)
  id TEXT PRIMARY KEY, fact_id TEXT NOT NULL REFERENCES confirmed_fact(id),
  event TEXT,                    -- created / carried_over / expired / revoked / superseded
  reason TEXT, actor TEXT, at TEXT,
  superseded_by TEXT REFERENCES confirmed_fact(id)
);
```

運用ルール:
- `inconclusive` の結果からは抑制方向の事実を作らない（再現できなかった ≠ 到達不能）。
- 抑制方向の事実は既定で `scope=version`。`target` に広げるのは理由付きで人間が明示したときだけ。
- `tainted_source`（API レスポンスのフィールド）や `not_controllable` のようにサーバ挙動に依存する事実は `valid_until` 必須。

### 6.5 較正・昇格ルール
```sql
CREATE TABLE calibration (
  target_key TEXT NOT NULL,      -- target.id または '*'(グローバル)。NULL だと UNIQUE が効かないので使わない
  vuln_class TEXT NOT NULL,
  feature_key TEXT NOT NULL,     -- "{source種別}:{sink種別}:{防御状態}:{framework}"
                                 -- 例 "url_hash:innerHTML:none:react"
  n_real INTEGER DEFAULT 0, n_false INTEGER DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (target_key, vuln_class, feature_key)
);
CREATE TABLE promoted_rule (
  id TEXT PRIMARY KEY, origin_candidate_id TEXT REFERENCES candidate(id),
  engine TEXT, rule_body TEXT, scope TEXT,
  positive_test TEXT,            -- 元候補のコード(検出されるべき)
  negative_test TEXT,            -- 修正版や類似の安全なコード(検出されてはいけない)
  reviewed_by TEXT, active INTEGER DEFAULT 0, created_at TEXT
);
```

確信度は Beta 事前分布で計算し、件数が少ないうちは「対象別 → グローバル(`*`) → クラス既定値」の順に後退する。
表示には確信度と一緒に根拠件数 n を出す。
なお、ラベルが付くのは反証を通過して人間が試した候補だけなので、較正値はその母集団でしか意味を持たない。

### 6.6 座標と整形のルール ★

**唯一の基準座標は「raw ファイル＋バイト範囲」**。line:col は表示用の派生値。
（minify 済みバンドルは全体が1行のことが多く、file:line では位置を特定できない）

層の定義と raw への戻し方:

| 層 | 作り方 | raw への逆写像 | 証拠に使えるか |
|---|---|---|---|
| raw | 配信されたまま | — | ○ |
| unpacked | webpack/browserify のモジュールを **raw の部分文字列として切り出す**（コードは書き換えない） | `raw_offset` の加算だけ | ○ |
| pretty | Babel で parse → generate（`sourceMaps: true`）。識別子は変えない | 生成した sourcemap | ○ |
| original | sourcemap の `sourcesContent` から復元 | sourcemap の逆引き | ○（あれば最優先で読む） |
| renamed | webcrack の難読化解除、LLM による名前復元など、コードを書き換えるもの | AST ノードの元位置が残る場合のみ | ×（可読ビュー専用） |

- js-beautify は位置マップを出力できないので pretty 層には使わない。
- renamed 層で見つけた箇所は、元位置で raw に戻せた場合だけ証拠にする。戻せなければ `unmapped` として人間確認に回す。
- 機械解析（CodeQL / Semgrep）は unpacked か original に掛ける。LLM には pretty / renamed / original から
  `get_function` で**関数単位に切り出して**見せ、ファイル丸ごとは渡さない（バンドルは数 MB になる）。
- **往復テスト**: pretty 層の全トークンについて「raw に戻した範囲の文字列が同じトークンになる」ことを CI で検証する。
- **ツールが黙って読み飛ばす罠**:
  - CodeQL CLI 2.24.0 以降、JS エクストラクタは平均行長 200 超のファイルを minified とみなして解析しない。
    unpacked に掛けるなら `CODEQL_EXTRACTOR_JAVASCRIPT_ALLOW_MINIFIED_FILES=true` を設定するか、pretty に掛けて map で戻す。
  - Semgrep は既定で 1MB を超えるファイルを読み飛ばす（`--max-target-bytes`）。モジュール単位に切るか上限を上げる。
  - どちらも警告なしで飛ばすので、実行ごとに解析対象ファイル数とスキップ数を記録する。

**関数同一性（バージョン間の引き継ぎ）**:
- まず `norm_hash`（識別子を正規化した AST ハッシュ）の完全一致で対応付ける。
- 外れたら `anchors`（文字列リテラル・プロパティ名・呼び出す API 名。minify で変わらない）と AST の類似度でファジー一致させる。
- `size` が小さい関数や、候補が複数に割れる曖昧な一致は引き継がない（構造が同じ小関数は大量にあり衝突する）。
- 一致しなかった関数に結びつく事実は stale にする。

---

## 7. MCP Server / Tool 定義

### sa-analysis

**Artifact（取り込み・層の生成）**
| tool | 役割 |
|---|---|
| `load_artifact(path, target_id)` | raw 層として保存し version_id を発行 |
| `import_sourcemap` | sourcemap を適用して original 層を生成 |
| `unpack_bundle` | モジュール境界を検出し、raw の部分範囲として unpacked 層を生成 |
| `pretty` | Babel で pretty 層と position_map を生成 |
| `index_functions` | function_identity を計算し、前バージョンとの function_lineage を作る |
| `find_missing_chunks` | chunk マップ・動的 import・`sourceMappingURL` から、参照されているのに未取得のチャンクと sourcemap を列挙（通信しない）★ |
| `import_har` | 人間が取得した HAR を取り込み、観測済みエンドポイントと未取得 JS を照合 |

**Code intel（座標系と関係）**
| tool | 役割 |
|---|---|
| `resolve_location` | 任意の層の位置 → raw のバイト範囲と AST ノード種別。LLM が指した箇所の検証にも使う |
| `get_function` | 関数本体（層を指定、既定 pretty）と raw 位置 |
| `find_references` | 参照箇所 |
| `call_path` | source→sink の経路（CodeQL の path 結果を整形） |
| `similar_handlers` | 同種の message ハンドラを並べ、origin 検証の有無と方式を比較 |

**Analysis（列挙・taint・差分）**
| tool | 役割 | 対象 |
|---|---|---|
| `detect_stack` | フレームワーク・ライブラリと版数を検出し、既知脆弱版・既知 gadget と照合 | Recon |
| `extract_endpoints` | jsluice ＋ GraphQL operation 抽出 → api_endpoint | E1 |
| `diff_versions` | function_lineage と api_endpoint の差分から新規入口・新機能を出す ★ | E1 |
| `taint_paths` | CodeQL 標準クエリ（`js/xss`, `js/missing-origin-check`, `js/prototype-polluting-assignment` 等）＋ sink_catalog のモデル拡張＋確定事実（tainted_source / fake_sanitizer）を反映 | T1, T2 |
| `check_origin_validation` | 受信ハンドラの origin 検証を「無し / 不完全 / 完全」に分類 | T1b |
| `find_pp_gadgets` | 汚染されうるプロパティ読み → sink | T2 |
| `run_rules` | 昇格ルールの実行（CodeQL / Semgrep） | 全般 |

**Resources（静的データ）**: `sink_catalog`, `known_gadgets`, `vulnerable_libs`

### sa-findings（状態・事実・還元）★ループの心臓部
| tool | 役割 |
|---|---|
| `add_candidate` / `attach_evidence` | 候補と証拠の鎖。evidence の位置は `resolve_location` 済みのものだけ受け付ける |
| `record_refutation` | Orchestrator が起動した反証役の結果を evidence(role=refutation) と status に記録 |
| `get_confirmed_facts(version_id)` | function_lineage で引き継げる active な事実を返す（抑制方向は同一 version のもののみ） |
| `record_dynamic_result` | 人間の動的結果を記録 |
| `confirm_fact` | 事実を登録。polarity・conditions・depends_on・（サーバ依存なら）valid_until 必須 |
| `revoke_fact` | 事実の取消（fact_event に記録） |
| `expire_facts(version_id)` | 対応関数が消えた・depends_on が変わった・TTL 切れの事実を stale にする |
| `find_chains` | 候補どうしを「出力が次の入力になる」関係で連結（T2 汚染 → gadget → T1a sink、T1b 受信 → storage 書き込み → T1a の二次 source）。単体では needs_human でも連結で優先度を上げる ★ |
| `export_test_plan(candidate_id)` | 定型フォーム＋PoC 入力値の案 |
| `update_calibration` | 判定を較正へ反映 |
| `past_verdicts` | fingerprint / feature_key が近い過去判定 |
| `promote_to_rule` | 陽性・陰性テストが通ったルールだけ保存（active=0、レビューで有効化） |

---

## 8. 人間が入る点

| タイミング | 人間 | 対応 |
|---|---|---|
| 開始前 | スコープ・許可リスト・LLM 送信可否の確認 | target.scope |
| 収集 | JS・sourcemap・未取得チャンクの取得、HAR の記録 | find_missing_chunks / import_har |
| Recon後 | 深掘り対象の選択（任意。未選択なら優先度順で続行） | UI |
| Triage後 | 本物/偽/要検証の判定、refuted の抜き取り監査 | status, dynamic_result |
| 能動検証 | テストアカウントで再現（手動のみ） | export_test_plan |
| 提出 | レポート清書・深刻度決定・自分で送信（自動提出しない） | candidate.severity |
| ルール採用 | 昇格ルールのレビュー | promoted_rule.reviewed_by |

検証計画は定型フォーム（本物/偽・到達可否・届いた値・観測条件の選択式）にし、確認のついでに構造化データが貯まるようにする。

---

## 9. 技術スタック

- MCP: TypeScript SDK（解析ツール群が Node 製なのでプロセス内で直接呼べる）。Python FastMCP でも可
- Orchestrator: Claude Agent SDK（サブエージェント構成）
- パース・変換: Babel（parse / generate＋sourcemap）、webcrack（難読化解除。可読ビュー専用）、jsluice（エンドポイント抽出）
- taint: CodeQL（JS）標準クエリ＋モデル拡張
  - **ライセンス要確認**: CodeQL CLI の利用規約は、OSS 以外のコードベースの解析を原則認めていない（GitHub Advanced Security 等の契約が必要）。
    非公開ターゲットのバンドルを報奨目的で解析する用途が許諾範囲に入るかを先に確認する
  - 代替: Semgrep（CE の taint は関数内のみ。関数・ファイルを跨ぐ解析は有償の Pro エンジン）、Joern 等（要評価）
- 保存: SQLite（WAL、foreign_keys=ON）
- 人間の承認: MCP elicitation / Agent SDK のツール実行前フック

---

## 10. 評価

**入力条件を3段階にする**（同じアプリを webpack / vite ＋ terser でビルドして作る）:
(a) ソース、(b) バンドル＋sourcemap、(c) 最小化済み・sourcemap 無し。本番の主戦場は (c)。ソースだけで測ると精度を過大評価する。

- **ゴールデンセット**
  - T1/T2: 既知の脆弱版ライブラリ・アプリの修正前後ペア →「修正前で検出・修正後で非検出」を正解とする
  - T2: 公開されているクライアント側 prototype pollution のライブラリ・gadget 一覧（例: BlackFan/client-side-prototype-pollution）
  - 補助: Juice Shop のクライアント側 XSS、公開 DOM XSS / postMessage / prototype pollution writeup の再現
  - E1: 人間が記録した HAR を正解とし、静的抽出の再現率を測る
- **指標**
  - クラス別の検出率（再現率）/ 偽陽性率 / 本物1件あたりトークンコスト
  - 反証役の誤反証率（refuted の抜き取り監査で測る）
  - 抑制方向の事実による見逃し件数
  - ループの効果: 事実を v1..vn で貯め、**未使用の vn+1** で偽陽性率と再現率を測る（同じ版で測ると過学習を見てしまう）
  - ツールのスキップ数（§6.6）

---

## 11. 既存実装との関係

- **anthropics/defending-code-reference-harness**（Apache-2.0）: Claude Code の skill 群（/threat-model, /vuln-scan, /triage, /patch など）と、
  C/C++ を Docker＋ASAN で検証する自律パイプラインから成るリファレンス実装。メンテ・貢献受付はしていないとされる。
  自律パイプラインは C/C++ のメモリ安全性向けで本設計と重ならず、/patch も Bug Bounty では使わない。
  **ベースにはせず、skill 構成と triage の進め方を参考にする**に留める。
- **GitHub Security Lab Taskflow Agent**: MCP＋YAML の taskflow。思想が近い。ライセンスと動作に必要な契約は原典で確認する。

**隙間**: どちらも「ソースがある防御側」寄り。ソース非公開の JS バンドルを静的に読み、
**人間の動的結果で育つ確定事実レイヤー**を持つものは手薄。ここを本設計の差別化点とする。

---

## 12. 実装順（MVP）

0. **評価コーパスと採点スクリプト**（§10 の (c) 条件を含む）← 以降の各段の効果をここで測る
1. **座標系と成果物テーブル**（§6.1、§6.6）: raw / unpacked / pretty の生成と往復テスト、function_identity
   → 整形で座標を壊さない基盤を先に固める。ここが崩れると以降の記録が全部ズレる
2. **第1段 E1**: `extract_endpoints` + `diff_versions` + `find_missing_chunks` + `import_har`、api_endpoint テーブル
   → taint も確定事実も不要で最速。HAR で再現率を測る
3. Code intel の最小セット（`resolve_location` / `get_function` / `find_references`）
4. **第2段 T1/T2**: CodeQL 標準クエリ＋モデル拡張（`taint_paths`）、`check_origin_validation` → Hunter → Refuter → Triage
   （ライセンス確認をこの段の前に済ませる）
5. 候補・事実スキーマの確定（§6.3、§6.4）、export_test_plan + 人間フォーム → record_dynamic_result / confirm_fact
6. 事実を使った次バージョン解析 → 未使用版で効果測定
7. 第3段: `find_pp_gadgets` と `find_chains`（T2→T1a）、`promote_to_rule`（陽性・陰性テスト付き）で variant analysis

候補・事実のスキーマを手順5まで確定させないのは、E1 と座標系を動かしてから決めた方が手戻りが少ないため。

---

## 13. 未決事項

決定済み（rev.2）: 同一性は関数単位の正規化 AST ハッシュ＋アンカーによるファジー一致（§6.6）/ 失効は関数対応・depends_on・TTL（§6.4）/
監査は fact_event（§6.4）/ feature_key の初期形（§6.5）。

残り:
- function_lineage のファジー一致の閾値（評価コーパスの版違いで決める）
- 事実種別ごとの TTL（例: サーバ依存は 30〜90 日）
- feature_key の粒度の検証（貯まり具合を見て framework を外すか）
- refuted の抜き取り監査率
- LLM 送信可否の判断基準（プログラム規約、sourcemap 由来ソースの扱い）
- CodeQL のライセンス判断と、不可だった場合の代替エンジン
