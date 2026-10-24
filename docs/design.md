# 静的解析 AI Agent + MCP Server 設計書（Web/JS 特化版）rev.3

Bug Bounty 向け。**エージェントはターゲットに一切通信しない**（静的解析に特化）。
対象は **Web / JavaScript・TypeScript のソースおよびバンドル** に一本化（モバイルは対象外）。
動的な確認は人間が行い、その結果を構造化して静的側へ還元し、ループで精度を上げる。

> **rev.3 の主な変更**（rev.2 = cd8a515 に対するレビュー `docs/reviews/rev2-review.md` の 70 件と、下記の決定事項を反映）
> - **構成を「ライブラリ（sa-core）＋CLI＋薄い MCP サーバ1つ」に変更**。ロジックと DB アクセスは sa-core に集約し、CLI・MCP サーバ・レビュー UI の3つの入口から使う。
>   重い処理（Babel・CodeQL・Semgrep・jsluice）は worker / 子プロセスで上限とタイムアウト付きで動かす。webcrack の難読化解除は既定でオフ。
>   **事実の登録・取消など人間の判定を書く操作は MCP に出さず、CLI・UI 専用**にした（§4、§7）
> - **taint エンジンを CodeQL に決定**（ライセンスの適用範囲は利用者が別途確認する。§9）。標準 .ql をそのまま流すのをやめ、
>   自前クエリパック（標準設定の委譲＋確定事実の注入）にした。最小化バンドル向けに relinked 層とライブラリ帰属を追加（§3、§6.6）
> - **スコープを絞った**: 第2段（MVP）の脆弱性クラスは T1a DOM XSS と T1b 受信に限定。T2 は単体候補にせず「T2→T1a 連結」として第3段、
>   T1b 送信は「秘密の出所まで遡れるもの」に限定して第3段。E1 は脆弱性候補ではなくインベントリとして第1段に残す（§2）
> - 確定事実の有効性を版ごとの `fact_binding` に分け、抑制方向の事実はエンジンに入れず Triage の後段フィルタにした（§6.4）
> - candidate の状態を工程・人間判定・提出状態の3軸に分け、追記専用の履歴と版跨ぎの引き継ぎ規則を定めた（§6.3）
> - 実行記録 `analysis_run` を追加し、スキップ数・ツール版・LLM のモデル ID の置き場所を決めた（§6.1）
> - 脅威モデル（ターゲット由来文字列は信頼しない入力、外向き通信の強制方法、LLM 送信可否の強制）を追加（§1、§7）
> - 評価をバグ単位の照合・アブレーション・対照付きのループ評価に作り直した（§10）。実装順を依存関係どおりに並べ直し、段ごとの合格・撤退条件を付けた（§12）
>
> 反映先の対応表は末尾の「付記: レビュー指摘の反映先」を参照。

---

## 1. 設計原則

1. **ターゲットへの通信ゼロ**: 入力は人間が用意したファイル（JS / sourcemap / HAR）だけ。
   許可する外向き通信は LLM API の宛先のみ（allowlist）。解析ツールもオフライン設定で動かす
   （Semgrep はローカルルール＋`--metrics=off`＋`--disable-version-check`、CodeQL パックは事前取得、npm 依存はイメージ構築時に固定）。
   **強制はプロンプトやツール設定ではなく OS／ネットワーク層で行う**（§9「隔離と外向き通信」）。
   LLM に送るコード（特に sourcemap から復元したソース）がプログラム規約上問題ないかは、対象ごとに確認し、
   `target.scope.llm_code_policy` としてツール側で強制する（§7「LLM 送信可否の強制」）。
2. **証拠の鎖（taint 型のみ）**: source（攻撃者制御値）→ 経路 → sink の各点と、経路上の防御が「無い / 不完全」であることが
   静的に揃ったものだけを候補にする。欠けている環が人間の動的確認で埋まる種類（例: API レスポンスの値が攻撃者制御か）なら、
   捨てずに「欠けた環」を構造化して（§6.3 `candidate_missing_link`）`needs_human` に積む。列挙型（E1）はこの原則の対象外（§2）。
3. **座標はツールが書く**: evidence の座標（raw バイト範囲）は必ずツールが書く。
   source / path_step / sink の位置は、エンジン出力（`taint_paths` / `call_path` / `find_pp_gadgets`）の位置をそのまま使う。
   LLM が指す箇所（主に refutation と defense_*）は `resolve_location` で実在と AST 種別を確かめてから座標化する。
   ただしこの検証が保証するのは**実在だけで、経路との関係は保証しない**（関連性の検査は §7 `record_refutation`）。
   出自は `analysis_run.kind`（engine / llm）で機械的に区別できるようにする。
4. **反証の分離**: 発見役と反証役を別コンテキストで動かす。反証された候補も消さず `refuted`＋理由で残し、
   一部を人間が**無作為に**抜き取り監査する（反証役の誤反証＝見逃しを測るため）。
5. **二層の事実**: エンジン/LLM の推論（低信頼）と、人間が動的に観測した事実（確定事実）を別レイヤーで持つ。
   確定事実は「その条件（アカウント権限・機能フラグ・ブラウザ・日時）で観測された」もの。矛盾時は確定事実を優先する。
   ただし**抑制方向の事実**（到達不能・サニタイザ有効など、候補を消す側）は誤ると見逃しを静かに生むので、
   拡張方向の事実（攻撃者制御・偽サニタイザなど）より厳しく扱う。抑制方向については「優先」は
   **候補を消さずに `suppressed` に移し、適用した事実と観測条件を表示する**ことに留める（§6.4）。
6. **人間待ちで止めない**: 判定待ちは `needs_human` キューに積み、エージェントは別作業を続ける。
7. **鮮度管理**: コード変更で影響を受ける事実は版ごとに再評価する（§6.4 `fact_binding`）。影響判定は**関数単位の同一性**で行う
   （バンドル全体の content_hash はデプロイ毎に変わるので、それを契機にすると毎回全失効する）。
   サーバ挙動に依存する事実はコード差分では検知できないため TTL でも失効させる。
8. **ターゲット由来の内容は信頼しない入力として扱う**（rev.3 追加）: ターゲット由来の内容（コード・コメント・文字列・
   `sourcesContent`・HAR）と、そこから導いた文字列（抽出値・LLM 出力・PoC 案・人間が記録した観測値）は、
   **指示ではなくデータ**として扱う。具体的な規則は次のとおり。
   - LLM へのプロンプトでは区切って渡す。ただしこれは単独では効かない補助層で、主な防御は「反証にはコード位置の裏付けを要求する」（§7 `record_refutation`）
     と「状態を変える人間判定の操作をエージェントに渡さない」（§4、§7）の2つ。
   - ファイルシステムのパスはツールが生成する（`<version_id>/<layer>/<file_id>.js`）。sourcemap の `sources` 名やモジュール名は表示用の列（`orig_name`）にだけ置き、
     書き出し時には正規化したパスが作業ディレクトリ配下にあることを検証する。外部ツールにはこの生成パスを**引数配列で**渡し、シェル文字列を組み立てない。
   - SQL はプレースホルダで書く。
   - レビュー UI はすべてテキストとして描画する（自動エスケープか `textContent`。`innerHTML` / `dangerouslySetInnerHTML` 等は禁止。
     ハイライタはエスケープが確かめられたものだけ）。多重防御として UI に `script-src 'self'` の CSP を付ける。

---

## 2. スコープ

対象はクライアント側 JS だけで静的に完結するもの。系統は2つ（列挙型と taint 型）。

### 2.1 rev.3 のスコープ決定

| 区分 | クラス | rev.3 の扱い | 段 |
|---|---|---|---|
| 列挙型 | **E1** 隠しエンドポイント・パラメータ | **対象**（脆弱性候補ではなくインベントリ） | 第1段 |
| taint 型 | **T1a** DOM XSS | **対象（中核）** | 第2段（MVP） |
| taint 型 | **T1b 受信** postMessage 受信ハンドラ | **対象（中核）** | 第2段（MVP） |
| taint 型 | **T2→T1a** prototype pollution の gadget 連結 | **対象（条件付き）**。T2 単体は候補にしない | 第3段 |
| taint 型 | **T1b 送信** `targetOrigin='*'` での機密送信 | **対象（条件付き・絞り込み）**。秘密の出所まで遡れるものだけ | 第3段 |
| — | クライアント側パストラバーサル（CSPT）、JS 内の秘密情報 | **rev.3 では対象外**（§2.6） | — |

### 2.2 判断の理由

1. **E1 を残す（第1段）**: taint も確定事実も不要で最速に価値が出る。人間が最も時間を使う「何を叩くか」を直接減らす。
   さらに T1 系の基盤も兼ねる。raw／unpacked と座標系を先に動かして検証でき、`api_endpoint` は API レスポンス由来の
   `tainted_source` 事実の錨（`client_entry.endpoint_id`、`candidate_missing_link.anchor_endpoint_id`）になる。
   脆弱性候補ではないので、候補・反証・較正のパイプラインには流さない（rev.2 から変更なし）。
2. **T1a を中核にする**: クライアント側 JS だけで source・sink・防御が静的に揃う代表クラスで、報奨対象にもなりやすい。
   CodeQL `js/xss` 系の source/sink は**ネイティブ DOM API とグローバル（`innerHTML`、`document.write`、`location`、`eval`、`message` イベント）なら
   最小化バンドルでも効く**。ライブラリ由来の sink（jQuery `.html()`、React `dangerouslySetInnerHTML`）は名前ベースのモデルと
   ライブラリ帰属（§3.3）で補えば足り、追加の作業量が見積もれる。
3. **T1b 受信を中核にする**: CodeQL は postMessage のイベント引数を既定 source（`browser-message-event`）に含めているので、
   T1a と**同じクエリ・同じパイプライン**に乗る。差分は origin 検証の分類（`check_origin_validation`）だけで、追加コストが小さい。
   「検証が不完全なまま sink に届く」ハンドラは実害につながりやすく、標準クエリが見落とす部分（§3.2 補足）を埋められる。
4. **T2 は単体では候補にせず、連結として第3段に回す**:
   - 汚染プリミティブ単体は影響を示しにくく、報奨対象になりにくい（rev.2 から認識済み）。
   - 主戦場の (c) 条件（最小化・sourcemap 無し）では、CodeQL のライブラリモデル（lodash／jQuery の deep merge）と版依存 sink が
     ライブラリ帰属なしには発火せず（レビュー F05）、モジュールを跨ぐ汚染経路も relinked 層なしには途切れる（F06）。
     版数文字列が残らないライブラリでは既知脆弱版の照合もできない（C05）。つまり T2 の検出品質は第2段で作る基盤（relinked・帰属）に依存する。
   - 価値が出るのは gadget との連結（T2→T1a）で、gadget の終端は T1a の sink である。T1a の sink 認識が固まってから入れる方が手戻りが少ない。
   - 以上から、第2段の T1a が §12 の合格条件を満たした後に、連結を目標として入れる。
5. **T1b 送信は絞って第3段に回す**: 「機密を `'*'` で送っている」は秘密かどうかを静的に決めにくく、informative になりやすい候補を量産する（F65）。
   送る値が静的に秘密の出所（`document.cookie`、token 系 storage キー、OAuth 応答のフィールド等）まで遡れるものだけを候補にし、
   T1b 受信との連結（`event.source` への返信）を主な用途にする。CodeQL `js/cross-window-information-leak` を土台にでき、追加コストは小さいが、
   MVP の中核ではないので第3段とする。
6. **CSPT と秘密情報は今回入れない**: CSPT は同じエンジン（`js/client-side-request-forgery`）で追加コストは小さいが、
   影響がサーバ側の挙動（到達先のメソッド・状態変更）に依存し、評価コーパスの正解例も未整備である。
   秘密情報は既存のスキャナで代替できる。MVP の範囲を守るため、§2.6 のとおり将来候補に留める。

### 2.3 列挙型: 攻撃面インベントリ（脆弱性候補ではない）
- **E1. 隠しエンドポイント・パラメータ** — JS から REST のパス/メソッド/パラメータ、GraphQL の operation（本文・コンパイル済み DocumentNode・
  Relay 生成物・persisted query のハッシュ）、WebSocket 等の URL を機械抽出し、バージョン差分で新機能・新パラメータを見つける。
  出力は「人間が動的に叩く対象の一覧」で、それ自体は脆弱性ではない。`api_endpoint` インベントリとして別管理する（§6.2）。
  並び順は学習しない決定的な規則で決め（§7 `extract_endpoints`）、OpenAPI／GraphQL operation 文書として人間の道具へ出力できる（`export_endpoints`）。
  出力を自動の能動スキャンに流すかは、人間がプログラム規約に従って決める（§8）。

### 2.4 taint 型: 脆弱性候補（確定事実レイヤーが効く）
- **T1a. DOM XSS**（`dom_xss`）— URL 等のクライアント側 source → DOM 挿入 / JS 実行 / `javascript:` URL の sink
- **T1b. postMessage**
  - 受信（`postmessage_recv`）: origin 検証が**無い or 不完全** かつ `event.data` が sink / 機密操作に届く
  - 送信（`postmessage_send`、第3段）: 秘密の出所まで静的に遡れる値を `targetOrigin='*'` で送っている
- **T2. prototype pollution**（第3段）— 危険キー未検査の再帰マージ / パス代入（`proto_pollution`）と、
  汚染されたプロパティを読んで sink に流す gadget（`pp_gadget`）を連結した `chain_pp_xss` を目標とする。
  gadget が見つからない汚染プリミティブは低優先で `needs_human`（missing_link に「gadget 未発見」）。

### 2.5 段階導入

| 段 | 対象 | 根拠 |
|---|---|---|
| **第1段** | E1 | taint 不要で最速。`diff_versions` と収集網羅の価値を即検証。評価は §10 のコーパス評価（隠しエンドポイントを含む）で行う |
| **第2段（MVP）** | T1a, T1b 受信 | ネイティブ DOM API の source/sink は CodeQL 標準設定が土台。ライブラリ由来の sink/sanitizer は帰属ステップ（§3.3）が前提。ここで確定事実レイヤーを組む |
| **第3段** | T2→T1a 連結, T1b 送信 | gadget 検出と `find_chains`。第2段の合格条件（§12）を満たしてから |

### 2.6 静的で扱わず人間に回すもの
- レース / サーバ状態依存ロジック / コードに出ない設定ミス / 秘密情報の有効性 / WAF・インフラ挙動
- **CSP・Trusted Types・Cookie 属性・X-Frame-Options／frame-ancestors・COOP**（レスポンスヘッダ依存）。
  HAR があればセキュリティヘッダを取り込んで参考情報として付ける（§6.2 `page_context`）。HAR に無いもの、サニタイズで欠けたもの、
  回避可否の評価は人間に回す。ヘッダを理由に候補を自動で落とすことはしない（原則5）
- **API レスポンスのどのフィールドが攻撃者制御か**（人間が確認して `tainted_source` として還元する。確定事実レイヤーの主な用途）
- **T1b 送信で攻撃者が受信窓を握れるか**（被フレーム可否・opener 経由。上記ヘッダ依存）

