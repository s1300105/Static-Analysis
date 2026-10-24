# syntax=docker/dockerfile:1
#
# sa の実行イメージ（docs/plan.md D4、design.md §9「隔離と外向き通信」）。
# 解析ツール（CodeQL・Semgrep・jsluice）とベースイメージの版はここで固定する。実行時は何も取りに行かない。
# 対応は linux/amd64 だけ（CodeQL バンドルが linux64 のみ）。
#
#   docker compose -f docker/compose.yaml build        # sa:local と sa-egress-proxy:local
#   docker/verify.sh                                    # 版・オフライン動作・外向き通信の制限を確かめる
#
# 版を上げるときは、この ARG と docker/sa/semgrep-requirements.txt を更新して docker/verify.sh を通す（docker/README.md）。

ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94
ARG GO_IMAGE=golang:1.25.14-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437

# ---- CodeQL: CLI と標準クエリパックを含むバンドル（パックを実行時に取得しない）。sha256 で検証する ----
# 取得には curl と CA 証明書を持つ Go のイメージを使う
FROM ${GO_IMAGE} AS codeql
ARG CODEQL_VERSION=2.27.3
ARG CODEQL_SHA256=64518dc413c8e7b5733fee2489e830a899bb1e3f28c8873b5869d5cc90164c5c
# 社内ミラーなどから取るときに差し替える（中身は CODEQL_SHA256 で検証する）
ARG CODEQL_URL=https://github.com/github/codeql-action/releases/download/codeql-bundle-v${CODEQL_VERSION}/codeql-bundle-linux64.tar.gz
COPY --chmod=0755 docker/sa/with-build-ca.sh /usr/local/bin/with-build-ca
RUN --mount=type=secret,id=build_ca \
    with-build-ca curl -fsSL --retry 3 -o /tmp/codeql.tar.gz "${CODEQL_URL}" \
 && echo "${CODEQL_SHA256}  /tmp/codeql.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/codeql.tar.gz -C /opt \
 && rm /tmp/codeql.tar.gz \
 && test "$(/opt/codeql/codeql version --format=terse)" = "${CODEQL_VERSION}"

# ---- jsluice: Go のモジュール版で固定し、sum.golang.org で中身を検証する。go-tree-sitter を使うので cgo ----
FROM ${GO_IMAGE} AS jsluice
ARG JSLUICE_VERSION=v0.0.0-20240110145140-0ddfab153e06
COPY --chmod=0755 docker/sa/with-build-ca.sh /usr/local/bin/with-build-ca
RUN --mount=type=secret,id=build_ca \
    with-build-ca env CGO_ENABLED=1 GOBIN=/out GOFLAGS=-trimpath \
      go install "github.com/BishopFox/jsluice/cmd/jsluice@${JSLUICE_VERSION}"

# ---- Semgrep: ハッシュ付きで固定した依存だけを入れる（uv pip compile --generate-hashes の出力） ----
FROM ${NODE_IMAGE} AS semgrep
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 docker/sa/with-build-ca.sh /usr/local/bin/with-build-ca
COPY docker/sa/semgrep-requirements.txt /tmp/semgrep-requirements.txt
RUN --mount=type=secret,id=build_ca \
    python3 -m venv /opt/semgrep \
 && with-build-ca /opt/semgrep/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps \
      -r /tmp/semgrep-requirements.txt

# ---- sa 本体: ビルドしてから本番の依存だけを残す（better-sqlite3 は配布済みのバイナリを使う） ----
FROM ${NODE_IMAGE} AS app
COPY --chmod=0755 docker/sa/with-build-ca.sh /usr/local/bin/with-build-ca
RUN --mount=type=secret,id=build_ca with-build-ca npm install -g --ignore-scripts pnpm@10.28.0
WORKDIR /src
COPY . .
# pnpm deploy: @sa/cli と本番の依存だけを /opt/sa に置く（ワークスペースの @sa/core・@sa/types は dist ごと複製される）
RUN --mount=type=secret,id=build_ca \
    with-build-ca pnpm install --frozen-lockfile \
 && pnpm build \
 && with-build-ca pnpm --filter @sa/cli deploy --prod --legacy /opt/sa \
 && chmod 0755 /opt/sa/dist/cli.js

# ---- 実行イメージ ----
FROM ${NODE_IMAGE} AS runtime
ARG CODEQL_VERSION=2.27.3
ARG JSLUICE_VERSION=v0.0.0-20240110145140-0ddfab153e06
# Semgrep の venv は Debian の python3 を指す。Semgrep のコア（OCaml）は通信しないときも起動時に CA の束を読むので
# ca-certificates も入れる（コンテナはネットワークを持たないので、これで外へ出られるようにはならない）
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=codeql /opt/codeql /opt/codeql
COPY --from=jsluice /out/jsluice /usr/local/bin/jsluice
COPY --from=semgrep /opt/semgrep /opt/semgrep
COPY --from=app /opt/sa /opt/sa
RUN ln -s /opt/sa/dist/cli.js /usr/local/bin/sa \
 && ln -s /opt/codeql/codeql /usr/local/bin/codeql \
 && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep
# 解析ツールは外へ出ない設定で動かす（境界はネットワーク層。これは多重防御の一層）
ENV SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    SA_HOME=/data
# ツールの場所と版（analysis_run.tool_version の出所。設定に取り込むのは各ツールを使う PR）
RUN SEMGREP_VERSION="$(semgrep --version)" \
 && printf '{\n  "codeql": { "path": "/opt/codeql/codeql", "version": "%s" },\n  "semgrep": { "path": "/opt/semgrep/bin/semgrep", "version": "%s" },\n  "jsluice": { "path": "/usr/local/bin/jsluice", "version": "%s" },\n  "node": { "version": "%s" }\n}\n' \
      "${CODEQL_VERSION}" "${SEMGREP_VERSION}" "${JSLUICE_VERSION}" "$(node --version)" > /opt/sa/tools.json \
 && mkdir -p /data /work && chown node:node /data /work
LABEL org.opencontainers.image.title="sa" \
      org.opencontainers.image.description="Static analysis for JS bundles (no target traffic)" \
      org.opencontainers.image.source="https://github.com/s1300105/Static-Analysis"
USER node
WORKDIR /work
VOLUME /data
ENTRYPOINT ["sa"]
CMD ["--help"]
