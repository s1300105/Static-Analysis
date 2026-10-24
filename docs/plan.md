# 実装計画（design.md rev.3 に基づく）

対象: `docs/design.md` rev.3（commit 4763608）。リポジトリにはまだコードが無いので、ゼロから組み立てる前提で書く。
段・手順の番号は design.md §12 に合わせる。規模の目安は S（数日）/ M（1〜2週）/ L（2週超）で、1人で作る想定。

---

## 0. 着手前に決めること（利用者の判断が要るもの）

| # | 決めること | 必要になる時点 | 既定案 |
|---|---|---|---|
| D1 | CodeQL のライセンスの適用範囲の確認結果 | M4 の前 | 確認が取れるまでは OSS コーパスだけで M4 を進め、実ターゲットには掛けない |
| D2 | 評価に使う実ターゲット 2〜3 件（HAR とバンドル 2 版ずつ） | M0 | プログラム規約でソース解析と LLM 送信が許される対象から選ぶ |
| D3 | 実ターゲットごとの `llm_code_policy`（deny / no_original / allow） | M2 | 未設定は deny |
| D4 | 実行環境（コンテナ＋egress プロキシ / sandbox-runtime） | M1 | Docker＋`--network none`＋LLM API だけを通すプロキシ（**既定案で決定**。`docker/README.md`） |
| D5 | 段ごとの合格・撤退条件の初期値（§12 の数値）をそのまま使うか | M2 の終わり | そのまま使い、§13 で調整 |

---

## 1. リポジトリ構成

```
/
├─ package.json / pnpm-workspace.yaml / tsconfig.base.json
├─ packages/
│  ├─ sa-core/        TypeScript ライブラリ。ロジック・検証・状態遷移・DB アクセス・ジョブ実行
│  │  ├─ src/db/          接続初期化(PRAGMA)、移行 SQL(user_version)、リポジトリ関数
│  │  ├─ src/store/       blob ストア(content_hash)、バックアップ
│  │  ├─ src/jobs/        worker_threads / 子プロセスの実行器(上限・タイムアウト・スキップ記録)
│  │  ├─ src/artifact/    load / unpack / relink / pretty / sourcemap / chunks / har
│  │  ├─ src/intel/       resolve_location / get_function / find_references / call_path
│  │  ├─ src/analysis/    extract_endpoints / diff_versions / detect_stack / taint_paths / origin
│  │  ├─ src/findings/    candidate / evidence / refutation / triage / facts / calibration / export
│  │  └─ src/policy/      llm_code_policy、パス検証(原則8)、状態遷移の権限
│  ├─ sa-cli/         `sa` コマンド(人間・自動化の入口。判定の書き込みはここだけ)
│  └─ sa-mcp/         薄い MCP サーバ(読み取り・解析・パイプライン書き込みだけ公開)
├─ codeql/
│  └─ sa-queries/     自前クエリパック(標準設定の委譲＋extensible predicate)
├─ catalog/           sink_catalog / known_gadgets / vulnerable_libs(git 管理、出所付き)
├─ orchestrator/      Claude Agent SDK のサブエージェント定義(Recon/Hunter/Refuter/Reporter)
├─ eval/
│  ├─ corpus/         評価コーパスのビルド定義(アプリ×バンドラ×入力条件 a/b/c)
│  ├─ truth/          正解(E1 の呼び出し箇所、T1 のバグ位置)。ビルド時 sourcemap は評価側だけが持つ
│  └─ score/          採点スクリプト(LLM 無しで CLI から回す)
└─ docker/            実行イメージ(jsluice・CodeQL・Semgrep の版を固定、egress 制限)
```

方針:
- 入口（sa-cli / sa-mcp）は sa-core を呼ぶだけにする。入口にロジックを書かない。
- DB を書くのは sa-core だけ。テストは sa-core の関数単位で書き、入口のテストは薄くする。
- 外部ツールの版は `docker/` で固定し、`analysis_run.tool_version` に記録する。

---

## 2. マイルストーン

各マイルストーンは「作るもの」「完了条件」「次へ進む / 止める判断」で区切る。MVP は M0〜M5。

### M0 — E1 用の評価基盤（§12 手順0'）　規模: M
作るもの:
- [ ] `eval/corpus`: E1 用の OSS アプリ 1〜2 件（Juice Shop など。サーバのルート定義か OpenAPI があり、遅延ロード・権限で隠れた画面を持つもの）を (c) 条件でビルドする定義
- [ ] `eval/truth/e1`: クライアントのソースにある API 呼び出し箇所の正解一覧（grep で洗い出して人がレビュー）。各エントリに「UI 操作で観測される/されない」ラベル
- [ ] 連続するリリースタグ 1 組（diff_versions の正解用）
- [ ] D2 の実ターゲットの HAR とバンドル 2 版
- [ ] `eval/score/e1`: 再現率（全体 / 隠し部分）・偽陽性・抽出器別・GraphQL 別の採点
- [ ] 比較の基準: `jsluice urls` の出力をシェルの diff にかけただけのもの

