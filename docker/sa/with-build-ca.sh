#!/bin/sh
# build 時だけ、TLS を中継するプロキシ（社内プロキシなど）の CA を信頼して取得する。
# CA は BuildKit の secret（id=build_ca）で渡すのでイメージには残らない。渡されなければ何もしないで実行する。
#   docker build --secret id=build_ca,src=/path/to/ca.pem ...
set -eu
if [ -s /run/secrets/build_ca ]; then
  bundle=$(mktemp)
  for f in /etc/ssl/certs/ca-certificates.crt /run/secrets/build_ca; do
    if [ -s "$f" ]; then cat "$f" >> "$bundle"; fi
  done
  export SSL_CERT_FILE="$bundle" CURL_CA_BUNDLE="$bundle" PIP_CERT="$bundle" REQUESTS_CA_BUNDLE="$bundle"
  export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca
fi
exec "$@"