### 2.7 対象外
- self-XSS（被害者自身のフォーム入力だけを source とするもの）
- サーバ側の脆弱性。サーバソースが得られる場合に限り、将来 T3 パストラバーサル / T4 SSRF / T5 デシリアライズ / T6 認可漏れ へ拡張する。
- **将来候補（rev.3 では対象外）**:
  - クライアント側パストラバーサル（CSPT、`client_path_traversal`）: 入れるときは新しいパイプラインを作らず、`taint_paths` に
    `js/client-side-request-forgery` を足し、T1a と混ざらない別 vuln_class にする。評価コーパスに正解例（修正前後ペア）を入れてから有効にする。
  - JS 内の秘密情報: 同じ raw ファイルに既存の秘密情報スキャナを別に掛ける。本システムでは扱わない。

---

## 3. taint 型（T1・T2）の source / sink / 防御定義

`sink_catalog`（MCP resource、git 管理）に格納し、フレームワーク別に拡張する。語彙は本節で一度だけ定義し、他の節はこれを参照する。
防御の有効性は **sink の文脈ごと** に判定する（HTML 本文で有効なエスケープが URL 文脈では無効、など）。
人間が `fake_sanitizer` と確定した関数は無効化する（反映方法は §3.4）。

### 3.1 語彙

- **vuln_class**: `dom_xss`（T1a）/ `postmessage_recv`（T1b 受信）/ `postmessage_send`（T1b 送信）/ `proto_pollution`（T2 汚染）/
  `pp_gadget`（T2 gadget）/ 連結: `chain_pp_xss`・`chain_msg_storage_xss`
- **source_kind**: `hash` / `search` / `href` / `referrer` / `window_name` / `cookie` / `storage` / `api_response` / `message_data` / `secret_value` / `polluted_prop`。
  `client_entry.kind` はこのうちクライアント入口に当たる部分集合にそろえる。
- **sink_kind**: `sink_catalog` の各エントリの id（`innerHTML`、`location_assign` など）。
- **defense_state**: `none` / `weak` / `unknown` の3値。`evidence.role` の `defense_missing`→none、`defense_weak`→weak、
  `check_origin_validation` の 無し→none、不完全→weak に写す。有効な防御は候補にならないので値に含めない。
  1候補に複数経路がある場合は、最も弱いものを採る。
- **feature_key / fingerprint / root_cause_key** は同じ正規化関数で作る（§6.3）。

### 3.2 表