完了条件: 基準の出力を採点スクリプトで点数化できる。

### M1 — sa-core の骨格と座標系（§12 手順1）　規模: L
作るもの:
- [ ] モノレポの雛形、lint・型検査・テストの CI
- [ ] DB: 接続初期化（`foreign_keys`・`busy_timeout`・WAL）、`user_version` による移行と移行前の DB 複製、`BEGIN IMMEDIATE` のヘルパ
- [ ] 表: `target`、`artifact_version`、`artifact_file`、`code_location`、`analysis_run`、`expected_chunk`（§6.1）
- [ ] blob ストア（content_hash、重複排除）と `sa backup`（`VACUUM INTO`）
- [ ] ジョブ実行器: worker_threads（`resourceLimits`・`stackSizeMb`）と子プロセス（タイムアウト・引数配列で渡す）。失敗とタイムアウトを `analysis_run.skipped_detail` に記録
- [ ] パス検証（原則8）: 作業パスは `<version_id>/<layer>/<file_id>.js` で生成し、作業ディレクトリ配下にあることを検証
- [ ] `load_artifact`（版への追加、`base_version_id`、`source_urls` / `ownership` / `chunk_key` / `parse_status`）
- [ ] `unpack_bundle`（webpack 4/5・browserify の境界検出、ファクトリ本体の切り出し、ESM は縮退、`bundler` の記録）
- [ ] `import_sourcemap`（簡易検証と `map_check`、閾値未満は original 層を作らない）
- [ ] 往復テスト（unpacked → raw）
- [ ] `sa target` / `sa load` の CLI
- [ ] 実行イメージ（D4）

完了条件: 評価コーパスの (b)(c) ビルドを取り込め、unpacked 層の往復テストが全トークンで通る。parse に失敗したファイルが raw 層だけ残ってスキップに数えられる。

### M2 — 第1段 E1（§12 手順2）　規模: L
作るもの:
- [ ] 表: `api_endpoint`（origin・path_norm・UNIQUE）、`endpoint_sighting`（式インデックス）、`page_context`、派生値の VIEW（first/last_seen・observed_in_har・in_scope）
- [ ] `path_norm` の正規化関数とそのテスト
- [ ] `extract_endpoints`: jsluice（子プロセス＋raw への位置戻し）、ast_url（Babel AST）、GraphQL（graphql-js・DocumentNode・Relay・persisted hash）
- [ ] `find_missing_chunks`（チャンクマップ・動的 import・`sourceMappingURL`・`*.LICENSE.txt`、対象外ホストの区別）
- [ ] `import_har`（許可リスト抽出。HAR を保存しないこと、パラメータの値を残さないことをテストで確かめる）
- [ ] `diff_versions` 初期版（api_endpoint の版間差分、新規パラメータ、「未収集による差」の別枠、`triaged_params_hash` による再浮上）
- [ ] 決定的な並び順（初出 → HAR 未観測 → 状態変更メソッド → ui_guard → ID 系パラメータ）
- [ ] `export_endpoints`（OpenAPI 3 / GraphQL operation 文書）
- [ ] sa-mcp の最小版（`extract_endpoints` / `diff_versions` / `find_missing_chunks` を読み取りとして公開）
- [ ] 手順6の前提確認: 実デプロイ 2 版で、関数の exact / fuzzy / 不一致の割合を記録するスクリプト（norm_hash の簡易版で可）

完了条件: M0 の採点で E1 の再現率（全体・隠し部分）と偽陽性が出る。
判断:
- 進む: 隠しエンドポイントの再現率が基準を上回る
- 止める: 新規エンドポイントの検出が基準と変わらなければ、E1 はスクリプトのまま止める（T1 の基盤としての作業は続ける）

### M3 — pretty 層と Code intel（§12 手順3）　規模: M
作るもの:
- [ ] `pretty`（Babel generate＋sourcemap、worker で実行）と往復テスト
- [ ] `function_identity` の最小版（範囲・入れ子・`toplevel` / `module_wrapper`。ハッシュはまだ使わない）
- [ ] `resolve_location`（任意の層 → raw のバイト範囲と AST 種別を検証し code_location を作る）
- [ ] `get_function`（最内の関数、40K 文字上限での骨格と窓、コメント除去オプション）
- [ ] `find_references`
- [ ] `llm_code_policy` の強制（コード本文を返す全ツールの出口で検査）とそのテスト
- [ ] sa-mcp に上記を公開

