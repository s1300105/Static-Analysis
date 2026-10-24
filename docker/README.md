# 実行イメージ（D4）

`docs/plan.md` の D4（実行環境）は既定案で決めた: **Docker＋`--network none`＋LLM API だけを通すプロキシ**。
境界はプロンプトや SDK の設定ではなくネットワーク層に置く（design.md §9「隔離と外向き通信」）。

| ファイル | 中身 |
|---|---|
| `sa/Dockerfile` | `sa` の実行イメージ。CodeQL・Semgrep・jsluice とベースイメージの版を固定（linux/amd64 のみ） |
| `sa/semgrep-requirements.txt` | Semgrep と依存の版とハッシュ（`--require-hashes` で入れる） |
| `sa/with-build-ca.sh` | build 時だけ TLS 中継プロキシの CA を信頼する補助（イメージには残らない） |
| `egress-proxy/` | squid。`api.anthropic.com:443` への CONNECT だけを通し、全リクエストを標準出力に記録 |
| `compose.yaml` | LLM と一緒に動かすときの構成（内部ネットワーク＋egress プロキシ） |
| `verify.sh` | 版・オフラインでの動作・外向き通信の制限を確かめる（CI: `.github/workflows/docker.yml`） |

## 固定している版

| もの | 版 | 固定のしかた |
|---|---|---|
| Node（ベース） | 22.22.0（bookworm-slim） | イメージのダイジェスト |
| CodeQL | バンドル 2.27.3（CLI＋標準クエリパック） | sha256。パックはバンドル内のものを使い、実行時に取得しない |
| Semgrep | 1.182.1 | 依存を含めて全パッケージのハッシュ |
| jsluice | `v0.0.0-20240110145140-0ddfab153e06`（タグが無いのでコミットの擬似版） | Go モジュール版。sum.golang.org で検証 |
| Go（jsluice のビルド） | 1.25.14（bookworm） | イメージのダイジェスト |
| squid（プロキシ） | Debian 12.15 の squid パッケージ | ベースイメージのダイジェスト |

イメージ内の `/opt/sa/tools.json` にツールの場所と版を書き出している（`analysis_run.tool_version` の出所）。
イメージは `SA_TOOLS=/opt/sa/tools.json` を設定しているので、`sa extract-endpoints` はここから jsluice を見つける（CodeQL・Semgrep は使う PR で読む）。

## 動かし方

```bash
docker compose -f docker/compose.yaml build      # sa:local と sa-egress-proxy:local
```

**LLM を使わない解析**（いまの `sa load` など）はネットワークを持たせずに動かす:

```bash
docker volume create sa-data
docker run --rm --network none -v sa-data:/data sa:local target add example --allow example.com
docker run --rm --network none -v sa-data:/data -v "$PWD/collected:/in:ro" sa:local \
  load example /in/main.js /in/main.js.map --collected-at now
```

イメージの `ENTRYPOINT` は `sa`、データは `/data`（`SA_HOME`）。シェルのワイルドカードはホスト側で展開されるので、
入力はファイル名を並べるか `--manifest /in/manifest.json` で渡す。

**LLM を使うとき**（M4 の Orchestrator 以降）は `compose.yaml` で動かす。`sa` は外へ出る経路の無い内部ネットワークにだけ繋がり、
外へ出られるのは egress プロキシだけ。プロキシは `api.anthropic.com:443` だけを通す。

```bash
SA_INPUT_DIR="$PWD/collected" docker compose -f docker/compose.yaml run --rm sa target list
docker compose -f docker/compose.yaml logs egress-proxy | grep DENIED     # 逸脱の検知
```

プロキシの環境変数（`HTTPS_PROXY`）を無視するプログラムがあっても、ネットワークに経路が無いので外へ出られない。
許可先を足すときは `egress-proxy/squid.conf` の `acl llm_api dstdomain` を変える（足す理由をコミットに書く）。

## 確かめる

```bash
docker/verify.sh
```

1. 固定した版のツールが入っている
2. `--network none` で jsluice・Semgrep（ローカルの規則）・CodeQL（DB 作成と同梱パックの `js/xss`）・`sa load`・`sa extract-endpoints`（ast_url と jsluice）が動く
3. `--network none` のコンテナから外へ TCP で繋がらない
4. 内部ネットワークの `sa` から、プロキシを通さずには外へ繋がらない（許可先の `api.anthropic.com` と IP の `1.1.1.1` の両方）
5. プロキシが `api.anthropic.com:443` だけを通し、`example.com:443`・`api.anthropic.com:80` を 403 で拒否して記録する

外へ出られない場所で回すときは `SKIP_UPSTREAM=1`（5 の許可先への実際の接続を飛ばす）。

## 版を上げる

1. `sa/Dockerfile` の `ARG`（`CODEQL_VERSION` と `CODEQL_SHA256`、`JSLUICE_VERSION`、ベースイメージのタグとダイジェスト）を書き換える。
   CodeQL の sha256 はリリースの `codeql-bundle-linux64.tar.gz` から取る。
2. Semgrep は `semgrep==<版>` を入力にして作り直す:
   `uv pip compile --generate-hashes --python-version 3.11 --python-platform x86_64-unknown-linux-gnu --no-header -o docker/sa/semgrep-requirements.txt <入力>`
3. `docker/verify.sh` を通す。

## TLS を中継するプロキシの内側で build する

社内プロキシなどが TLS を中継する環境では、その CA を BuildKit の secret で渡す（イメージには残らない）:

```bash
docker build --secret id=build_ca,src=/path/to/proxy-ca.pem -f docker/sa/Dockerfile -t sa:local .
```

CodeQL バンドルを社内ミラーから取るときは `--build-arg CODEQL_URL=...`（中身は `CODEQL_SHA256` で検証する）。