| クラス | source（攻撃者制御） | sink（危険地点） | 防御（有効条件つき） |
|---|---|---|---|
| **T1a DOM XSS** | `location.{hash,search,href}`, `document.{URL,documentURI,baseURI}`, `URLSearchParams`, `window.name`, `document.referrer`<br>二次 source: `localStorage` / `sessionStorage` / `document.cookie`（書き込み経路が別候補で立つ場合）、API レスポンス（§3.5） | HTML: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write(ln)`, `Range.createContextualFragment`, `iframe.srcdoc`, jQuery `.html()`/`.append()` 系と `$(html)`, `dangerouslySetInnerHTML`（**`{__html: x}` 形のオブジェクトリテラルを作り手を問わず sink にする**）, `v-html`, Angular `bypassSecurityTrust*`<br>JS: `eval`, `Function`, 文字列引数の `setTimeout`/`setInterval`, `script.src`/`script.text`<br>URL: `location` 代入・`assign`・`replace`, `window.open`, `a.href`, `iframe.src`（`javascript:`） | DOMPurify（版と設定を確認。`ADD_TAGS` 等の緩和や sanitize 後の文字列加工があれば無効扱い）/ 安全な sink への置換（`textContent`, `createTextNode`）/ URL はスキーム許可リスト（`http:`/`https:`）/ HTML エスケープは HTML 本文文脈でのみ有効 |
| **T1b 受信** | `message` イベントの `event.data`（CodeQL の `browser-message-event`） | T1a の sink、ナビゲーション、storage 書き込み（二次 source 化）、資格情報付きリクエスト等の機密操作 | 次の両方を満たすときだけ有効: (1) **完全一致の比較** — 定数文字列との `===`、配列/Set リテラルや定数集合に対する `includes`/`has`/`indexOf`。(2) その比較が sink への経路を**ガードしている**（同じ分岐を支配している）。<br>**不完全（weak）**: origin がレシーバ側の `indexOf`/`includes`/`startsWith`/`endsWith`、文字列コンテナに対する `includes`/`indexOf`、非定数（URL パラメータ等）との比較、未アンカーや `.` 未エスケープの正規表現、`'null'` の許容、sink をガードしない比較（例: `if (e.origin !== X) console.warn(); el.innerHTML = e.data`） |
| **T1b 送信**（第3段） | 秘密の出所まで遡れる値: `document.cookie`、token/session/auth 系キーの storage 読み出し、認証・OAuth 応答のフィールド、`access_token`/`id_token`/`code` 等のプロパティ名（最小化後も残るプロパティ名・文字列リテラルを根拠にする） | `postMessage(x, '*')` | 具体的な `targetOrigin` の指定 |
| **T2 汚染**（第3段） | 攻撃者制御のキー: クエリ/ハッシュのパース結果（`a[__proto__][x]=` 形式を解釈するパーサ）、URL/postMessage/storage 由来の `JSON.parse` 結果、postMessage のオブジェクト | 再帰マージ/extend（`$.extend(true, …)`, 旧版 `_.merge` / `_.defaultsDeep`、自前の再帰マージ）、パス指定代入（`_.set`, 自前の `obj[k1][k2]=v`） | `__proto__` / `constructor` / `prototype` キーの拒否（`constructor.prototype` 経路も）、`Object.create(null)` / `Map`、`Object.freeze(Object.prototype)` |
| **T2 gadget**（第3段） | 汚染されうるプロパティ読み（自前プロパティを持たないオブジェクトの `opts.x` 等） | T1a の sink | `hasOwnProperty` 検査、プロトタイプなしオブジェクト |

補足:
- T1b 受信は「origin 検証が無い」だけでは候補にしない。解析用・iframe サイズ調整など無害なハンドラが大量にあり、
  原則2（証拠の鎖）とも矛盾するため。逆に「検証はあるが不完全」は見逃さず候補にする。
- **CodeQL 標準設定との差（T1b 受信）**: `js/missing-origin-check` は `@kind problem` で sink への到達を見ず、
  検証の認識も位置依存（`X.includes(e.origin)` は検証あり、`e.origin.indexOf(…)` は検証なし）で上記の分類と一致しない。
  候補の土台には使わず、`check_origin_validation` への参考フラグに限る。
  また全 taint 設定にかかる既定バリア（PostMessageEventSanitizer）は「形は等値・包含だが弱い」検証（文字列コンテナの `includes`、非定数との比較）の経路を
  `js/xss` から消す。MVP ではこの種のハンドラを `check_origin_validation` で列挙し、ハンドラ内で `event.data` が sink に届くかを LLM の読解で確認して
  `needs_human` に積む。バリアを外した自前の経路クエリは第3段以降の任意項目とする。
- **T1b 送信の候補基準**（第3段）: 出所が辿れない `'*'` 送信は候補にしない（参照用一覧に残すだけ）。受信窓の種類
  （`event.source` / `opener` / `parent`・`top` / `iframe.contentWindow` / `window.open` の戻り値）を evidence に記録し、
  origin 検証が無いか不完全な受信ハンドラ内での `event.source` への返信は優先度を上げて T1b 受信と連結する。
  src が固定の同一オリジン iframe への送信は優先度を下げる。missing_link は「攻撃者がこの受信窓を握れるか」とする。
- `Object.assign` やスプレッド構文は浅いコピーで `Object.prototype` を汚染しないので T2 の sink から除く
  （`__proto__` キーで変わるのはコピー先オブジェクト自身のプロトタイプだけ）。

### 3.3 ライブラリの帰属と既知脆弱版

最小化バンドル（§10 の (c) 条件）では CodeQL のライブラリモデル（React・jQuery・lodash・DOMPurify）が import 名・グローバル名で相手を特定するため、
`n(<id>)` で取り込まれたライブラリには当たらない。次の順に補う（主要ライブラリに絞り、npm 全体の指紋コーパスは作らない）。

1. **名前ベースのモデル**を `sink_catalog` に先に足す。terser は既定でプロパティ名を mangle しないので、帰属なしで (c) でも効く
   （`{__html: x}` の HTML sink、帰属済みモジュール上の `.sanitize(` を DOMPurify の sanitizer 候補に、など）。
2. **`detect_stack` がライブラリの所在を返す**。版数に加えて、React・react-dom・jsx-runtime・jQuery・lodash・DOMPurify・Vue 程度について、
   webpack のモジュール ID または raw のバイト範囲を返す。手掛かりは minify 後も残る文字列リテラル（`jquery:"3.x"`、lodash の `VERSION`、
   `Symbol.for("react.element")`、`DOMPurify.version` など）と、sourcemap があれば `sources` / `ignoreList`。結果は `detected_library` に保存する（§6.1）。
3. **接着 QL**: relinked 層（§6.6）では同定したモジュールを `require("<package名>")` に置き換えるので、CodeQL の組み込みモデルと MaD が発火する。
   巻き上げ型のバンドル（Rollup/Rolldown/esbuild）では、jQuery 本体を束縛する変数を位置指定で `JQuery::DollarSource::Range` に足す程度に留める。
   汎用の位置ベース sink/summary 生成は後回しにする。
4. **既知脆弱版の判定は3段で行う**:
   1. 版リテラルがあれば `vulnerable_libs` と照合する。抽出パターンは retire.js の jsrepository（Apache-2.0、オフライン可）を流用する。
      `find_missing_chunks` で `*.LICENSE.txt` の参照も列挙し、人間に取得を依頼する。
   2. 版が無ければ修正の有無を直接判定する。バンドル内の merge / defaultsDeep / set / extend を自前の再帰マージと同じに扱い、
      T2 防御列（`__proto__` / `constructor` キーの拒否）で判定する（CodeQL `js/prototype-pollution-utility`、`function_identity.anchors` のガード文字列）。
   3. どちらも決まらなければ `needs_human`（missing_link に「ライブラリ版／修正有無が未確定」）。
   `detect_stack` の出力には版の根拠（`literal` / `patch_check` / `unknown`）を持たせ、確信度に反映する。
   版依存の判定は合成 package.json では効かない（`dependencyModuleImport` が Import AST を要求する）ので、CodeQL の外で判定するか、
   版で絞った `PrototypePollution::Sink` の独自サブクラスで足す。AST ハッシュによる版系列の推定（指紋 DB）は行わない。
5. 既知 gadget は `known_gadgets` で当てる。`known_gadgets` / `vulnerable_libs` の各項目には出所（URL・取得日）を持たせる（§10 の循環評価対策）。

### 3.4 確定事実のエンジンへの反映

`taint_paths` は標準 .ql をそのまま実行せず、**自前のクエリパック**にする。MaD（data extensions）は追加しかできず、
バンドル内の位置も組み込み barrier の除去も表せないため。

- **XSS 系クエリ**: 標準の `DomBasedXssConfig`（public な `StateConfigSig`）を委譲で再利用する。`isSource` / `isSink` / `isAdditionalFlowStep` とフロー状態はそのまま使う。
  ConfigSig を一から書くとフロー状態が落ちるので避ける。
  - `isBarrier` = 標準 barrier から、`fake_sanitizer` 事実の関数範囲内にある barrier（本体内の replace 系＝MetacharEscapeSanitizer を含む）と、
    その関数の呼び出し結果を除いたもの。
  - `isSource` に `tainted_source` 事実の位置にあるプロパティ読みを加える。API レスポンスは `client_entry(kind=api_response)` の位置に結びつける（§3.5）。
- **事実の受け渡し**: .qll をコード生成せず、自前パックで extensible predicate を宣言する（例: `factFakeSanitizerFn(path, startLine, startCol, endLine, endCol)`、`factTaintedRead(...)`）。
  値は実行ごとに生成する data extension YAML で渡す。raw のバイト範囲は `raw_offset` / `position_map` で解析層の file/line/col に変換する。
- **抑制方向の事実**（`effective_sanitizer` / `unreachable` / `not_controllable`）は CodeQL の barrier に入れない。
  出力された経路への後段フィルタとして Triage で適用し、候補を `suppressed` と事実 ID で残す（§6.4）。抑制による見逃しを測れるようにするため。
- **MaD を使う範囲**: `global` で書けるもの（window 上の DOMPurify / jQuery、定数 URL の直接 fetch など）と、original 層で実パッケージや `file:` として import が見えるものに限る。
- **回帰テスト**: 事実種別ごとに陽性・陰性を 1 組ずつ評価コーパスに加える（fake_sanitizer なら「事実あり→経路が出る／事実なし→出ない」）。

### 3.5 API レスポンスを source にする

- `taint_paths` は source ノードから `client_entry` を書く（`discovered_by` = 実行 ID）。
- `api_response` 種別は CodeQL の `ClientRequest`（global の fetch、XMLHttpRequest、axios 等）の `getUrl()` の定数部分を `api_endpoint.path_norm` と照合し、
  `client_entry.endpoint_id` を埋める。応答データ（`getAResponseDataNode()`）のプロパティ読みのうち `subject.field` に当たるものが source になる。
- `ClientRequest` が認識しない呼び出し（バンドルされた axios や自前ラッパ）は、ラッパの fn_id を人間か LLM が指定し（`resolve_location` で検証）、位置ベースの source にする。
- 事実が無い応答 source は、応答データ全般を仮の source として解析し、候補は `needs_human` にする。そのとき欠けた環を
  `candidate_missing_link(fact_type='tainted_source', anchor_endpoint_id, subject_key=field)` として持たせ、人間の回答がそのまま事実の錨になるようにする。

> E1 は列挙型のため本節の対象外（§7 の `extract_endpoints` / `diff_versions` が担当）。

---

## 4. 全体アーキテクチャ

```
┌──────────────────────────────────────────────────────────────┐
│ Orchestrator (Claude Agent SDK, サブエージェント構成)            │
│  Recon → Hunter(クラス別) → Refuter → Triage → Reporter         │
│  使えるツールは sa-mcp の MCP ツールだけ(WebFetch/Bash 等は外す)   │
└───────────────┬──────────────────────────────────────────────┘
                │ MCP (stdio)
        ┌───────▼────────┐   ┌──────────────┐   ┌──────────────────┐
        │ sa-mcp          │   │ sa CLI        │   │ レビュー UI(後段)  │
        │ 薄いアダプタ      │   │ 取り込み・判定 │   │ 判定・閲覧         │
        │ 読み取り+解析+   │   │ 評価・採点     │   │                  │
        │ パイプライン書込  │   │ 人間判定の書込 │   │ 人間判定の書込     │
        └───────┬────────┘   └──────┬───────┘   └────────┬─────────┘
                └───────────────────┼────────────────────┘
                            ┌───────▼─────────────────────────┐
                            │ sa-core (TypeScript ライブラリ)    │
                            │  ロジック・検証・状態遷移・DB アクセス │
                            │  ジョブ実行(worker / 子プロセス)    │
                            └──┬──────────────┬───────────────┘
                               │              │ 上限・タイムアウト付き
                    ┌──────────▼───┐   ┌──────▼──────────────────────┐
                    │ SQLite (WAL)  │   │ worker_threads: Babel parse/gen │
                    │ blob ストア    │   │ 子プロセス: CodeQL / Semgrep /  │
                    │ キャッシュ     │   │   jsluice / webcrack(任意)      │
                    └──────────────┘   └─────────────────────────────┘
```

- **sa-core に集約する**: ロジック・入力検証・状態遷移の検査・DB アクセスはすべて TypeScript ライブラリ `sa-core` に置く。
  入口は3つで、どれも sa-core を呼ぶだけの薄い層にする。
  - **sa-mcp**（MCP サーバ1つ）: エージェント用。読み取り・解析・パイプラインの書き込み（候補・証拠・反証・実行記録）だけを出す。
  - **sa CLI**: 人間と自動化用。取り込み、判定の記録、事実の登録・取消、評価・採点、バックアップ。E1 と §10 の採点は LLM 無しで CLI から回せる。
  - **レビュー UI**: 閲覧と判定入力。MVP では作らず、CLI＋ファイル（§8）で代える。後段で追加する場合も sa-core を呼ぶ。
- **DB の書き手は sa-core だけ**。3つの入口は同じ SQLite ファイルを sa-core 経由で共有する（外部キーが DB ファイルをまたげないため1ファイル）。
  表を跨ぐ規則（inconclusive から抑制事実を作らない、など）は DB トリガではなく sa-core の書き込み関数で検査する。
- **人間の判定を書く操作は MCP に出さない**: `record_dynamic_result`、`confirm_fact`、`revoke_fact`、verdict / report_state の変更、
  `promote_to_rule` の有効化、`api_endpoint.triage`、`target.scope` の変更は **CLI・UI 専用**。
  プロンプトインジェクション（原則8）で事実やラベルが書き換えられる経路を構造的に無くすため。MCP elicitation や承認フックに頼らない。
- **重い処理は隔離して動かす**: 解析系は AST とキャッシュを共有するので1プロセス（sa-core）にまとめるが、攻撃者入力をパース・実行する工程はプロセス内で直接呼ばない。
  - Babel の parse / generate: `worker_threads`（`resourceLimits` を指定、`stackSizeMb` を広げる。例 64）。ファイルごとに wall-clock のタイムアウト。
  - CodeQL（`--ram` 指定）・Semgrep・jsluice（Go バイナリ）: 版を固定した外部 CLI として子プロセスで呼び、タイムアウトを付ける。
  - webcrack: unminify・jsx・unpack 変換は AST 操作だけなので worker で動かす。**deobfuscate（string array 復号）は既定でオフ**（§6.6）。
  - 失敗・タイムアウトはそのファイルのスキップとして `analysis_run` に記録する。中間結果（AST 等）は content_hash をキーにディスクにキャッシュし、再起動しても作り直さない。
- Knowledge（`sink_catalog`・`known_gadgets`・`vulnerable_libs`）は静的データなので tool ではなく **MCP resource** にする（git 管理）。
- **MCP サーバは決定的なデータ処理・解析だけを持つ**。反証役などのエージェント起動は Orchestrator の責務（MCP tool からエージェントを起動しない）。
  LLM の実行記録は Orchestrator が `register_llm_run` で登録する。
- **候補の生成はエンジン**（CodeQL / jsluice / 自前クエリ）が行い、LLM は Recon の優先順位付け、経路の読解、反証、
  gadget の推論、検証計画の作成を担う（原則3）。
- Orchestrator は Claude Agent SDK に一本化する。

---

## 5. 処理フロー

```
[人間] 対象投入(JSバンドル / sourcemap / 任意で HAR) + スコープ定義(llm_code_policy を含む)   … CLI
   ↓
Artifact : raw 保存(blob) → unpack(モジュールを raw の部分範囲として切り出し) → relink(解析専用)
           → pretty(位置マップ付き) → 関数同一性の計算と base 版との対応付け
           → find_missing_chunks(未取得チャンクを expected_chunk に記録)
   ↓
[開始時] evaluate_facts(version) : 事実ごとに版での有効性を fact_binding に書く
         → get_confirmed_facts(version) : 有効な事実だけ読込(carried_over を記録)
   ↓
Recon    : フレームワーク/ライブラリの版数と所在の検出、クライアント側ルートガード(UI 上の権限境界。サーバ認可ではない)と
           ルート→チャンクの推定、E1 インベントリ生成と差分
   ↓
Hunter   : クラス別(第2段は T1a / T1b 受信)。エンジン実行 → LLM が経路を読み証拠の鎖を整える。
           stale 事実と subject が一致する欠けた環には「旧版で確認済み・要再確認」と注記
   ↓
Refuter  : 別コンテキスト・同じツールで反証を試みる。反証できたものは refuted(理由種別＋コード位置付き)
   ↓
Triage   : 抑制方向の事実を後段フィルタとして適用(suppressed＋candidate_fact)、根本原因でまとめ、
           前版の判定を引き継ぎ、needs_human を並べる(§6.5。較正が貯まるまではクラス既定値)
   ↓
Reporter(検証計画): 問い単位・候補単位の検証計画(クラス別テンプレート・推定導線・PoC 入力値の案)をファイルに出力
   ↓
[人間] 動的テスト → ファイルの判定欄を記入(verdict/到達可否/観測値/観測条件/blocked_by/reportable/poc)
   ↓
sa ingest (CLI) : record_dynamic_result / confirm_fact(運用ルールを検査) → calibration は再計算
   ↓
Reporter(提出草稿): confirmed_real の候補について export_report_draft → 人間が清書・深刻度決定・送信 → report_state
   ↓
promote_to_rule : 本物の経路を CodeQL/Semgrep ルール化(陽性・陰性テスト付き、要レビュー)   … 第3段
   ↓
   └──→ 次バージョンの解析へ(ループ)
```

Refuter を Triage の前に置くのは、較正データ（人間の判定）が「反証を通過した候補」に対して貯まるため。
較正済み確信度は同じ段階（反証通過後）の候補に掛けるのが整合する。
抑制方向の事実を Triage で適用するのは、エンジンの経路を消さずに残し、§10 の「抑制方向の事実による見逃し」を測るため。

---

## 6. DB スキーマ（システムの土台）

SQLite。ID は ULID、時刻は ISO 8601 (UTC)。書き手は sa-core だけ（§4）。

```sql
-- foreign_keys と busy_timeout は接続ごとの設定で DB に保存されない。
-- sa-core は接続を開いた直後に毎回実行する(journal_mode=WAL は DB ファイルに残る)
PRAGMA foreign_keys = ON;   -- SQLite は既定で外部キー制約が無効
PRAGMA busy_timeout = 5000; -- 既定値はドライバで違う(node:sqlite は 0、better-sqlite3 は 5000ms)
PRAGMA journal_mode = WAL;  -- 読み手と書き手が互いをブロックしない(書き込みは1本ずつ直列化)
```

運用ルール:
- 読んでから書くトランザクション（較正の再計算、事実登録＋fact_event、事実の評価）は `BEGIN IMMEDIATE` で始める。
  トランザクションは短く保ち、CodeQL 実行や LLM 呼び出しをまたいで開いたままにしない。大量の INSERT は分割する。
  書き込み失敗はツールエラーとして返し、握りつぶさない。
- スキーマは `PRAGMA user_version` と番号付きの移行 SQL で管理し、移行の前に DB ファイルを自動で複製する。
- 検索に使う外部キーの子側の列には索引を張る（例: `function_lineage(next_fn_id)`、`evidence(candidate_id)`、`confirmed_fact(anchor_fn_id)`、`candidate_fact(fact_id)`）。
  UNIQUE の自動索引と重なる索引は張らない。
- 列挙値すべてへの CHECK はスキーマが固まるまで入れない。入れるのは同じ行で完結する安全上重要な CHECK だけ。

### 6.1 対象・成果物・座標・実行記録
```sql
CREATE TABLE target (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  scope JSON,                    -- 許可ドメイン・対象外・プログラム規約メモ
                                 --  llm_code_policy: deny / no_original / allow (未設定は deny 扱い。確認日と URL を添える)
                                 --  third_party_code: in_scope / out_of_scope / report_to_vendor
  created_at TEXT
);
CREATE TABLE artifact_version (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES target(id),
  label TEXT,
  base_version_id TEXT REFERENCES artifact_version(id),  -- 比較の基準。初版だけ NULL
  collected_at TEXT NOT NULL,    -- 人間が取得した日時
  collection_notes JSON,         -- ログイン有無・ロール・言語・機能フラグ(dynamic_result.conditions と同じ形式)
  ingested_at TEXT
);
CREATE TABLE artifact_file (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES artifact_version(id),
  layer TEXT NOT NULL,           -- raw / unpacked / relinked / pretty / original / renamed (§6.6)
  kind TEXT,                     -- js / sourcemap / html  (HAR は保存しない。§7 import_har)
  path TEXT NOT NULL,            -- ツールが生成する作業パス <version_id>/<layer>/<file_id>.js (原則8)
  orig_name TEXT,                -- sources 名・モジュール名・配信ファイル名(表示専用。パスに使わない)
  content_hash TEXT NOT NULL,    -- sha256。実体は blobs/<hash[0:2]>/<hash> (版をまたいで重複排除)
  parent_file_id TEXT REFERENCES artifact_file(id),  -- 1つ下の層。辿ると raw に着く
  raw_offset INTEGER,            -- unpacked: raw 内の開始バイト(切り出しなので加算だけで逆写像)
  position_map_hash TEXT,        -- relinked / pretty / original / renamed: 親層への sourcemap(blob)
  -- raw 層のみ
  source_urls JSON,              -- 配信 URL(HAR または人間の入力)
  loaded_by_origins JSON,        -- その script を読み込んだ文書のオリジン(HAR の pageref/_initiator、html の <script src>)。不明なら空
  ownership TEXT,                -- first_party / vendored_lib / third_party_service / unknown (推定。人間が上書き可)。unpacked にも付ける
  chunk_key TEXT,                -- ランタイムのチャンクマップ上の ID/名前(contenthash 入りのファイル名ではなく)
  bundler TEXT,                  -- webpack / browserify / turbopack / esm / unknown (unpack_bundle が記録)
  parse_status TEXT DEFAULT 'ok',-- ok / parse_failed / timeout (失敗時は raw 層だけ残す)
  map_check JSON                 -- sourcemap: 簡易検証の一致率(§6.6)
);

-- 版ごとのライブラリ検出結果(candidate.framework の出所)
CREATE TABLE detected_library (
  version_id TEXT NOT NULL REFERENCES artifact_version(id),
  name TEXT NOT NULL, version TEXT,
  version_basis TEXT,            -- literal / patch_check / unknown
  module_id TEXT, location_id TEXT REFERENCES code_location(id),
  run_id TEXT REFERENCES analysis_run(id)
);

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

-- 関数単位の同一性。バージョン間の事実引き継ぎと失効判定の基準
CREATE TABLE function_identity (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES artifact_version(id),
  raw_file_id TEXT NOT NULL REFERENCES artifact_file(id),
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
  kind TEXT DEFAULT 'function',  -- function / toplevel / module_wrapper (§6.6)
  parent_fn_id TEXT REFERENCES function_identity(id),  -- 入れ子の外側
  lineage_root_id TEXT,          -- 最初に現れた版の関数 id(exact / 一意な fuzzy 一致で受け継ぐ)
  norm_hash TEXT,                -- 識別子と構文表記を正規化した AST ハッシュ。入れ子関数の本体はプレースホルダ
  anchors JSON,                  -- 文字列リテラル・プロパティ名・呼び出す API 名(minify で変わらない手掛かり)
  size INTEGER,                  -- AST ノード数。類似度の重み付けにだけ使う
  UNIQUE (raw_file_id, start_byte, end_byte)
);
CREATE TABLE function_lineage (  -- base 版(またはそのチャンクを最後に取得した版)の関数との対応
  prev_fn_id TEXT NOT NULL REFERENCES function_identity(id),
  next_fn_id TEXT NOT NULL REFERENCES function_identity(id),
  match_kind TEXT NOT NULL,      -- exact / fuzzy / sourcemap / ambiguous (ambiguous は引き継ぎに使わない)
  similarity REAL,
  PRIMARY KEY (prev_fn_id, next_fn_id)
);
-- 引き継ぎに使う対応は 1:1 をスキーマで強制する
CREATE UNIQUE INDEX lineage_prev_1to1 ON function_lineage(prev_fn_id) WHERE match_kind <> 'ambiguous';
CREATE UNIQUE INDEX lineage_next_1to1 ON function_lineage(next_fn_id) WHERE match_kind <> 'ambiguous';

-- 位置は必ず raw 基準のバイト範囲で持つ(§6.6)。作るのは resolve_location とエンジン出力の取り込みだけ
CREATE TABLE code_location (
  id TEXT PRIMARY KEY,
  raw_file_id TEXT NOT NULL REFERENCES artifact_file(id),
  start_byte INTEGER NOT NULL, end_byte INTEGER NOT NULL,
  line INTEGER, col INTEGER,     -- 表示用の派生値
  orig_ref TEXT,                 -- sourcemap があれば 元ファイル:行:列(表示用)
  fn_id TEXT REFERENCES function_identity(id),  -- 最も内側の関数
  UNIQUE (raw_file_id, start_byte, end_byte)
);

-- 実行記録。スキップ数・ツール版・LLM のモデルの置き場所
CREATE TABLE analysis_run (
  id TEXT PRIMARY KEY, version_id TEXT REFERENCES artifact_version(id),
  kind TEXT NOT NULL,            -- engine / llm / ingest
  tool TEXT NOT NULL,            -- codeql / semgrep / jsluice / babel / extract_endpoints / hunter / refuter ...
  tool_version TEXT,             -- エンジンとクエリパックの版
  config_hash TEXT,              -- sink_catalog・known_gadgets・vulnerable_libs・有効な promoted_rule・クエリパックの版
  input_layer TEXT,
  model_id TEXT,                 -- LLM: 実際に応答したモデル ID(fallback 後の値)
  prompt_version TEXT,           -- LLM: サブエージェント定義の版またはハッシュ、effort
  files_total INTEGER, files_analyzed INTEGER, files_skipped INTEGER,
  skipped_detail JSON,           -- 理由別: minified 除外 / パス除外 / parse error / timeout / 抽出エラー / 未解決 n(<id>) / unmapped 一覧
  tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL,
  started_at TEXT, finished_at TEXT
);
```

成果物ストア:
- 実体は content_hash を名前にした blob ストアに置き、同じ中身のチャンクは版をまたいで1つだけ保存する。position_map も blob にする。
- **保持**: DB と raw 層（JS・sourcemap）は代わりがきかないので消さない。unpacked・relinked・pretty・CodeQL DB は再生成できるキャッシュとし、
  容量上限を超えたら古い版から実体だけ消す（行は残し、必要時に作り直す）。renamed は証拠に使わないので消してよい。
- **バックアップ**: 稼働中の DB ファイルはコピーせず、`.backup` か `VACUUM INTO` で整合したスナップショットをとる。DB と raw ストアを暗号化して別媒体に置く。
  導入時に一度だけ復元を確認する。対象単位の削除（`sa purge-target`）を行う場合はバックアップも対象に含める。

### 6.2 攻撃面（E1 インベントリと T1/T2 の入口）
```sql
-- E1: JS から見つかったサーバ API。脆弱性候補ではなく「人間が叩く対象」
CREATE TABLE api_endpoint (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES target(id),
  protocol TEXT NOT NULL,        -- rest / graphql / websocket
  origin TEXT NOT NULL DEFAULT '',  -- スキーム＋ホスト。相対パスは取得元ページの origin で補う
  method TEXT NOT NULL DEFAULT '',  -- 不明は ''(NULL だと UNIQUE が効かない)
  path_norm TEXT NOT NULL,       -- 正規化パス(下記)。例 "/api/docs/{}/share"
  path_template TEXT,            -- 表示用。例 "/api/docs/:id/share"
  operation TEXT NOT NULL DEFAULT '',  -- GraphQL の operation 名など
  persisted_hash TEXT,           -- persisted query の sha256(HAR の extensions.persistedQuery と照合)
  ui_guard TEXT,                 -- 参照元のクライアント側ルートガード(推定。サーバ側の認可ではない)
  triage TEXT DEFAULT 'untested',-- untested / tested / interesting / ignore (人間が CLI/UI で付ける)
  triaged_params_hash TEXT,      -- triage 時点のパラメータ集合のハッシュ。変われば再浮上
  UNIQUE (target_id, protocol, origin, method, path_norm, operation)
);
CREATE TABLE endpoint_sighting (  -- 版ごとの事実の置き場。first/last_seen・observed_in_har・params の和集合はここから導く
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES api_endpoint(id),
  version_id TEXT NOT NULL REFERENCES artifact_version(id),
  location_id TEXT REFERENCES code_location(id),  -- HAR 由来は NULL
  params JSON,                   -- [{name, in: query/body/path/header/graphql_var}]
  extracted_by TEXT NOT NULL,    -- jsluice / ast_url / graphql_text / graphql_ast / relay / har
  run_id TEXT REFERENCES analysis_run(id)
);
CREATE UNIQUE INDEX sighting_uniq
  ON endpoint_sighting(endpoint_id, version_id, IFNULL(location_id, ''), extracted_by);

-- T1/T2: クライアント側で攻撃者の入力を受ける口(taint_paths が source ノードから書く)
CREATE TABLE client_entry (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES artifact_version(id),
  kind TEXT,                     -- §3.1 source_kind のうち入口に当たるもの:
                                 -- hash / search / href / referrer / window_name / storage / message_data / api_response
  location_id TEXT REFERENCES code_location(id),
  endpoint_id TEXT REFERENCES api_endpoint(id),   -- api_response のとき(§3.5)。field は detail に持つ
  detail JSON,                   -- パラメータ名・storage キー・field など minify で変わらない識別子
  run_id TEXT REFERENCES analysis_run(id)
);

-- HAR から取り込んだ文書のセキュリティヘッダ(参考情報。抑制には使わない)
CREATE TABLE page_context (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES artifact_version(id),
  document_url TEXT NOT NULL,
  headers JSON,                  -- CSP(Report-Only と区別)/ require-trusted-types-for・trusted-types /
                                 -- X-Frame-Options / frame-ancestors / COOP / <meta http-equiv=CSP>
  observed_at TEXT               -- HAR の観測日時。新しい HAR で上書き
);
```

`path_norm` の正規化規則: 先頭のオリジン（または先頭の EXPR＝ベース URL）を除去し、`EXPR`・`:param`・`{param}`・`${...}` と
数値・UUID・16進のセグメントを `{}` にし、クエリ文字列を除く。派生値（first_seen / last_seen / observed_in_har / in_scope）は
`endpoint_sighting`・`artifact_version.collected_at`・`target.scope` から求める VIEW にする。

### 6.3 候補・証拠の鎖
```sql
CREATE TABLE candidate (
  id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES artifact_version(id),
  vuln_class TEXT NOT NULL,      -- §3.1 の語彙
  entry_id TEXT REFERENCES client_entry(id),
  sink_location_id TEXT REFERENCES code_location(id),
  -- 生成時に固定する特徴(較正・重複排除の材料)
  source_kind TEXT, sink_kind TEXT, defense_state TEXT, framework TEXT,
  feature_key TEXT,              -- "{source_kind}:{sink_kind}:{defense_state}:{framework}" 例 "hash:innerHTML:none:react"
  fingerprint TEXT,              -- hash(vuln_class, source_kind, sink_kind, sink 関数の lineage_root_id, sink_ordinal)
  root_cause_key TEXT,           -- 根本原因でまとめるキー(下記)
  pipeline_version TEXT,         -- Refuter のモデル ID＋プロンプトのハッシュ＋クエリパックの版
  prev_candidate_id TEXT REFERENCES candidate(id),  -- 前バージョンの同一候補
  duplicate_of TEXT REFERENCES candidate(id),       -- 内部の重複(代表候補への参照)
  title TEXT,
  -- 状態は3軸に分ける
  pipeline_state TEXT NOT NULL DEFAULT 'new',  -- new / refuted / suppressed / needs_human / closed
  verdict TEXT NOT NULL DEFAULT 'unverified',  -- unverified / real / false / inconclusive (人間の最終判定)
  report_state TEXT NOT NULL DEFAULT 'none',   -- none / reported / accepted / duplicate_by_program / informative / wontfix ...
  freshness TEXT DEFAULT 'current',            -- current / stale (sink 関数の対応先が新版に無い)
  impact_hypothesis TEXT,        -- 想定される影響(エージェントの仮説。提出草稿では「未検証の仮説」欄)
  severity TEXT,                 -- 人間が提出時に決める
  confidence REAL,
  run_id TEXT REFERENCES analysis_run(id), created_at TEXT
);
CREATE TABLE candidate_event (   -- 追記専用の状態履歴(fact_event と同じ形)
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidate(id),
  field TEXT, from_value TEXT, to_value TEXT,
  actor TEXT, reason TEXT,       -- reason 例: carried_over / audit_upheld / audit_overturned / fact_revoked
  at TEXT
);
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidate(id),
  path_idx INTEGER NOT NULL DEFAULT 0,  -- 1候補に複数経路があるときの経路番号
  role TEXT,                     -- source / path_step / sink / defense_missing / defense_weak /
                                 -- gadget / refutation / reachability / route_hint
  location_id TEXT REFERENCES code_location(id),
  detail JSON, order_idx INTEGER NOT NULL,
  link_channel TEXT,             -- find_chains の結合用: storage / proto_prop / postmessage
  link_key TEXT,                 -- キー名。任意キーや動的キーは '*'
  run_id TEXT NOT NULL REFERENCES analysis_run(id),  -- 生成した実行(LLM 単独の座標は受け付けない)
  UNIQUE (candidate_id, path_idx, order_idx)
);
CREATE TABLE candidate_link (    -- 構成候補 → 連鎖候補の由来記録
  from_candidate_id TEXT NOT NULL REFERENCES candidate(id),
  to_candidate_id TEXT NOT NULL REFERENCES candidate(id),
  relation TEXT,                 -- component_of
  PRIMARY KEY (from_candidate_id, to_candidate_id)
);
CREATE TABLE candidate_missing_link (  -- 「どの事実が登録されればこの環が埋まるか」
  candidate_id TEXT NOT NULL REFERENCES candidate(id),
  fact_type TEXT NOT NULL,       -- confirmed_fact と同じ語彙
  anchor_endpoint_id TEXT REFERENCES api_endpoint(id),
  anchor_fn_id TEXT REFERENCES function_identity(id),
  subject_key TEXT NOT NULL,     -- subject JSON の正規化文字列
  description TEXT,              -- 表示用の説明
  resolved_by_fact_id TEXT REFERENCES confirmed_fact(id)
);
```

候補の粒度と規則:
- **粒度**は「vuln_class × entry 1つ × sink 1箇所」（CodeQL の1アラート相当）。保存する経路は CodeQL が返す経路（最大 `--max-paths` 本）とする。
- **fingerprint** の `sink_ordinal` は、同一関数内で同じ sink_kind の sink のうち何番目か（添字付き AST パスは前方挿入で変わるので使わない）。
  fingerprint は candidate より粗いので、同じ fingerprint の候補は複数あってよい。`prev_candidate_id` の対応付けでは entry の detail
  （パラメータ名・storage キーなど）も照合する。UNIQUE は付けず索引だけにする。同じ版を再実行したときの扱いは §12 手順4 で決める。
- **root_cause_key** は fingerprint から source 種別を除いたもの。T1a は class＋sink の lineage_root_id＋sink_kind、T1b 受信は class＋受信ハンドラの lineage_root_id、
  T2 は class＋汚染プリミティブの lineage_root_id。Triage と検証計画はこれで1件にまとめ、代表以外は `duplicate_of` を付ける。まとめ方は推定なので人間が分割・統合できる。
  外部の既知問題（公開レポート・プログラムの既知問題一覧）は人間が `report_state=duplicate_by_program` と参照先メモを付ける運用にする。
- **連結**: `find_chains` が連結を見つけたら、連鎖全体を1件の candidate（`chain_pp_xss` 等）として起票し、evidence に各段を order_idx 順に並べる。
  dynamic_result・検証計画・較正は連鎖候補に付け、構成候補の状態は連鎖の判定から導く。
- **状態遷移の権限**は sa-core のツール層で検査する。例: `record_refutation` が変えられるのは pipeline_state の new→refuted だけ。
  verdict と report_state は CLI・UI からしか変えられない。すべての変更は candidate_event に残す。
- **版跨ぎの引き継ぎ**（Triage が past_verdicts を引いて決定的に行い、candidate_event に `carried_over` で残す）:

| 前版の状態 | 新版での扱い |
|---|---|
| report_state が reported / accepted、または verdict=real | 新版の候補を前版の候補への `duplicate_of` 付きで表示し、再提出を防ぐ（fuzzy 一致でも引き継ぐ。表示だけなので安全） |
| verdict=false / report_state=wontfix | 自動では閉じない（原則5）。evidence 上の全関数（source・path_step・sink・防御）が exact 一致し、判定理由がサーバ依存でなく TTL 内なら、needs_human の中で優先度を下げ「前版で false」と表示して一括承認できるようにする。承認分は refuted と同様に抜き取り監査の対象。それ以外は前版の判定を表示して通常の needs_human |
| 新版で sink 関数の対応先が無い | 前版の候補を `freshness=stale` にする。reported なら「修正された可能性」として人間に通知 |

  自動で引き継いだ false 判定による見逃しは、§10 の「抑制方向の見逃し件数」に含めて測る。

### 6.4 確定事実レイヤー（人間の動的結果の還元先）★中核
```sql
CREATE TABLE dynamic_result (
  id TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES candidate(id),
  endpoint_id TEXT REFERENCES api_endpoint(id),   -- E1 を叩いた結果もここへ
  version_id TEXT REFERENCES artifact_version(id),
  verdict TEXT,                  -- real / false / inconclusive (静的な主張が成立したか。下記)
  blocked_by TEXT,               -- none / csp / trusted_types / other / unknown (悪用を止めた要因。verdict とは別)
  reportable TEXT,               -- yes / no / unsure
  impact_note TEXT,
  reached_sink INTEGER, observed JSON,
  poc JSON,                      -- 実際に使った URL・ペイロード・操作手順
  impact_observed JSON,          -- 実行された origin、到達したデータや操作
  conditions JSON,               -- アカウント権限・機能フラグ・ブラウザ
  selection_reason TEXT,         -- ranked / uncalibrated / human_pick (選択バイアスの事後分析用)
  origin TEXT DEFAULT 'triage',  -- triage / refuted_audit / suppressed_audit
  time_spent_min INTEGER,        -- 自己申告の所要時間
  superseded_by TEXT REFERENCES dynamic_result(id),  -- 訂正は追記で表す
  test_notes TEXT, tested_by TEXT, tested_at TEXT,
  CHECK (candidate_id IS NOT NULL OR endpoint_id IS NOT NULL)
);
CREATE TABLE confirmed_fact (
  id TEXT PRIMARY KEY, target_id TEXT NOT NULL REFERENCES target(id),
  fact_type TEXT NOT NULL CHECK (fact_type IN
    ('tainted_source','fake_sanitizer','reachable','weak_origin_check',       -- 拡張
     'effective_sanitizer','unreachable','not_controllable')),               -- 抑制
  polarity TEXT NOT NULL CHECK (
    (polarity = 'expand'   AND fact_type IN ('tainted_source','fake_sanitizer','reachable','weak_origin_check')) OR
    (polarity = 'suppress' AND fact_type IN ('effective_sanitizer','unreachable','not_controllable'))),
  anchor_fn_id TEXT REFERENCES function_identity(id),   -- 関数に結びつく事実
  anchor_endpoint_id TEXT REFERENCES api_endpoint(id),  -- API レスポンスのフィールドに結びつく事実
  subject JSON,                  -- {"field":"bio"} / {"sanitizer_fn": "..."} のように型付きで
  depends_on JSON,               -- 経路系の事実: [{fn_id, norm_hash}] (観測時の norm_hash と比べる)
  value JSON,
  observed_version_id TEXT NOT NULL REFERENCES artifact_version(id),
  scope TEXT NOT NULL CHECK (scope IN ('version','target')),
  scope_reason TEXT,
  conditions JSON,               -- 観測条件(dynamic_result から引き継ぐ)
  valid_until TEXT,              -- サーバ挙動に依存する事実は TTL 必須
  dynamic_result_id TEXT REFERENCES dynamic_result(id),
  confirmed_by TEXT, confirmed_at TEXT,
  state TEXT NOT NULL DEFAULT 'active',  -- active / revoked / superseded (人間が起こす状態だけ)
  CHECK (polarity = 'expand' OR scope = 'version' OR scope_reason IS NOT NULL),
  CHECK (fact_type NOT IN ('tainted_source','not_controllable') OR valid_until IS NOT NULL)
);
CREATE TABLE fact_binding (      -- 版ごとの有効性(evaluate_facts が書く)
  fact_id TEXT NOT NULL REFERENCES confirmed_fact(id),
  version_id TEXT NOT NULL REFERENCES artifact_version(id),
  fn_id TEXT REFERENCES function_identity(id),
  status TEXT NOT NULL,          -- valid / stale_fn_changed / stale_fn_missing / not_collected
  similarity_to_observed REAL,
  evaluated_at TEXT,
  PRIMARY KEY (fact_id, version_id)
);
CREATE TABLE fact_event (        -- 監査ログ(追記のみ。人間の判定も誤りうる前提)
  id TEXT PRIMARY KEY, fact_id TEXT NOT NULL REFERENCES confirmed_fact(id),
  version_id TEXT REFERENCES artifact_version(id),
  event TEXT,                    -- created / carried_over / expired / held / revoked / superseded
  reason TEXT, actor TEXT, at TEXT,
  superseded_by TEXT REFERENCES confirmed_fact(id)
);
CREATE TABLE candidate_fact (    -- どの事実がどの候補に効いたか
  candidate_id TEXT NOT NULL REFERENCES candidate(id),
  fact_id TEXT NOT NULL REFERENCES confirmed_fact(id),
  effect TEXT NOT NULL,          -- suppressed / confidence_down / confidence_up / engine_model
  PRIMARY KEY (candidate_id, fact_id)
);
CREATE TABLE submission (        -- 提出結果(遅れて届く信号)
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidate(id),
  platform TEXT, report_ref TEXT,
  outcome TEXT,                  -- resolved / triaged / informative / not_applicable / duplicate / out_of_scope (正規化)
  awarded_severity TEXT, bounty REAL,
  submitted_at TEXT, closed_at TEXT
);
```

**verdict の定義**: 「静的な主張（source→sink の経路と防御の欠如）が成立したか」。T1a はペイロードが危険な形のまま sink に届いたら real
（CSP で実行が止まっても real とし、`blocked_by=csp`）。T1b 受信は攻撃者 origin から送ったデータが sink に届いたら real。
T2 は `Object.prototype` の汚染が観測できたら real（gadget の有無は問わない）。人間が導線を見つけられず sink に届かなかった場合は `inconclusive` とし、false にしない。
条件によって結果が違う場合は real にして、成立した条件を conditions に書く。

**fact_type の対応表**（sa-core にコードとして持つ。DB のマスタ表は作らない）:

| fact_type | polarity | サーバ依存（valid_until 必須） | 既定 TTL |
|---|---|---|---|
| tainted_source | expand | ○ | §13 |
| fake_sanitizer | expand | — | — |
| reachable | expand | — | — |
| weak_origin_check | expand | — | — |
| effective_sanitizer | suppress | — | — |
| unreachable | suppress | 種別ごとに判断 | §13 |
| not_controllable | suppress | ○ | §13 |

`confirm_fact` は polarity をこの表から自動設定し、入力と食い違えば登録を拒否する。

運用ルール（`confirm_fact` と取り込み CLI が検査する）:
- `inconclusive` の結果からは抑制方向の事実を作らない（再現できなかった ≠ 到達不能）。
- 抑制方向の事実は既定で `scope=version`。`target` に広げるのは理由（`scope_reason`）付きで人間が明示したときだけ。
- `observed_version_id` は試験対象だった candidate.version_id、または dynamic_result.version_id から埋める。`anchor_fn_id` の版がこれと一致することを入力検証で確かめる。
- `depends_on` は当該候補の evidence の fn_id 群から自動で埋める。`valid_until` は種別ごとの既定 TTL で埋め、人間が上書きできる。
- 再確認は「新しい事実の登録＋旧事実を superseded」で表す。

**版ごとの評価**（`evaluate_facts(version_id)`。§5 の関数同一性の対応付けの直後、`get_confirmed_facts` の前に呼ぶ）:
- 観測した版から対象の版まで lineage を `WITH RECURSIVE` で辿り、類似度は観測時の関数（norm_hash・anchors）と直接比べる（直前版との比較を積み重ねない）。
- 対応する関数が見つからなくても、その版に `status=missing` の `expected_chunk` が残っている間は `not_collected` とし（fact_event に `held`）、
  すべてのチャンクが fetched / unavailable になった時点で判定し直す。次の版の lineage では保留中の事実の anchor 関数とも照合して復帰させる。
- `get_confirmed_facts(version_id, as_of)` は `fact_binding.status='valid' AND state='active' AND (valid_until IS NULL OR valid_until > :as_of)` で返す。
  - scope=version の事実は `observed_version_id` が要求 version と一致する場合だけ返す。
  - scope=target の事実は、関数アンカーなら lineage で対応がたどれる限り、エンドポイントアンカーなら当該 version に endpoint_sighting がある限り引き継ぐ。
  - 呼び出し順を誤っても失効した事実が返らないように、上の条件は get_confirmed_facts 自身が検査する。返した事実には fact_event(`carried_over`) を書く。

**抑制方向の事実の効き方**: Triage でだけ適用する（エンジンのモデルには入れない。§3.4）。該当候補は消さずに `pipeline_state=suppressed` へ移し、
`candidate_fact(effect=suppressed)` を記録する。suppressed の一覧には適用した事実の id と conditions を出し、人間が「閉じてよいか」を一括で承認できるようにする。
Recon が推定したクライアント側ルートガードや機能フラグ分岐が経路上にあり、その権限・フラグが事実の conditions に含まれていない場合は、
抑制を適用せず警告だけを出す。conditions と候補の前提の自動照合はそれ以上行わない（静的に確実に推定できないため）。

**取消の波及**: `revoke_fact` は candidate_fact から影響を受けた候補を引き、suppressed を needs_human に戻す。engine_model で生まれた候補には
「前提の事実が取り消された」印を付けて返す（candidate_event に `fact_revoked`）。その版を再解析するかは人間が決める。

**拡張方向の事実による欠けた環の解消**: `confirm_fact` はキーが一致する未解決の `candidate_missing_link` に `resolved_by_fact_id` を書く。
全ての環が埋まった候補は再トリアージ待ちに戻す（`taint_paths` の再実行と Triage は Orchestrator が行う）。抑制方向の事実が環に一致した場合は
「閉じてよいか」の確認を付けるだけで、自動では閉じない。missing_link を事実で解決して false になった候補は較正の n_false に数えない。

### 6.5 較正・昇格ルール・並び順

較正は**派生物**にする。正本は dynamic_result で、calibration はそこから再計算する VIEW（または再計算で作る表）とする。
```sql
-- calibration_label: 較正に使うラベル(1 fingerprint 系譜 = 1票)
--   dynamic_result と candidate を結合し、次の条件で絞る
--   - verdict が real / false、superseded_by IS NULL、origin = 'triage'
--   - missing_link を事実で解決して false になったものは除く
--   - prev_candidate_id の系譜の根ごとに最新の判定を1票、root_cause_key が同じものも1票
--   - :as_of(tested_at の上限) と :pipeline_version で切り出せる
-- 集計列: n_real, n_false, n_inconclusive
--   段ごとの件数は source_kind / sink_kind / defense_state / framework / target_id の GROUP BY で求める
CREATE TABLE promoted_rule (
  id TEXT PRIMARY KEY, origin_candidate_id TEXT REFERENCES candidate(id),
  engine TEXT, rule_body TEXT, scope TEXT,
  positive_test TEXT,            -- 元候補のコード(検出されるべき)
  negative_test TEXT,            -- 修正版や類似の安全なコード(検出されてはいけない)
  reviewed_by TEXT, active INTEGER DEFAULT 0, created_at TEXT
);
```

**確信度**: Beta 事前分布を段ごとに連鎖させる（m-estimate）。
- 段の順序（初期値）: クラス → sink_kind → ＋defense_state → ＋source_kind → ＋framework → ＋対象。
  defense_state を source より上に置き、「DOMPurify を通る innerHTML」のような知見が source・framework をまたいで共有されるようにする。
- 各段の事後平均を1つ下の段の事前平均にする: α = m·p_親 + n_real、β = m·(1−p_親) + n_false。擬似件数 m は固定（例: 5）。閾値は要らない。
- クラス既定値は手で決めた弱い事前分布（例: p=0.3、m=2）。ゴールデンセットからは作らない（分布が違う）。
- 表示は「確信度＋実際に効いた段とその n＋inconclusive 率」。クラスのラベル総数が少ないうちは「未較正」と出す。
- 受理率（reportable 率・submission の outcome）は件数が少ないので vuln_class 単位（対象別 → グローバル）で集計し、根拠件数 n が閾値（§13）を超えるまで
  並び順には掛けずに並べて表示するだけにする。報奨額は順位付けに使わない。プラットフォームの duplicate は「型として報奨に値する」側に数えるか、ラベルから外す。
- **母集団の注記**: ラベルが付くのは反証を通過し、かつ人間が選んで試した候補だけなので、較正値はその母集団でしか意味を持たない。
  精度・再現率の全体評価は本番ラベルではなく §10（ゴールデンセット・未使用版）で行う。

**確信度の用途**: needs_human の並び順と表示（n つき）にだけ使い、候補を自動で落とす・隠すことには使わない。
閾値を入れる場合は抑制経路として扱い、refuted と同じ抜き取り監査に載せる。

**needs_human の並び順**（§2・§7 の「優先度」はこれを指す）:
1. `find_chains` で連結済みの候補（連鎖候補は終端 sink 側の確信度で並べる）
2. 確信度の **Beta 事後の上側分位点（例: 80%）** の降順。n の小さい feature_key が時々上位に来てラベルが付くようにするため（選択バイアスの自己強化を防ぐ）。
   代わりに「未較正」の候補を毎回数件だけ上位に混ぜる方式でもよい。どちらで選ばれたかは `dynamic_result.selection_reason` に残す
3. 同順位なら `diff_versions` で新しく現れた関数の候補を先にする
4. gadget 未連結の `proto_pollution`、前版で false の引き継ぎ候補は末尾
5. 人間向けには `candidate_missing_link` を GROUP BY した**問い単位のビュー**も出す（「この1問に答えると N 件の候補が次へ進む」。N はクエリで数え、sink の重みで補正）

較正が貯まるまで（§12 手順4〜5）は LLM を使わない決定的な並べ替え（クラス、欠けた環の有無、連結の有無）とクラス既定値で動く。

### 6.6 座標と整形のルール ★

**唯一の基準座標は「raw ファイル＋バイト範囲」**。line:col は表示用の派生値。
（minify 済みバンドルは全体が1行のことが多く、file:line では位置を特定できない）

層の定義と raw への戻し方:

| 層 | 作り方 | raw への逆写像 | 証拠に使えるか | 主な用途 |
|---|---|---|---|---|
| raw | 配信されたまま | — | ○ | 基準座標・blob 保存 |
| unpacked | 境界を検出できる形式（webpack 4/5 のモジュールマップ、browserify。Turbopack は対象が出てきた段階で認識器を追加）だけ、**ファクトリ関数の本体（波括弧の内側）を raw の部分文字列として切り出す**（コードは書き換えない）。境界が無い形式（Rollup/Rolldown/esbuild の ESM 出力）はチャンク全体を1つの unpacked とする（raw_offset=0） | `raw_offset` の加算だけ | ○ | 関数同一性・表示・Semgrep |
| relinked | **解析専用**（§下記）。全チャンクをモジュール ID の単一名前空間に集め、`n(<id>)`→`require("./<id>.js")`、`n.d(t,{a:()=>b})`→`exports.a=b` 等に書き換える。既知ライブラリは `require("<package名>")` に置き換えて本体を解析対象から外す | Babel generator の sourcemap。合成ノードは `unmapped` | ○（正確に戻せた位置だけ） | CodeQL |
| pretty | Babel で parse → generate（`sourceMaps: true`）。識別子は変えない | 生成した sourcemap | ○ | LLM への提示・CodeQL のフォールバック |
| original | sourcemap の `sourcesContent` から復元。(sourcemap, sources[i]) ごとに行を作り、親はその map の生成元 raw | sourcemap の逆引き（正確一致のみ） | ○（正確に戻せた位置だけ） | `llm_code_policy=allow` のときに限り最優先で読む |
| renamed | webcrack の unminify・難読化解除、LLM による名前復元など、コードを書き換えるもの | AST ノードの元位置が残る場合のみ | ×（可読ビュー専用） | 可読ビュー |

**機械解析を掛ける層**（既定を1つに決める）:
- **CodeQL**: original があれば original（下記の検証を通った map に限る）、無ければ relinked（webpack・browserify）、それも作れなければ pretty
  （ESM チャンクは配信時のパス構造のまま並べ、相対 import を CodeQL に解決させる）。
- **Semgrep**: unpacked があれば unpacked、無ければ pretty（CE の taint はもともと関数内だけなので、分割しても失うものは無い）。
- unpacked を解析に渡す場合は、関数全体を切り出したものなら `(`…`)` の固定長の前置きで包む（逆写像は raw_offset − 前置き長の加算のまま）。

**relinked 層の作り方**:
- raw の全チャンク（`webpackChunk*` / `webpackJsonp` の push と runtime）を Babel で parse し、モジュールを `m/<id>.js` に分ける。
  webcrack の unpack 実装（MIT）を下敷きにしてよいが、複数チャンクは未対応なので集約は自前で行う。
- 各ファクトリの引数位置（module, exports, require）に基づいて書き換える。`n.n(x)` はデフォルト相当に置き換え、`n.r(t)` は除去する。
- 書き換えていないノードは raw の loc を保持したまま Babel generator（`sourceMaps: true`）で出力し、raw への map を得る。
- 自前 QL で webpack ランタイムを呼び出しグラフとしてモデル化する案は採らない。
- **既知の限界**: relinked が作れない形式では、バンドラの実行時 require を跨ぐ流れは CodeQL では追えない。影響の大きさは §10 の (c) 条件の再現率で測る。

**original・renamed から raw へ戻す規則**（共通）:
- raw に「正確に」戻せた位置だけを証拠にする。逆引きは完全一致するマッピングのセグメントがある場合に限り、最近傍への丸め（GREATEST_LOWER_BOUND など）は使わない。
- 生成側の全位置（allGeneratedPositionsFor 相当）を引き、`resolve_location` で開始点を含む raw の AST ノードを範囲として採る。元ノードと種別が一致するものだけを使う。
  - 0件: 「配信されていない可能性あり」として candidate や evidence にしない。件数をスキップとして記録する。
  - 複数件: raw の各位置をそれぞれ code_location にする（各コピーが別々に配信されているため）。
  - source や sink ではなく経路の途中だけが戻せないとき: 欠けた環として needs_human に回す。
- `import_sourcemap` は map を簡易検証する。names 付きのセグメントを抜き取り、生成側の位置が raw のトークン先頭に当たるか、元側の位置の識別子が names[i] と一致するかを数え、
  一致率を `artifact_file.map_check` に記録する。閾値未満なら original 層を作らず、「別ビルドの map の可能性」として人間に返す。
- original 層は import を解決できるように相対ディレクトリ構造を保つ（内容ハッシュ名に改名しない）。sources 名はクエリ部分（`?vue&type=…` 等）を除いて正規化し、
  作業ディレクトリ配下にあることを検証する（原則8）。`.svelte` など CodeQL が扱えない拡張子は unpacked 層の解析に回す。

**webcrack の扱い**:
- unminify・jsx・unpack の各変換は AST 操作だけ。**deobfuscate（string array 復号）はターゲット由来の decoder コードを isolated-vm で実行する**。
- 既定では `deobfuscate:false`（CLI では `--no-deobfuscate`）で動かす。obfuscator.io 系の string array を検出したときだけ人間に知らせ、人間が有効化したときだけ復号する。
- 復号を実行するときは sa-core のプロセス内では呼ばず、別の子プロセス（CLI）として起動し、ネットワークを遮断し（コンテナの `--network none` か OS のサンドボックス）、
  isolated-vm の `memoryLimit` と `timeout`、CPU・メモリ・実行時間の上限を明示する。受け渡しは入力ファイルと出力コードだけにする。
- 復号に失敗した場合や無効のときは renamed 層を作らず pretty 層で代える。renamed は可読ビュー専用なので、オフでも証拠の生成には影響しない。

その他:
- js-beautify は位置マップを出力できないので pretty 層には使わない。
- LLM には pretty / renamed / original から `get_function` で**関数単位に切り出して**見せ、ファイル丸ごとは渡さない（§7 の上限規則）。
- **往復テスト**: pretty 層と relinked 層の全トークンについて「raw に戻した範囲の文字列が同じトークンになる」ことを CI で検証する。

**ツールが黙って（あるいは目立たずに）読み飛ばす罠**:
- CodeQL: `CODEQL_EXTRACTOR_JAVASCRIPT_ALLOW_MINIFIED_FILES=true` を層を問わず常に設定する（平均行長 200 超の除外と `*.min.js` / `*-min.js` 名の除外が両方外れる）。
  `node_modules` / `bower_components` の既定除外は明示的に扱う。解析したいもの（社内パッケージ等）だけを `LGTM_INDEX_FILTERS` の `include:` で再包含し、
  それ以外のライブラリは unpacked 層と detect_stack / known_gadgets で扱う。unpacked / relinked のファイル名はツールが決めるので、
  `*.min.js` や `node_modules` というパス要素を含まない中立的な名前にする。
- CodeQL: fatal parse error のファイルは抽出されない。抽出エラー（`js/diagnostics/extraction-errors`）もスキップ数に含める。
- **汎用の安全網**: DB 作成後に「投入予定のファイル一覧」と「DB に抽出されたファイル一覧（QL で File を列挙）」を突き合わせ、差分を理由つきでスキップとして記録する。想定外の差分があれば失敗にする。
- Semgrep: 既定で 1MB を超えるファイルを読み飛ばす（`--max-target-bytes`）。モジュール単位に切るか上限を上げる。対象ファイルは明示的に渡す
  （明示したファイルには `.semgrepignore` と `.gitignore` が適用されない）。JSON 出力の errors にあるタイムアウトもスキップ数に数え、必要なら `--timeout` を調整する。
- jsluice: テンプレートリテラルと `{param}` を捨てる（§7 `extract_endpoints` の ast_url 抽出器で補う）。
- Babel: parse / generate は worker で動かし、それでも失敗したファイルは `parse_status=parse_failed` として raw 層だけを残し、pretty / function_identity / 往復テストの対象から外して人間の確認に回す。
- unpack_bundle: 境界を検出できなかったファイル数を記録する。relink: 未解決の `n(<id>)` 数を記録する。
- すべて実行ごとに `analysis_run.skipped_detail` に理由別で記録する。

**関数同一性（バージョン間の引き継ぎ）**:
- 対応付けの範囲は版全体（ファイル名にはハッシュが入るため）。チャンクの対応はファイル名ではなくランタイムのチャンクマップの ID・名前（`chunk_key`）で取り、
  取れなければ関数同一性の対応から推定する。未取得チャンクの関数は「そのチャンクを最後に取得した版」と対応を取る。
- ハッシュの前に構文レベルの正規化をメモリ上で掛ける（webcrack の unminify 変換: unminify-booleans、void-to-undefined、sequence、logical-to-if、ternary-to-if など）。
  位置を保存しない「ハッシュ専用ビュー」として扱い、minifier の版や種類による表記差を吸収する。インライン化の差はファジー一致に任せる。
- 両方の版に検証済みの sourcemap があるときは「元パス＋外側関数名の連鎖＋元ソースの正規化 AST ハッシュ」による同一性を最優先にする（`match_kind=sourcemap`）。
- 次に `norm_hash` の完全一致、外れたら `anchors` と AST の類似度でファジー一致させる。
- 除外の条件は**一意性**に一本化する。版全体で norm_hash＋anchors が一意なら小関数でも引き継ぐ（sanitizer・origin 検査は小関数が多いため）。
  衝突した場合は、対応が確定済みの外側の関数・呼び出し元・所属モジュールを手掛かりにする第2パスで一意化を試し、それでも割れるものだけを `ambiguous` にする。
- 入れ子: `code_location.fn_id` は最も内側の関数。`norm_hash` は入れ子の関数本体をプレースホルダに置き換えて計算する。内側のクロージャに依存する事実はその fn_id を depends_on に入れる。
- どの関数にも属さないコードには raw ファイル（unpacked があればモジュール）単位の擬似関数行（`kind='toplevel'`）を作る。
  webpack のモジュールファクトリや IIFE のラッパーも同じ扱い（`kind='module_wrapper'`）。
- 一致しなかった関数に結びつく事実は `fact_binding` で stale にする（未取得チャンクの関数は `not_collected`）。

---

## 7. MCP Server / Tool 定義

すべてのツールの実体は sa-core の関数で、入口ごとに公開範囲を分ける。
「MCP」列が ○ のものだけを sa-mcp がエージェントに公開する。× のものは CLI（`sa <command>`）と UI だけから呼べる。
「手順」は §12 の実装手順。

### 7.1 Artifact（取り込み・層の生成）
| tool | 役割 | MCP | 手順 |
|---|---|---|---|
| `load_artifact(paths, target_id, version_id?, base_version_id?)` | raw 層として blob に保存。version_id を渡せば既存の版へファイルを追加し、その版で unpack 以降をやり直す | × | 1 |
| `import_sourcemap` | sourcemap を簡易検証して original 層を生成（§6.6） | × | 1 |
| `unpack_bundle` | モジュール境界を検出し、raw の部分範囲として unpacked 層を生成。バンドラ名を記録 | × | 1 |
| `relink_bundle` | 解析専用の relinked 層を生成（§6.6） | × | 4 |
| `pretty` | Babel で pretty 層と position_map を生成 | × | 3 |
| `index_functions` | function_identity を計算し、base 版との function_lineage を作る（初期は norm_hash の完全一致のみ） | × | 5 |
| `find_missing_chunks` | chunk マップ・動的 import・`sourceMappingURL`・`*.LICENSE.txt` 参照から、未取得のチャンクと sourcemap を `expected_chunk` に記録（通信しない）。対象外ホストを区別 ★ | ○（読み取り） | 2 |
| `import_har` | 人間が取得した HAR を取り込む（下記） | × | 2 |

`import_har` の規則（HAR はストアに保存しない）:
- 許可リストの項目だけを抜き出す: リクエストのメソッド、URL のパス（ID・トークンに見えるセグメントは `{}` にテンプレート化）、
  クエリ・リクエスト本文のパラメータ名（値は捨てる）、GraphQL の operationName と persisted query のハッシュ、JS / sourcemap のレスポンス本文（`load_artifact` に回す）、
  HTML 文書のセキュリティヘッダ（`page_context`）、pageref / `_initiator`（`loaded_by_origins` と取得元の推定）。
  その他のヘッダ、Cookie、パラメータの値、JSON や HTML の本文は残さない。拒否リストでマスクする方式は独自ヘッダや本文中の JWT を取りこぼすので採らない。元の HAR は人間の手元に残す。
- API リクエストは `api_endpoint` のテンプレートをパターン化して照合し、一致したものはその版の sighting（`extracted_by='har'`）にする。
  一致しないものは「HAR にしか無い api_endpoint」として登録し、静的抽出の見逃しとして扱う。
- LLM に返すのは照合結果（観測済みエンドポイントの件数・未取得 JS の一覧）だけ。

### 7.2 Code intel（座標系と関係）
| tool | 役割 | MCP | 手順 |
|---|---|---|---|
| `resolve_location` | 任意の層の位置 → raw のバイト範囲と AST ノード種別を検証し、**code_location 行を作って id を返す**。LLM が指した箇所の検証にも使う | ○ | 3 |
| `get_function` | 指定位置（または fn_id）を含む**最内の関数**の本体（層を指定、既定 pretty）と raw 位置。オプションでコメント除去（Babel generate を `comments:false`・sourcemap 付きで）。上限（例: 40K 文字）を超える場合は内側の関数本体を「fn_id と raw 範囲」のプレースホルダに畳んだ骨格と指定位置の前後の窓を返し、`truncated=true` と畳んだ fn_id の一覧を付ける。トップレベル（`kind='toplevel'`）は指定位置周辺の文単位の窓を返す | ○ | 3 |
| `find_references` | 参照箇所 | ○ | 3 |
| `call_path` | source→sink の経路（CodeQL の path 結果を整形）。sink を含む関数の呼び出し元・リスナ登録点・ルートとの紐付けも返す | ○ | 4 |
| `similar_handlers` | 同種の message ハンドラを並べ、origin 検証の有無と方式を比較 | ○ | MVP 外 |

**LLM 送信可否の強制**: コード本文を返すツール（`get_function` / `call_path` / `similar_handlers` / `find_references` など）は、出口で要求元 target の
`llm_code_policy` を確認する。`deny` ならコードを返さずエラー、`no_original` なら original 層の本文を返さない（位置と AST 種別のみ）。
CodeQL・jsluice などローカルで完結する解析は制限しない。プロンプトの指示ではなくツール側で強制する（原則3と同じ考え方）。

### 7.3 Analysis（列挙・taint・差分）
| tool | 役割 | 対象 | MCP | 手順 |
|---|---|---|---|---|
| `detect_stack` | フレームワーク・ライブラリの版数と所在（モジュール ID / raw 範囲）を検出し、既知脆弱版・既知 gadget と照合（§3.3）。`detected_library` に保存 | Recon | ○ | 4 |
| `extract_endpoints` | 複数の抽出器で api_endpoint / endpoint_sighting を作る（下記） | E1 | ○ | 2 |
| `diff_versions` | 初期版は api_endpoint の版間差分（新規エンドポイント・既存エンドポイントの新規パラメータ）。後段で function_lineage による新規関数・新規入口を追加 ★ | E1 | ○ | 2 / 6 |
| `export_endpoints(target_id, filter)` | REST は OpenAPI 3（servers に origin）、GraphQL は operation 文書で出力。スコープ外は既定で出さない | E1 | × | 2 |
| `taint_paths` | 自前クエリパック（§3.4）。第2段: `js/xss`・`js/code-injection`・`js/client-side-unvalidated-url-redirection` 等の設定を委譲で再利用し、確定事実（tainted_source / fake_sanitizer）を注入。第3段: `js/prototype-polluting-assignment`・`js/prototype-pollution-utility`・`js/cross-window-information-leak`（秘密の出所は sink_catalog で補う）。source ノードから `client_entry` を書く | T1, T2 | ○ | 4 / 7 |
| `check_origin_validation` | 自前 QL。`MissingOriginCheck` の origin() 型追跡を流用し、比較の形とオペランドの出自で「無し / 不完全 / 完全」に分類し、比較が sink への経路をガードしているかも判定する（§3.2）。`js/missing-origin-check` の結果は参考フラグとしてだけ使う | T1b | ○ | 4 |
| `find_pp_gadgets` | 汚染されうるプロパティ読み → sink | T2 | ○ | 7 |
| `run_rules` | 昇格ルールの実行（CodeQL / Semgrep） | 全般 | ○ | 7 |

`extract_endpoints` の抽出器:
1. **jsluice**（Go バイナリ、子プロセス）。位置を出さないので、抽出結果の source 断片を raw 内で探してバイト範囲に戻す。
2. **ast_url**（Babel AST）: テンプレートリテラルの `${}` を `{}` に置き換え、`{param}` 形式と先頭 `/` の無い相対パスを拾い、呼び出し名（get / post 等）からメソッドを推定する。
   baseURL との結合は同じモジュール内の単純な場合だけをヒューリスティックで扱う（データフローは使わない）。
3. **GraphQL**: 本文は graphql-js で parse、DocumentNode のオブジェクトリテラルは静的に評価して `print()`、Relay artifact は params の name / id / operationKind と selections。
   persisted query の id/hash は `api_endpoint.persisted_hash` に保存する。

既定の並び順（学習しない決定的な規則。どれに当たったかを一覧に併記し、LLM は説明と補足に留める）:
1. 最新版で初出（diff_versions） 2. HAR で未観測 3. 状態を変えるメソッド（POST/PUT/PATCH/DELETE） 4. ui_guard が管理者・内部ロールを示す 5. ID らしいパラメータを含む。
`diff_versions` は両版で取得済みのチャンクだけを「新規/削除」の判定対象にし、片方で未取得だったチャンクに由来する差分は「未収集による差」として別枠で出す。
新しいパラメータが見つかったエンドポイントは `triaged_params_hash` と比べて人間のキューに再浮上させる。

**Resources（静的データ、git 管理）**: `sink_catalog`, `known_gadgets`, `vulnerable_libs`（各項目に出所 URL・取得日）

### 7.4 Findings（状態・事実・還元）★ループの心臓部
| tool | 役割 | MCP | 手順 |
|---|---|---|---|
| `register_llm_run` | Orchestrator が LLM の実行（モデル ID・プロンプトの版・トークン）を analysis_run に登録し run_id を得る | ○ | 4 |
| `add_candidate` / `attach_evidence` | 候補と証拠の鎖。evidence は `resolve_location` が作った code_location の id と run_id だけを受け付ける | ○ | 4 |
| `record_refutation` | 反証役の結果を evidence(role=refutation) と pipeline_state に記録（下記の規則） | ○ | 4 |
| `get_confirmed_facts(version_id, as_of)` | §6.4 の条件で有効な事実を返す | ○（読み取り） | 6 |
| `evaluate_facts(version_id)` | 事実ごとの版での有効性を fact_binding に書く（§6.4） | × | 6 |
| `apply_triage(version_id)` | 抑制事実の後段適用、root_cause_key のまとめ、前版判定の引き継ぎ、並び順の計算を決定的に行う | ○ | 4 |
| `find_chains` | evidence の `link_channel`・`link_key` の等値（`'*'` は何にでも一致）で同じ version の候補を結合し、連鎖候補を起票する（T2 汚染 → gadget → T1a sink、T1b 受信 → storage 書き込み → T1a の二次 source、T1b 受信 → T1b 送信） ★ | ○ | 7 |
| `export_test_plan(candidate_id \| question_id)` | 検証計画をファイル（Markdown＋YAML）に出力（下記） | ○ | 5 |
| `export_report_draft(candidate_id)` | verdict=real の候補について提出草稿の材料を決定的に集める（下記） | ○ | 5 |
| `past_verdicts` | fingerprint / feature_key が近い過去判定。他 target については判定ラベルと feature_key だけを返し、コード本文は返さない | ○（読み取り） | 6 |
| `record_dynamic_result` | 人間の動的結果を記録（取り込み CLI `sa ingest` から） | × | 5 |
| `confirm_fact` | 事実を登録。polarity は fact_type から自動設定、§6.4 の運用ルールを検査 | × | 5 |
| `revoke_fact` | 事実の取消（fact_event に記録し、§6.4 のとおり候補へ波及） | × | 6 |
| `set_verdict` / `set_report_state` / `record_submission` | 人間の最終判定・提出状態・提出結果 | × | 5 |
| `recompute_calibration` | 較正の再計算（冪等） | × | 6 |
| `promote_to_rule` | 陽性・陰性テストが通ったルールだけ保存（active=0）。有効化はレビュー後に CLI で | 保存は ○ / 有効化は × | 7 |

`record_refutation` の規則:
- 理由種別を必須にする（有効な sanitizer / 完全な origin 検証 / 到達不能 / 攻撃者制御でない）。各理由について、`resolve_location` で検証済みの
  **実行コード**ノード（コメントや文字列リテラルではないもの）を要求する。根拠がコメントや命名だけ、またはコード位置を示せない反証は refuted にせず needs_human に回す。
- 軽い関連性チェック: 値を変換する防御（escape・sanitize 呼び出し）は、その引数か戻り値が当該候補の経路のノードに含まれるかを見る（on_path / off_path）。
  条件分岐型の防御（origin 比較・正規表現検査・早期 return）は経路のノードとして現れないので `unverified` とする。off_path の反証は refuted にせず needs_human、
  unverified の refuted は抜き取り監査で優先的に引く。
- 経路上の防御を理由にした反証は、保存した全経路（path_idx）について示せたときだけ refuted にする。示せない経路が残る場合はその path_idx を書いて needs_human に残す。
- Refuter に見せる関数スライスは既定でコメントを除いたものにする。

`export_test_plan` の規則（クラス別テンプレート）:
- 必須項目: 開くページ / ルート（推定導線＝sink を含む関数→モジュール→チャンク→ルートの逆引き。推定であることと根拠位置を付ける）、
  source の入れ方（hash / クエリ / window.name / postMessage を送る側の窓）、トリガ操作のヒント（分からなければ「不明」）、
  静的到達性（登録点あり / 不明。自動での低優先化・refuted 化はしない）、`page_context` の注記（「CSP の回避が要る」など。無ければ「不明」）、PoC 入力値の案。
- T1b 受信: `window.open` で対象を開いて参照へ送る最小 PoC を既定とし、iframe 版は「frame 可能なら」の条件付きで併記する。
  ペイロードは structured clone 可能なものに限り、複数 origin 候補を含める。
- T1b 送信（第3段）: iframe で location を差し替える古典 PoC。連結候補は find_chains の結果に沿って各手順の入力と期待観測を列挙する。
- 問い単位（`candidate_missing_link` のグループ）でも出力できる。
- 判定欄: verdict、到達可否、届いた値、観測条件、blocked_by、reportable、impact_note、poc、impact_observed、所要時間、（事実にする場合）fact_type と subject。
  polarity・depends_on・valid_until は取り込み時に自動で埋める。

`export_report_draft` が集めるもの: 影響を受ける URL・前提条件、evidence の source→sink の鎖（各点に raw ファイル＋バイト範囲と、original 層（無ければ pretty 層）のコード抜粋。
renamed 層は引用しない）、candidate_link で連結された候補、dynamic_result の poc・impact_observed・conditions。影響と再現手順は poc / impact_observed だけを根拠にし、
impact_hypothesis は「未検証の仮説」として別欄に出す。清書・深刻度決定・送信は人間が行う。

---

## 8. 人間が入る点

MVP では専用の Web UI を作らず、**「ファイルを出力 → 人間が記入 → `sa ingest` で取り込む」**方式にする。取り込み CLI は sa-core の同じ検証ロジックを通る。
非同期なので原則6と両立する。閲覧は sqlite3 CLI や Datasette などの既存の読み取りビューアで足りる（例示）。

| タイミング | 人間 | 対応 |
|---|---|---|
| 開始前 | スコープ・許可リスト・**`llm_code_policy`**・サードパーティ由来コードの扱いの確認 | `sa target` → target.scope |
| 収集 | JS・sourcemap・未取得チャンクの取得、HAR の記録（ログイン状態などの収集条件をメモ） | `expected_chunk` の一覧 → `sa load` / `sa import-har` |
| Recon後 | 深掘り対象の選択（任意。未選択なら Recon の優先順位順で続行） | ファイル＋取り込み CLI |
| E1 | エンドポイント一覧の triage。出力を自動の能動スキャン（Burp の API スキャン等）に流すかは、プログラム規約に従って人間が決める | `export_endpoints` / `sa triage-endpoint` |
| Triage後 | 本物/偽/要検証の判定、refuted・suppressed の**無作為**抜き取り監査、**stale 事実の再確認** | 検証計画ファイル → `sa ingest` |
| 能動検証 | テストアカウントで再現（手動のみ） | `export_test_plan` |
| 提出 | レポート清書・深刻度決定・自分で送信（自動提出しない）、提出結果の記録 | `export_report_draft` / `sa submission` |
| ルール採用 | 昇格ルールのレビュー（ルールファイルの差分確認） | `sa rule activate` |

検証計画は定型フォーム（本物/偽・到達可否・届いた値・観測条件・blocked_by・reportable の選択式）にし、確認のついでに構造化データが貯まるようにする。

ラベル付けの指針（クラスごとの判定例）:
- T1a: `#<img src=x onerror=…>` が `innerHTML` に未エスケープで入った → real（CSP で実行が止まっても real、blocked_by=csp）。ルートが見つからず届かなかった → inconclusive。
- T1b 受信: 攻撃者ページから `window.open` 経由で送ったデータがハンドラの sink に届いた → real。origin 検証で弾かれた → false。
- T2（第3段）: `Object.prototype.x` の汚染が観測できた → real（gadget の有無は問わない）。

