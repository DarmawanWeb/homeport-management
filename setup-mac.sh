#!/usr/bin/env bash
# Homeport: install or update on macOS (Apple Silicon and Intel). Safe to run again.
#
#   bash setup-mac.sh                  # with Prometheus, Grafana and node_exporter
#   bash setup-mac.sh --no-monitoring  # without them
set -euo pipefail
cd "$(dirname "$0")"

g() { printf "\033[32m%s\033[0m\n" "$*"; }
y() { printf "\033[33m%s\033[0m\n" "$*"; }

if ! command -v brew >/dev/null 2>&1; then
  y "Homebrew is not installed. Install it first:"
  echo '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
  exit 1
fi

WITH_MONITORING=1
[[ "${1:-}" == "--no-monitoring" ]] && WITH_MONITORING=0

PKGS=(git caddy cloudflared)
command -v node >/dev/null 2>&1 || PKGS=(node "${PKGS[@]}")
(( WITH_MONITORING )) && PKGS+=(prometheus grafana node_exporter)

g "▸ Homebrew packages: ${PKGS[*]}"
for pkg in "${PKGS[@]}"; do
  if brew list --formula "$pkg" >/dev/null 2>&1; then echo "  ✓ $pkg"; else brew install "$pkg"; fi
done

# Homeport runs these under pm2 itself; Homebrew service copies would fight over the same ports.
for svc in caddy cloudflared grafana prometheus node_exporter; do
  if brew services list 2>/dev/null | grep -qE "^${svc}\s+started"; then
    y "▸ Stopping 'brew services ${svc}' (Homeport manages it)"
    brew services stop "$svc"
  fi
done

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if (( NODE_MAJOR < 20 )); then y "Node $NODE_MAJOR is too old; Homeport needs 20 or newer (brew upgrade node)."; exit 1; fi

g "▸ pm2, corepack (pnpm and yarn), pm2-logrotate"
command -v pm2 >/dev/null 2>&1 || npm install -g pm2
corepack enable >/dev/null 2>&1 || true
if ! pm2 ls 2>/dev/null | grep -q pm2-logrotate; then
  pm2 install pm2-logrotate >/dev/null
  pm2 set pm2-logrotate:max_size 10M >/dev/null
  pm2 set pm2-logrotate:retain 7 >/dev/null
fi

g "▸ Building Homeport"
npm ci --no-audit --no-fund
npm run build

g "▸ Starting Homeport"
mkdir -p "$HOME/apps"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo
g "▸ Start on boot: run this once (needs sudo)"
pm2 startup launchd 2>/dev/null | grep -E '^sudo' || pm2 startup

echo
y "Recommended for a Mac used as a server (needs sudo):"
echo "  sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1"
echo "  and turn on automatic login for this user, so pm2 starts after a power cut"
echo
g "✓ Done. Open http://127.0.0.1:7070 on this Mac and set a dashboard password."
open "http://127.0.0.1:7070" 2>/dev/null || true
