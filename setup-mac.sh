#!/usr/bin/env bash
# Homeport — setup / update untuk macOS (Apple Silicon & Intel). Aman dijalankan berulang kali.
set -euo pipefail
cd "$(dirname "$0")"

g() { printf "\033[32m%s\033[0m\n" "$*"; }
y() { printf "\033[33m%s\033[0m\n" "$*"; }

if ! command -v brew >/dev/null 2>&1; then
  y "Homebrew belum terpasang. Install dulu:"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi

WITH_MONITORING=1
[[ "${1:-}" == "--no-monitoring" ]] && WITH_MONITORING=0

PKGS=(node git caddy cloudflared)
(( WITH_MONITORING )) && PKGS+=(prometheus grafana node_exporter)

g "▸ Paket Homebrew: ${PKGS[*]}"
for pkg in "${PKGS[@]}"; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then echo "  ✓ $pkg"; else brew install "$pkg"; fi
done

# Homeport menjalankan semua layanan ini sendiri via pm2 — matikan versi brew services supaya port tidak bentrok.
for svc in caddy grafana prometheus node_exporter; do
  if brew services list 2>/dev/null | grep -qE "^${svc}\s+started"; then
    y "▸ Menghentikan 'brew services ${svc}' (dikelola Homeport)"
    brew services stop "$svc"
  fi
done

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if (( NODE_MAJOR < 20 )); then y "Node $NODE_MAJOR terlalu lama, butuh ≥ 20: brew upgrade node"; exit 1; fi

g "▸ pm2, pnpm/yarn (corepack), pm2-logrotate"
command -v pm2 >/dev/null 2>&1 || npm install -g pm2
corepack enable >/dev/null 2>&1 || true
if ! pm2 ls 2>/dev/null | grep -q pm2-logrotate; then
  pm2 install pm2-logrotate >/dev/null
  pm2 set pm2-logrotate:max_size 10M >/dev/null
  pm2 set pm2-logrotate:retain 7 >/dev/null
fi

g "▸ Build Homeport"
npm ci --no-audit --no-fund
npm run build

g "▸ Menjalankan Homeport"
mkdir -p "$HOME/apps"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo
g "▸ Auto-start setelah reboot — jalankan perintah ini sekali (butuh sudo):"
pm2 startup launchd 2>/dev/null | grep -E '^sudo' || pm2 startup

echo
y "Disarankan untuk Mac mini sebagai server (butuh sudo):"
echo "  sudo pmset -a sleep 0 disksleep 0   # jangan tidur"
echo "  sudo pmset -a autorestart 1         # nyala lagi setelah listrik padam"
echo "  sudo pmset -a womp 1                # wake on network"
echo
g "✓ Selesai — buka http://127.0.0.1:7070"
open "http://127.0.0.1:7070" 2>/dev/null || true
