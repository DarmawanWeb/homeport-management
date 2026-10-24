# syntax=docker/dockerfile:1.7
#
# Homeport for Synology Container Manager, Docker on any Linux box, or a Raspberry Pi.
# One container holds Homeport, pm2, Caddy, cloudflared, Prometheus and node_exporter.
# Your apps are cloned into /apps and run under the same pm2.

ARG NODE_VERSION=22
ARG CADDY_VERSION=2.10.0
ARG CLOUDFLARED_VERSION=2026.5.0
ARG PROMETHEUS_VERSION=v3.5.0
ARG NODE_EXPORTER_VERSION=v1.9.1

FROM caddy:${CADDY_VERSION} AS caddy
FROM cloudflare/cloudflared:${CLOUDFLARED_VERSION} AS cloudflared
FROM prom/prometheus:${PROMETHEUS_VERSION} AS prometheus
FROM prom/node-exporter:${NODE_EXPORTER_VERSION} AS node-exporter

# ---------------------------------------------------------------- build
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json vite.config.ts ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim

# git to clone apps; python3/make/g++ so apps with native modules can build; tini as PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl tini python3 make g++ openssh-client \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pm2@7 --no-audit --no-fund \
 && corepack enable

COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
COPY --from=prometheus /bin/prometheus /bin/promtool /usr/local/bin/
COPY --from=node-exporter /bin/node_exporter /usr/local/bin/node_exporter

WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY ecosystem.config.cjs ./
COPY docker/entrypoint.sh /usr/local/bin/homeport-entrypoint

ENV HOMEPORT_DOCKER=1 \
    HOST=0.0.0.0 \
    PORT=7070 \
    TM_DATA_DIR=/data \
    HOMEPORT_APPS_DIR=/apps \
    HOMEPORT_CLOUDFLARED_DIR=/data/cloudflared \
    PM2_HOME=/data/pm2 \
    NODE_ENV=production

VOLUME ["/data", "/apps"]
EXPOSE 7070 8080 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/auth/status" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "homeport-entrypoint"]
