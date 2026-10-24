#!/usr/bin/env bash
# 実行環境の確認（docs/plan.md D4、design.md §9「隔離と外向き通信」）。CI（.github/workflows/docker.yml）で回す。
#   1. 固定した版のツールが入っている
#   2. ネットワーク無し（--network none）で、jsluice・Semgrep・CodeQL・sa が動く（パックや規則を取りに行かない）
#   3. --network none のコンテナから外へ出られない
#   4. 内部ネットワークの sa から、プロキシを通さずには外へ出られない（境界はネットワーク層）
#   5. プロキシは api.anthropic.com:443 だけを通し、ほかは拒否してログに残す
#
# 前提: docker compose -f docker/compose.yaml build 済み（sa:local と sa-egress-proxy:local）。
# 環境変数: SKIP_TOOLS=1 で 1・2 の解析ツールを飛ばす / SKIP_UPSTREAM=1 で許可先への実際の接続を飛ばす（外へ出られない場所で回すとき）
set -euo pipefail
cd "$(dirname "$0")/.."

SA_IMAGE=${SA_IMAGE:-sa:local}
COMPOSE=(docker compose --progress quiet -f docker/compose.yaml)
FIXTURE="$PWD/packages/core/test/fixtures/webpack5-basic/output"
WORK=$(mktemp -d)
chmod 0777 "$WORK"

ok() { printf 'ok   %s\n' "$*"; }
fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}
cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  # コンテナの利用者（node）が 0700 で作ったファイルは、こちらの利用者では消せないことがあるのでコンテナから消す
  docker run --rm --network none --user 0 -v "$WORK:/w" --entrypoint sh "$SA_IMAGE" -c 'rm -rf /w/* /w/.[!.]*' >/dev/null 2>&1 || true
  rm -rf "$WORK" || true
}
trap cleanup EXIT

offline() { docker run --rm --network none "$@"; }

# ---- 1・2. 版と、ネットワーク無しでの動作 ----
if [ "${SKIP_TOOLS:-0}" != 1 ]; then
  want_codeql=$(sed -n 's/^ARG CODEQL_VERSION=//p' docker/sa/Dockerfile | head -1)
  want_semgrep=$(sed -n 's/^semgrep==\([0-9.]*\).*/\1/p' docker/sa/semgrep-requirements.txt)
  want_jsluice=$(sed -n 's/^ARG JSLUICE_VERSION=//p' docker/sa/Dockerfile | head -1)

  got=$(offline --entrypoint codeql "$SA_IMAGE" version --format=terse)
  [ "$got" = "$want_codeql" ] || fail "codeql version $got (want $want_codeql)"
  ok "codeql $got"
  got=$(offline --entrypoint semgrep "$SA_IMAGE" --version)
  [ "$got" = "$want_semgrep" ] || fail "semgrep version $got (want $want_semgrep)"
  ok "semgrep $got"
  offline --entrypoint cat "$SA_IMAGE" /opt/sa/tools.json | grep -q "\"$want_jsluice\"" || fail "tools.json does not record jsluice $want_jsluice"
  ok "tools.json records the pinned versions"

  mkdir -p "$WORK/src"
  printf 'const name = location.hash.slice(1);\ndocument.body.innerHTML = "<b>" + name + "</b>";\nfetch("/api/v1/users?id=" + name);\n' >"$WORK/src/app.js"
  cat >"$WORK/rule.yml" <<'EOF'
rules:
  - id: inner-html
    languages: [javascript]
    severity: WARNING
    message: innerHTML assignment
    pattern: $X.innerHTML = $Y