Web UI は、第2段でループが回ることを確認した後の任意項目とする。

---

## 9. 技術スタック

- **構成**: TypeScript ライブラリ `sa-core`＋CLI `sa`＋MCP サーバ `sa-mcp`（MCP TypeScript SDK、stdio）。後段でレビュー UI。
  TypeScript に決める理由は、pretty 層・位置マップ・関数同一性の基盤である Babel と webcrack を worker で直接使うため。
- **Orchestrator**: Claude Agent SDK（サブエージェント構成）。エージェントが使えるツールは `tools` で sa-mcp の MCP ツールだけにし、WebFetch・WebSearch・Bash は外す
  （`disallowedTools` で明示拒否も可）。`allowedTools` は自動承認であって制限ではないので境界には使わない。
- **パース・変換**: Babel（parse / generate＋sourcemap、worker_threads）、webcrack（unminify / unpack の下敷き。deobfuscate は既定オフ・別プロセス）、
  graphql-js（GraphQL 抽出。gql/graphql タグ付きテンプレート・変換後の呼び出し形・DocumentNode・Relay 生成物・persisted query のハッシュを Babel AST の自前 visitor で拾う。
  graphql-tag-pluck はソース向けなので参考に留める）
- **外部 CLI**（版を固定し、子プロセスで呼ぶ。版は analysis_run.tool_version に残す）: jsluice（Go）、CodeQL CLI とパック、Semgrep
- **taint: CodeQL（JS）に決定**。自前クエリパック（標準設定の委譲＋extensible predicate による事実の注入。§3.4）
  - **ライセンス**: CodeQL CLI の利用規約は OSS 以外のコードベースの解析に制約がある（GitHub Advanced Security 等の契約が必要な場合がある）。
    非公開ターゲットのバンドルを報奨目的で解析する用途が許諾範囲に入るかは、**利用者が別途確認する**。本設計はその確認を §12 手順4の前提条件として置き、
    確認が取れない場合の扱い（その対象では第2段を動かさない等）も利用者の判断とする。設計上の代替エンジンは用意しない
  - Semgrep は関数内の検査と昇格ルールに使う（CE の taint は関数内のみ）
