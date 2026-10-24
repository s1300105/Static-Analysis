# syntax=docker/dockerfile:1
# sa の egress プロキシ（squid）。許可先は squid.conf（api.anthropic.com:443 への CONNECT だけ）。
ARG DEBIAN_IMAGE=debian:12.15-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
FROM ${DEBIAN_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends squid && rm -rf /var/lib/apt/lists/*
COPY docker/egress-proxy/squid.conf /etc/squid/squid.conf
RUN squid -k parse -f /etc/squid/squid.conf
EXPOSE 3128
# root を持たずに動かす（キャッシュ・pid ファイル無し、ログは標準出力）
USER proxy
ENTRYPOINT ["squid", "-N", "-f", "/etc/squid/squid.conf"]