完了条件: pretty の往復テストが通る。`deny` / `no_original` で本文が返らないことをテストで確かめる。

### M4 — 第2段 T1a・T1b 受信（§12 手順4）　規模: L（最大の山）
前提: D1（CodeQL ライセンス）の確認。確認前は OSS コーパスだけで進める。
先に作るもの:
- [ ] T1 用の評価コーパス: 修正前後ペア、(a)(b)(c) の 3 条件、§10.1 の fixture（別モジュール・別チャンク・ライブラリ sink・DOMPurify の陰性・弱い origin 検証）
- [ ] `eval/score/t1`: バグ単位の照合（ビルド時 sourcemap で raw 座標へ写す）、precision の 2 通り、sink 種別別・入力条件別の再現率、A0/A1/A2 の構成切り替え
- [ ] **候補・証拠スキーマの確定**（§6.3: `candidate`・`candidate_event`・`evidence`・`candidate_link`・`candidate_missing_link`）。同じ版を再実行したときの扱いもここで決める

作るもの:
- [ ] `detect_stack`（版リテラル＋所在、`detected_library`）と `catalog/vulnerable_libs`（retire.js のパターン流用）
- [ ] `relink_bundle`（複数チャンクの集約、`n(<id>)` などの書き換え、既知ライブラリを `require("<pkg>")` に置換、raw への map、往復テスト）
- [ ] `codeql/sa-queries`: `DomBasedXssConfig` などの委譲、extensible predicate（`factFakeSanitizerFn` / `factTaintedRead`）、`{__html: x}` sink、接着 QL
- [ ] `taint_paths`（CodeQL を original → relinked → pretty の順に掛ける。`ALLOW_MINIFIED_FILES`、投入予定と抽出済みファイルの突き合わせ、`client_entry` の書き込み）
- [ ] `check_origin_validation`（自前 QL。完全 / 不完全 / 無し、ガード判定）と、既定バリアで消える弱い検証の列挙
- [ ] `call_path`、`register_llm_run`、`add_candidate` / `attach_evidence` / `record_refutation`（理由種別・実行コード位置・on_path 判定・全経路規則）
- [ ] `apply_triage`（root_cause_key によるまとめ、決定的な並び順、クラス既定値）
- [ ] `orchestrator/`: Recon・Hunter・Refuter のサブエージェント定義。ツールを sa-mcp だけに制限
- [ ] ゴールデンセットの (c) 条件で A0 → A1 → A2 を採点（LLM を含む構成は 3 回ずつ）

完了条件: A0〜A2 が採点でき、sink 種別別の再現率と Refuter の削減数・誤反証数が出る。
判断:
- 進む: A1/A2 が A0 を、ばらつきを超えて上回る（上回らない部品は外す）
- 止める: 実ターゲットで needs_human を 60 件確認して real・duplicate が 0 件なら、そのクラスを凍結する

M4 は大きいので、内部を次の順に分けてマージする:
1. 評価コーパスと採点（A0 用の固定順位まで）
2. スキーマ確定と `taint_paths`（original / pretty のみ）→ ネイティブ DOM sink で A0
3. `relink_bundle` と `detect_stack`・接着 QL → ライブラリ sink の再現率を測り直す
4. `check_origin_validation` → T1b 受信
5. Hunter / Refuter（A1 / A2）と `apply_triage`

### M5 — 事実スキーマと人間の判定の取り込み（§12 手順5）　規模: M
作るもの:
- [ ] **事実スキーマの確定**（§6.4: `dynamic_result`・`confirmed_fact`（CHECK 付き）・`fact_event`・`candidate_fact`・`submission`。`fact_binding` の表はここで作り、中身は M6 で埋める）
- [ ] fact_type → polarity・サーバ依存・既定 TTL の対応表（コード）
- [ ] `export_test_plan`（クラス別テンプレート、推定導線、問い単位の出力、Markdown＋YAML）
- [ ] `sa ingest`（`record_dynamic_result` / `confirm_fact` / `set_verdict`。運用ルールの強制: inconclusive から抑制事実を作らない、target へ広げるときは理由必須、depends_on・valid_until の自動補完）
- [ ] `export_report_draft`、`sa submission`
- [ ] 抑制事実を Triage で後段適用する処理（`suppressed`＋`candidate_fact`、conditions の警告）
- [ ] 実ターゲット 1 件で、検証計画の出力 → 人間が記入 → 取り込みを一巡させる