- **保存**: SQLite（WAL、接続ごとに foreign_keys=ON・busy_timeout）。書き込みは sa-core だけ。成果物は content_hash の blob ストア（§6.1）
- **Node**: isolated-vm が対応する偶数系の LTS に固定し、V8 更新を含む point release に追従する
- **人間の承認**: 人間の判定を書く操作は MCP に出さないこと（§4）で担保する。MCP elicitation は使わない。Agent SDK のツール実行前フックは多層防御の一層とする

**隔離と外向き通信**:
- 境界は OS／ネットワーク層に置く。Orchestrator・sa-mcp・解析ツールを、`--network none`＋外部 egress プロキシのコンテナ、または Anthropic の sandbox-runtime で動かし、
  外向き通信は LLM API ホストだけを許可する。プロキシのログで逸脱を検知する。SDK の `sandbox` 設定は Bash にしか効かないので境界とみなさない。
- 個別設定: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、Semgrep `--metrics=off`・`--disable-version-check`（または `SEMGREP_ENABLE_VERSION_CHECK=0`）、
  CodeQL パックは事前取得、npm 依存はイメージ構築時に固定して実行時には取得しない。
- ローカルのセッション記録は `cleanupPeriodDays` で掃除される。必要なら TypeScript の `persistSession:false` で記録自体を止める。送信の記録は Agent SDK のセッション記録で足りる。