EOF

  offline -v "$WORK:/w:ro" --entrypoint jsluice "$SA_IMAGE" urls /w/src/app.js | grep -q '"/api/v1/users?id=' ||
    fail "jsluice did not extract the endpoint"
  ok "jsluice runs offline"

  offline -v "$WORK:/w:ro" --entrypoint semgrep "$SA_IMAGE" scan --metrics=off --disable-version-check --quiet --json \
    --config /w/rule.yml /w/src/app.js | grep -q '"check_id": *"[^"]*inner-html"' || fail "semgrep did not report the rule"
  ok "semgrep runs offline with a local rule"

  # CodeQL: DB を作り、バンドル内のパックの js/xss を掛ける（パックを取りに行かない）
  offline -v "$WORK:/w" --entrypoint sh "$SA_IMAGE" -c '
    set -e
    CODEQL_EXTRACTOR_JAVASCRIPT_ALLOW_MINIFIED_FILES=true codeql database create /tmp/db --language=javascript \
      --source-root /w/src --ram=2048 --threads=2 --quiet
    codeql database analyze /tmp/db codeql/javascript-queries:Security/CWE-079/Xss.ql --ram=2048 --threads=2 \
      --format=sarif-latest --output=/w/xss.sarif --quiet
  '
  grep -q '"ruleId" *: *"js/xss"' "$WORK/xss.sarif" || fail "codeql js/xss found nothing in the sample"
  ok "codeql creates a database and runs the bundled js/xss query offline"

  sa_offline() { offline -e SA_HOME=/w/home -v "$WORK:/w" -v "$FIXTURE:/in:ro" "$SA_IMAGE" --json "$@"; }
  mkdir -p "$WORK/home" && chmod 0777 "$WORK/home"
  sa_offline target add smoke >/dev/null
  result=$(sa_offline load smoke /in/main.037dca38.js /in/main.037dca38.js.map /in/lazy.ce3f5b37.js /in/lazy.ce3f5b37.js.map \
    /in/949.d486fd40.js /in/949.d486fd40.js.map --collected-at now)
  echo "$result" | grep -q '"moduleCount": 4' || fail "sa load did not unpack 4 modules: $result"
  [ "$(echo "$result" | grep -c '"accepted": true')" -ge 3 ] || fail "sa load did not accept the 3 sourcemaps: $result"
  ok "sa loads, unpacks and imports sourcemaps offline"
fi

# ---- 3. --network none から外へ出られない ----
# 外への TCP 接続を試す。許可先（api.anthropic.com）の名前と、名前解決に頼らない IP（1.1.1.1）の両方。
# TLS まで見るとプロキシや中継の証明書の問題と区別できないので、TCP が繋がるかだけを見る
probe='const net = require("node:net");
const tryConnect = (host) => new Promise((resolve) => {
  const s = net.connect({ host, port: 443, timeout: 8000 });
  s.on("connect", () => { s.destroy(); resolve(host + " connected"); });
  s.on("timeout", () => { s.destroy(); resolve(null); });
  s.on("error", () => resolve(null));
});
Promise.all(["api.anthropic.com", "1.1.1.1"].map(tryConnect)).then((r) => {
  const reached = r.filter(Boolean);
  if (reached.length > 0) { console.log("REACHED " + reached.join(", ")); process.exit(1); }
  console.log("blocked");
});'
offline --entrypoint node "$SA_IMAGE" -e "$probe" | grep -q '^blocked$' || fail "a --network none container reached the internet"
ok "no egress with --network none"

# ---- 4・5. 内部ネットワーク＋egress プロキシ ----
"${COMPOSE[@]}" up -d --wait egress-proxy >/dev/null 2>&1 || "${COMPOSE[@]}" up -d egress-proxy >/dev/null
in_sa() { "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint node sa -e "$1" "${@:2}"; }

# 直接の TCP 接続はプロキシの環境変数と無関係 → 経路が無いので失敗するはず
in_sa "$probe" | grep -q '^blocked$' || fail "the sa container reached the internet without the proxy"
ok "no direct egress from the internal network"

connect='const http = require("node:http");
const req = http.request({ host: "egress-proxy", port: 3128, method: "CONNECT", path: process.argv[1], timeout: 15000 });
req.on("connect", (res, socket) => { console.log(res.statusCode); socket.destroy(); });
req.on("response", (res) => console.log(res.statusCode));
req.on("timeout", () => { console.log("timeout"); req.destroy(); });
req.on("error", (e) => console.log("error " + e.code));
req.end();'
for target in example.com:443 api.anthropic.com:80; do
  got=$(in_sa "$connect" "$target")
  [ "$got" = 403 ] || fail "proxy answered $got to CONNECT $target (want 403)"
  ok "proxy refuses CONNECT $target"
done
if [ "${SKIP_UPSTREAM:-0}" != 1 ]; then
  got=$(in_sa "$connect" api.anthropic.com:443)
  [ "$got" = 200 ] || fail "proxy answered $got to CONNECT api.anthropic.com:443 (want 200)"
  ok "proxy tunnels CONNECT api.anthropic.com:443"
fi

sleep 1
"${COMPOSE[@]}" logs egress-proxy 2>/dev/null | grep -q 'CONNECT example.com:443 403 TCP_DENIED' ||
  fail "the proxy log does not record the refused request"
ok "the proxy logs refused requests"

echo "all checks passed"