完了条件: 人間の判定がファイル経由で取り込め、運用ルール違反の入力が CLI で拒否される（テストあり）。

**ここまでで MVP。**

### M6 — 確定事実のループ（§12 手順6）　規模: L
- [ ] `index_functions`: 正規化ビュー（webcrack の unminify 変換）＋norm_hash の完全一致 → 一致率を測ってからファジー一致（一意性規則・第2パス）、`lineage_root_id`、sourcemap による同一性
- [ ] lineage の適合率・再現率の採点（minifier を変えたビルドを含む）→ §13 の閾値を決める
- [ ] `evaluate_facts`（`fact_binding`、`WITH RECURSIVE`、未取得チャンクの保留）→ `get_confirmed_facts`
- [ ] `revoke_fact` と候補への波及、版跨ぎの判定引き継ぎ（§6.3 の表）
- [ ] 較正の VIEW と `recompute_calibration`（m-estimate、上側分位点による並び）、`past_verdicts`
- [ ] `diff_versions` の関数版
- [ ] 複数版コーパスとオラクルスクリプト → 「事実あり / 事実なし」×「較正オン / オフ」の対照評価（§10.3）

判断: 事実ありが事実なしを、ばらつきを超えて改善するか。M2 で測った lineage の一致率が低ければ、関数に結びつく事実の引き継ぎは version スコープに限る。

### M7 — 第3段（§12 手順7）　規模: L
前提: M4 で T1a が合格条件を満たしている。
- [ ] `find_pp_gadgets`、T2 の `taint_paths`（`js/prototype-polluting-assignment`・`js/prototype-pollution-utility`）、`known_gadgets`
- [ ] `find_chains`（`link_channel` / `link_key` による結合、連鎖候補の起票）
- [ ] T1b 送信（`js/cross-window-information-leak`＋秘密の出所のモデル拡張、受信窓の記録）
- [ ] `promote_to_rule`（陽性・陰性テスト）と `run_rules`
- [ ] find_chains あり/なしの比較評価

---

## 3. 依存関係と並行できる作業

```
M0 ─┐
    ├─> M2 ──────────────┐
M1 ─┘   └─> M3 ─> M4 ─> M5 ─> M6 ─> M7
             ▲
  T1 評価コーパス(M4 の前半) は M2・M3 と並行して作れる
  codeql/sa-queries の試作も M3 と並行して OSS コーパスで始められる
```

- M0 と M1 は並行できる（評価は CLI の出力形式さえ決めれば先に書ける）。
- T1 の評価コーパス作り（ビルド定義・正解の作成）は手間がかかるので、M2 の途中から並行して始める。
- CodeQL のクエリパックの試作は、ライセンス確認（D1）の前でも OSS コーパスで進められる。

---

## 4. 最初の2週間でやること

1. モノレポの雛形と CI（lint・型検査・テスト）
2. DB 接続初期化と移行の仕組み、`target` / `artifact_version` / `artifact_file` / `analysis_run` の表
3. blob ストアとジョブ実行器（worker・子プロセス・タイムアウト・スキップ記録）
4. `load_artifact` と `unpack_bundle`（webpack 5 の production ビルド 1 種）と往復テスト
5. Juice Shop を (c) 条件でビルドする定義と、E1 の正解一覧づくりの開始
6. D1〜D4 の確認

---

## 5. 主なリスクと対処

| リスク | 影響 | 対処 |
|---|---|---|
| CodeQL のライセンス確認が取れない | 実ターゲットで M4 以降が動かない | OSS コーパスで開発を続け、実ターゲットへの適用は確認後にする（D1） |
| relinked 層の書き換えが複雑（複数チャンク・バンドラ差） | M4 が延びる | M4 の内部順序で、まず original / pretty でネイティブ DOM sink を通し、relinked は 3 番目に回す |
| 評価コーパスの正解づくりに時間がかかる | 各段の判断ができない | 正解は小さく始め（クラスごとに正例 30 件が目安）、届かない数値は暫定扱い |
| 関数同一性の一致率が低い | 事実の版跨ぎ引き継ぎが効かない | M2 で早めに測り、低ければ関数に結びつく事実は version スコープに限る |
| LLM 段のばらつきで比較が不安定 | 部品の要否が決められない | 3 回実行して最小・最大を出し、ばらつきに埋もれる部品は外す |
| 細工されたバンドルでパーサが落ちる・止まる | 取り込みが止まる | M1 のジョブ実行器で上限とタイムアウトを最初から付ける |