---

## 10. 評価

**入力条件を3段階にする**（同じアプリを各バンドラの本番の既定設定でビルドして作る。webpack 5 は production mode（terser＋連結）、
Vite は現行メジャーの既定 minifier。必要なら Next（Turbopack 既定）も加える。組み合わせは (a)〜(c) との掛け合わせに留め、大きな行列にはしない）:
(a) ソース、(b) バンドル＋sourcemap、(c) 最小化済み・sourcemap 無し。本番の主戦場は (c)。ソースだけで測ると精度を過大評価する。

**評価環境**: 評価は毎回、専用の SQLite で固定の初期状態から始める。初期状態では較正は空かクラス既定値のみ、`promoted_rule` は評価セット外の候補から作ったものだけ、
`past_verdicts` は空とする。評価のラベルは本番 DB の `*` 較正に書き込まない。

### 10.1 ゴールデンセット
- **T1a / T1b 受信**: 既知の脆弱版ライブラリ・アプリの修正前後ペア →「修正前で検出・修正後で非検出」を正解とする。
  次の fixture を webpack と vite の各ビルドで入れる: 「source と sink が別モジュール」「別チャンク」「sink がライブラリ API（jQuery `.html()`、React `dangerouslySetInnerHTML`）」
  「DOMPurify で守られた innerHTML（陰性）」「等値・包含だが弱い origin 検証」。
