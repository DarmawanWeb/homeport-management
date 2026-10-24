#!/bin/sh
# Container entrypoint: restore everything pm2 was running (Homeport, Caddy, tunnels, apps),
# make sure Homeport itself is up, then stream logs to the container log.
set -eu

mkdir -p "$TM_DATA_DIR" "$HOMEPORT_APPS_DIR" "$HOMEPORT_CLOUDFLARED_DIR" "$PM2_HOME"
# cloudflared looks in ~/.cloudflared for cert.pem; keep it on the data volume.
[ -e /root/.cloudflared ] || ln -s "$HOMEPORT_CLOUDFLARED_DIR" /root/.cloudflared

# Stale pid and socket files from the previous container would confuse the new daemon.
rm -f "$PM2_HOME"/*.pid "$PM2_HOME"/rpc.sock "$PM2_HOME"/pub.sock

cd /app
pm2 resurrect >/dev/null 2>&1 || true
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save --force >/dev/null

stop() {
  pm2 save --force >/dev/null 2>&1 || true
  pm2 kill >/dev/null 2>&1 || true
  exit 0
}
trap stop TERM INT

# The container log shows Homeport's output, including the first-run setup code.
pm2 logs --raw --lines 50 &

# Exit (and let Docker restart the container) if the pm2 daemon goes away.
while sleep 30 & wait $!; do
  pm2 ping >/dev/null 2>&1 || exit 1
done