- **事実の回帰**: 事実種別ごとに陽性・陰性を1組ずつ（§3.4）。
- **T2（第3段）**: 公開されているクライアント側 prototype pollution のライブラリ・gadget 一覧（例: BlackFan/client-side-prototype-pollution）。
- **規模**: 現実的な規模の OSS SPA（数 MB、サードパーティ SDK 混在）を (c) 条件でビルドしてそのまま掛け、偽陽性の量を測る。
  再現率は同じアプリに公開 writeup 由来の型（不完全な origin 検証、gadget 連結など）を少数注入して測る。バグ密度を現実に合わせることは求めない。
- **実対象シャドウセット**: 自分の過去の提出・検証済み候補と、そのときのバンドル（artifact_version）を凍結して回帰用に残す。
- **補助**: Juice Shop のクライアント側 XSS、公開 DOM XSS / postMessage / prototype pollution writeup の再現。補助セットは別に集計し、LLM Hunter の費用対効果の判断には使わない。
- **E1**（下記 10.4）。

### 10.2 照合規則と指標
- **バグ単位で数える**: バグ = (vuln_class, sink の raw バイト範囲)。sink の範囲は、T1b 受信なら handler、T1b 送信なら postMessage 呼び出し。
  同じ sink に複数の source や経路が届いても1件。連結はクラス別の再現率では各環をそれぞれのクラスの正解と照合し、全体の件数では終端の sink 1件として数える。
- **照合**: コーパスをビルドした評価者だけが持つビルド時の sourcemap で正解の位置を raw 座標に写し、検出範囲と重なるかで判定する。この sourcemap はツールに渡さない。
- **precision**（人間に提示した候補の単位）: ゴールデン一覧に無い検出は自動で FP にせず、人間が real / false / unknown を判定する。
  unknown を FP とみなした値と、除いた値の2つを併記する。修正前後ペアでは「修正後で検出」を FP/(FP+TN) として併記してよい。
- **指標**:
  - クラス別・**sink 種別（ネイティブ / jQuery / React / sanitizer 認識）別**・入力条件 (a)/(b)/(c) 別の再現率と precision
  - 検出経路別（知識ベース照合 / エンジン taint / LLM）の集計。ライブラリ単体の修正前後ペアは「minify 後に版数を正しく当てられるか（detect_stack の正確さ）」として別枠で測り、
    taint の再現率に入れない。知識ベースの当たりを taint の正解に数えるのは、そのアプリ内で攻撃者 source から到達する経路が示せた場合だけ。
    T2 は「知識ベースで当たった分」と「知識ベースを切った状態」に分けて報告する。
  - 順位: precision@k / recall@k（k は人間がリリース1回あたりに現実的に試せる件数、例 10）、最初の本物に当たるまでの試験件数。較正済みの並び順とエンジンの出力順を比べる
  - 反証役の誤反証率、抑制方向の事実（自動で引き継いだ false 判定を含む）による見逃し件数。まずゴールデンセット（と注入セット）で正解と突き合わせて正確に計算する。
    本番の refuted / suppressed の監査は無作為抽出とし、0件のときは「0/n（95%上限≈3/n）」と上限を併記する
  - 負担: 1MB あたり / 1対象あたりの needs_human 件数と人間の確認時間
  - 費用: 構成ごとの API 費用と実行時間（CodeQL DB 構築を含む）、本物1件あたりの費用
  - ツールのスキップ数（§6.6、`analysis_run.skipped_detail`）
  - 関数同一性: lineage の適合率と再現率（正解はビルド時の sourcemap から作る。条件は無関係な箇所だけ変えたビルドと、minifier の版や種類を変えたビルド（terser と esbuild/Oxc））
- **件数と区間**: 各指標に n と 95% 区間を併記する。目安はクラスごとに正例30件程度（再現率0.8付近なら区間幅は±0.15弱）。届かないクラスの数値は暫定扱いとし、
  小規模セットで出た precision は本番に外挿しない。件数が揃うまで段の実装を止めることはしない。

### 10.3 アブレーションとループの効果
- **比較構成**（ゴールデンセットの (c) 条件）: A0 = エンジンのみ＋固定規則の並び（sink 種別 × 防御状態の固定順）、A1 = A0＋LLM Hunter、A2 = A1＋Refuter。
  find_chains は第3段で入れるときにあり/なしを比べる。採点スクリプトは最初から A0 を出せるようにする。
  Refuter は偽陽性の削減数と誤反証による見逃し数を並べて出す。
- **ばらつき**: LLM を含む構成は同じ入力で3回程度流し、平均と最小・最大を出す。差が実行間のばらつきに埋もれる部品は残す根拠が無いものとして扱う。
  エンジン出力（決定的）と LLM 判断を分けて集計する。同じ fingerprint が実行や版で refuted と非 refuted に割れた候補は抜き取り監査の優先対象にする。
- **ループの効果**（対照付き）:
  - 複数版コーパス: 修正前後ペアを過去に延ばし、脆弱性が残っていた修正前の複数リリース（v1..vk）と修正版を同じ手順でビルドして系列にする。Juice Shop の連続リリースも使う。
    既知バグ以外の出力は1回だけ人手でラベル付けして使い回す。
  - 各対象で時点 t の状態（確定事実・較正・昇格ルール・past_verdicts）を凍結し、**未使用の v(t+1)** を同じ config_hash で「事実あり」と「事実なし」で走らせる。
    較正は Triage で掛かるので、2回の結果に較正のオン/オフを事後に掛け分けて {なし, 事実のみ, 較正のみ, 両方} の4条件を揃える。昇格ルールは手順7の後に条件として足す。
  - 抑制事実による見逃し件数は、抑制事実だけを外して流した結果との差で測る。
  - 事実と判定は、正解ラベルから dynamic_result と confirmed_fact を作る**オラクルスクリプト**で代用する。オラクルで測った値は「人間の判定が完全な場合の上限」と明記する。
    感度確認として、拡張方向の事実と real/false 判定の一部（例: 5〜10%）を反転させる設定を持たせる（抑制方向は scope=target に広げた場合だけ）。
  - 指標は既知バグ単位の再現率と precision@k / recall@k。結果は対象ごとの対の差と件数 n で報告する。
  - 実対象は効果測定に使わない（正解が無い）。版ごとの needs_human 件数と本物件数、偽陽性率の推移を記述的に記録するだけにする。
- **循環評価の対策**: 評価項目ごとに公開日・修正日を記録し、使うモデルの学習打ち切りの前後で分けて集計する。知識ベースと同じ元データを評価に使う場合は、知識ベースを外した再現率も併記する。

### 10.4 E1 の評価
- **コーパス評価（主指標）**: サーバのルート定義か OpenAPI があり、遅延ロードのルートや権限で隠れた画面を持つ OSS アプリ（Juice Shop など）。
  正解はクライアントのソースにある API 呼び出し箇所（メソッド＋パステンプレート＋GraphQL の operation）を、ソース上の HTTP クライアント呼び出しの洗い出しと人のレビューで作る
  （抽出器自身の出力から作らない）。各エントリに「UI 操作で観測される/されない」のラベルを付け、再現率を全体と**隠し部分**に分けて報告する。
  (c) 条件で、「全チャンクを与えた場合」と「初期ロード分＋find_missing_chunks で列挙した分だけ」の2通りを測り、抽出と収集網羅を切り分ける。
  抽出結果のうちクライアントの呼び出し箇所にもサーバのルートにも対応しないものを偽陽性として数える。抽出器ごと（jsluice / ast_url / graphql_*）に分けて測る。
  GraphQL は URL ではなく operationName（または persisted query のハッシュ）単位で照合し、REST とは別に再現率を出す。
- **diff_versions**: 同じアプリの連続するリリースタグの組で、呼び出し箇所の差分（追加/削除されたエンドポイント・パラメータ）を正解に精度と再現率を測る。
- **運用指標（補助）**: HAR 再現率（メソッド一致かつパステンプレートの変数セグメントが任意の1セグメントに一致。スコープ外と計測系ホストは除外）は
  「見えている部分」の下限チェックという位置づけ。人間が実際に叩いたエンドポイントの実在率は dynamic_result.endpoint_id と triage で集計する。

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

**MVP の範囲は手順0〜5**（E1 と、T1a・T1b 受信の候補生成から人間の判定の取り込みまで）。手順6で確定事実のループ、手順7で第3段に進む。
「次へ進む条件 / 止める条件」の数値はすべて**初期値**で、§13 で調整する。タイムボックスは任意。

| 手順 | 内容 | 次へ進む条件 / 止める条件（初期値） |
|---|---|---|
| **0'** | **E1 用の評価**: OSS コーパス（§10.4）と実ターゲット2〜3件の HAR・バンドル2版、採点スクリプト。採点は CLI から LLM 無しで回す | 採点スクリプトが基準（`jsluice urls` の出力をシェルの diff にかけただけのもの）を出せる |
| **1** | **sa-core の骨格と座標系**: DB（§6.1 の該当表、PRAGMA・移行・blob ストア）、`analysis_run`、`load_artifact`（`source_urls`・`ownership` 等の列を含む）、raw と unpacked（raw_offset）、code_location、`import_sourcemap`（(b) 条件で使う）。worker / 子プロセスの実行基盤（上限・タイムアウト・スキップ記録） | 往復テスト（unpacked）が通る |
| **2** | **第1段 E1**: `extract_endpoints`（3抽出器）、`find_missing_chunks`＋`expected_chunk`、`import_har`（許可リスト抽出。HAR を保存しないことを完了条件に含める）、api_endpoint（origin を含む）、`diff_versions` 初期版（api_endpoint の版間差分のみ。function_lineage に依存させない）、`export_endpoints`。sa-mcp の最小版 | 進む: 隠しエンドポイントの再現率が基準を上回る。止める: 新規エンドポイントの検出が基準と変わらなければ E1 はスクリプトのまま止める。あわせて実デプロイ2版で function_lineage の exact / fuzzy / 不一致の割合（特に source・sink を含む関数）を記録しておく（手順6の前提確認） |
| **3** | pretty 層と往復テスト。Code intel の最小セット（`resolve_location` / `get_function` / `find_references`）と `llm_code_policy` の強制 | 往復テスト（pretty）が通る |
| **4** | **第2段 T1a・T1b 受信**。前提: CodeQL のライセンス確認（利用者）と、このクラスの評価コーパス（§10.1 の修正前後ペアと3つの入力条件）。<br>冒頭で**候補・証拠スキーマ（§6.3）を確定**する（同じ版を再実行したときの扱いもここで決める）。<br>`detect_stack`、`relink_bundle`、`taint_paths`（自前クエリパック）、`check_origin_validation`、`call_path`、`register_llm_run`、Hunter → Refuter → `apply_triage`。Triage はこの時点ではクラス既定値と決定的な並べ替えだけ | 進む: (c) 条件のゴールデンセットで A0〜A2 が採点でき、§10 の sink 種別別の再現率が出る。止める: 複数ターゲットで needs_human を一定数（例: 60件）確認しても real・duplicate が0件なら、そのクラスは凍結する（60件で0件なら真の的中率の 95% 上限はおよそ 5%） |
| **5** | **事実スキーマ（§6.4）の確定**、`export_test_plan`（ファイル）＋`sa ingest` → `record_dynamic_result` / `confirm_fact` / `set_verdict`、`export_report_draft`、`submission` | 人間の判定がファイル経由で取り込め、運用ルール（inconclusive から抑制事実を作らない等）が CLI で強制される |
| **6** | **確定事実のループ**: `index_functions`（まず norm_hash の完全一致。版違いのコーパスで対応率を見てからファジー一致を足し、§13 の閾値を決める）、`evaluate_facts` → `get_confirmed_facts`、`revoke_fact`、`recompute_calibration`（m-estimate）、`past_verdicts`、`diff_versions` の関数版 → 未使用版で効果測定（§10.3） | 進む: 「事実あり」が「事実なし」より再現率か precision@k を、ばらつきを超えて改善する。手順2で記録した lineage の一致率が低ければ、関数に結びつく事実の引き継ぎは version スコープに限る（エンドポイントに結びつく事実は関数同一性に依存しないのでそのまま） |
| **7** | **第3段**: `find_pp_gadgets`、T2 の `taint_paths`、`find_chains`（T2→T1a、T1b 受信→送信）、T1b 送信、`promote_to_rule`（陽性・陰性テスト付き）と `run_rules` で variant analysis | 前提: 手順4の T1a が合格条件を満たしている |

**MVP に含めないもの**: `similar_handlers`、Beta 較正（m-estimate。手順6から）、Reporter の LLM 化（最初は定型ファイルだけ）、MCP elicitation、
第3段の `find_pp_gadgets` / `find_chains` / `promote_to_rule`、レビュー Web UI、webcrack の deobfuscate。
Recon 役（LLM による優先順位付け）は手順4で入れる。それまでは §7.3 の決定的な規則で並べる。

候補スキーマは E1 と座標系を動かした後、T1 の Hunter より前（手順4の冒頭）に確定させる。事実スキーマは人間の動的結果を受ける手順5で確定させる。
E1 と座標系を動かしてから決めた方が手戻りが少ないため。

---

## 13. 未決事項

**決定済み（rev.3）**:
- 構成は sa-core＋CLI＋薄い MCP サーバ1つ。人間の判定を書く操作は CLI・UI 専用（§4、§7）
- taint エンジンは CodeQL（自前クエリパック）。ライセンスの適用範囲は利用者が確認する（§9）
- スコープ: 第1段 E1、第2段 T1a・T1b 受信、第3段 T2→T1a 連結・T1b 送信。CSPT・秘密情報は対象外（§2）
- webcrack の deobfuscate は既定オフ・別プロセス（§6.6）
- 抑制方向の事実は Triage の後段フィルタ（§3.4、§6.4）
- 事実の有効性は fact_binding で版ごとに持つ（§6.4）／状態は3軸（§6.3）／較正は dynamic_result からの派生（§6.5）
- 決定済み（rev.2 から継続）: 同一性は関数単位の正規化 AST ハッシュ＋アンカーによるファジー一致（§6.6、rev.3 で一意性規則と正規化を改訂）／監査は fact_event（§6.4）

**残り**:
- function_lineage のファジー一致の閾値（評価コーパスの版違いで決める。§10.2 の lineage の適合率・再現率）
- 事実種別ごとの TTL（例: サーバ依存は 30〜90 日。§6.4 の対応表と一本化）
- 較正の m と段の順序の見直し（ラベルが貯まった後）
- 旧パイプラインの票の扱い（減衰・リセット・混合。当面は pipeline_version で絞り込む）
- 受理率を並び順に掛け始める根拠件数 n の閾値
- refuted・suppressed の抜き取り監査率（無作為抽出で 0 件のとき上限は≈3/n。20件なら約15%までしか絞れないことを前提に決める）
- 段ごとの判定閾値の調整（§12 の初期値）
- sourcemap の簡易検証の一致率の閾値（§6.6）
- LLM 送信可否の判断基準（プログラム規約、sourcemap 由来ソースの扱い。ログイン状態で保存した HTML の SSR 埋め込み状態（`__NEXT_DATA__` 等）にユーザー情報やトークンが入りうる点を含む）
- 対象単位の削除手順（`sa purge-target`: target 配下の DB の行・blob ストア・CodeQL DB・バックアップ）
- 版を取得する頻度と手順（未取得チャンクの一覧を見て人間が取得する。収集用スクリプトや自動の定期取得は設計に入れない）
- OS レベルの隔離（コンテナ・ネットワーク無効化）をどこまで必須にするか（個人用ツールでは deobfuscate 実行時以外は任意）
- E1 用の較正（似た特徴による並べ替えの学習）を作るか（運用データが貯まってから）

---

## 付記: レビュー指摘の反映先

`docs/reviews/rev2-review.md` の 70 件を、検証後の修正案に沿って反映した。修正案どうしが食い違う箇所は下表の「調整」のとおりにした。

| テーマ | 指摘 | 主な反映先 |
|---|---|---|
| A. エンジン前提 | F05, F06, F09, F07, F08, C05, F41 | §2.2, §3.2〜3.4, §6.6, §7.3, §10.1 |
| B. 確定事実ループ | F27, F21, F23, F26, F28, F29, F36, F53, F59 | §1(原則3・5), §3.5, §6.3, §6.4, §7.4 |
| C. エージェント自身の安全 | C04, F10, F11, F12, F13, F35, F60, F46, F48, F50 | §1(原則1・8), §4, §6.6, §7.1〜7.4, §9 |
| D. Bug Bounty 実務 | C02, C03, F01, F02, F03, F04, F38, F39, F37, F65, F66 | §2, §3.2, §6.1〜6.5, §7.3〜7.4, §8 |
| E. E1 | F25, F18, F22, F40, F43 | §6.1, §6.2, §7.1, §7.3, §10.4 |
| F. 評価 | F14, F15, F16, F17, F19, F20, F51, F52 | §6.5, §10 |
| G. 同一性・座標・候補 | F30, F42, F44, F45, F54, F55 | §6.3, §6.6, §7.4 |
| H. MVP・運用・スキーマ | F24, F32, F33, F56, F61, F62, F63, C01, F34, F57, F58, F64, F68, F69 | §4, §6, §7, §8, §9, §12 |

調整（修正案どうし、または決定事項との食い違い）:
- **F12・F57**（MCP 2つを維持）と **F63-4**（ライブラリ＋CLI＋MCP 1つ）: 決定事項どおり後者を採り、DB の書き手を sa-core に一本化した。
- **F62**（MVP では Web UI を作らない）と決定事項（UI は入口の1つ）: UI は sa-core を使う入口として位置づけ、MVP はファイル＋取り込み CLI で代える。
- **F10-4**（状態変更ツールはエージェントから外すかフックで承認）: 決定事項どおり「MCP に出さない」に一本化し、elicitation・承認フックには頼らない。
- **F31**（検証で不採用）: CodeQL を採用し、ライセンス確認は利用者が行うという決定で扱いが確定した。
- **F23** と **F28**（失効の表現）: F23 の `fact_binding`＋`evaluate_facts` を採り、F28 の「get_confirmed_facts 自身が条件を検査」「stale 事実は再確認の注記」を取り込んだ。
- **F21**（`suppressed` 状態）と **F29**（status を自動で変えず確信度を下げる）: 候補を消さない `pipeline_state=suppressed` に置き、適用事実と conditions を表示して人間が一括承認する形にした。
- **F27**（.qll 生成）と **F09**（extensible predicate＋YAML）: F09 を採った。
- **F30**（CodeQL は pretty）と **F06**（relinked）: original → relinked → pretty の順の既定にした。
- **F35**（HAR を保存しない）と **F25・F64**（HAR 原本を明細として残す）: プライバシーを優先して F35 を採り、HAR 由来の観測は sighting（`extracted_by='har'`）と `page_context` に許可リストの項目だけ残す。
- **F56**（sighting の location_id NOT NULL）と **F25**（HAR 由来は NULL）: 式インデックス `IFNULL(location_id,'')` の UNIQUE にした。
- **F04・F68**（事後平均の降順）と **F14**（上側分位点）: 選択バイアス対策として F14 を採った。
- **F34**（T2 を第3段へ移す必要は無い）: スコープ判断（§2.2）として T2 は第3段に移した。理由は F05・F06・C05 による (c) 条件での検出品質の依存と、報奨価値が連結で出ること。
- **F66**（CSPT・秘密情報）: 選択肢のうち「対象外（将来候補）」と「(A) 既存スキャナを別に掛ける」を採った。
- 検証で落ちた **F47・F49・F67** は反映していない。
