#!/usr/bin/env bash
# Homeport: install or update on macOS (Apple Silicon and Intel). Safe to run again.
#
#   bash setup-mac.sh                  # with Prometheus, Grafana and node_exporter
#   bash setup-mac.sh --no-monitoring  # without them
#   bash setup-mac.sh --local-only     # dashboard only on this Mac (default on first install: whole LAN,
#                                      # for a Mac mini without screen or keyboard)
#   bash setup-mac.sh --lan            # open the dashboard to the LAN again
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
LISTEN=""
for arg in "$@"; do
  case "$arg" in
    --no-monitoring) WITH_MONITORING=0 ;;
    --local-only) LISTEN=local ;;
    --lan) LISTEN=lan ;;
    *) y "Unknown option: $arg"; exit 1 ;;
  esac
done
DATA_DIR="${TM_DATA_DIR:-$PWD/data}"

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

# Where the dashboard listens. A choice made earlier (here or on the Access page) is kept unless
# a flag says otherwise; a first install opens it to the LAN so a headless Mac can be set up.
mkdir -p "$DATA_DIR"
if [[ -n "$LISTEN" || ! -f "$DATA_DIR/network.json" ]]; then
  printf '{\n  "listen": "%s"\n}\n' "${LISTEN:-lan}" >"$DATA_DIR/network.json"
fi
LISTEN=$(sed -n 's/.*"listen": *"\([a-z]*\)".*/\1/p' "$DATA_DIR/network.json")

g "▸ Starting Homeport ($([[ $LISTEN == lan ]] && echo 'reachable on your network' || echo 'this Mac only'))"
mkdir -p "$HOME/apps"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo
# Without root, pm2 prints the sudo command and exits non-zero; show just that command.
out=$(pm2 startup launchd 2>&1 || true)
if line=$(grep -E '^sudo' <<<"$out"); then
  g "▸ Start on boot: run this once"
  echo "  $line"
else
  g "▸ Start on boot"
  tail -3 <<<"$out"
fi

echo
y "Recommended for a Mac used as a server (needs sudo):"
echo "  sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1"
echo "  and turn on automatic login for this user, so pm2 starts after a power cut"
echo
PORT_NO=7070
URLS=("http://127.0.0.1:$PORT_NO")
if [[ $LISTEN == lan ]]; then
  URLS=()
  NAME=$(scutil --get LocalHostName 2>/dev/null || true)
  [[ -n "$NAME" ]] && URLS+=("http://$(tr '[:upper:]' '[:lower:]' <<<"$NAME").local:$PORT_NO")
  for ifc in en0 en1 en2; do
    ip=$(ipconfig getifaddr "$ifc" 2>/dev/null || true)
    [[ -n "$ip" ]] && URLS+=("http://$ip:$PORT_NO")
  done
  FW=/usr/libexec/ApplicationFirewall/socketfilterfw
  if [[ -x $FW ]] && "$FW" --getglobalstate 2>/dev/null | grep -q enabled; then
    NODE_BIN=$(command -v node)
    echo
    y "The macOS firewall is on. Allow Node once so other devices can connect (needs sudo):"
    echo "  sudo $FW --add $NODE_BIN && sudo $FW --unblockapp $NODE_BIN"
  fi
fi

CODE_FILE="$DATA_DIR/setup-code"
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -f "$CODE_FILE" || -f "$DATA_DIR/auth.json" ]] && break; sleep 1; done

echo
if [[ $LISTEN == lan ]]; then g "✓ Done. Open Homeport from any device on your network:"; else g "✓ Done. Open Homeport on this Mac:"; fi
for u in "${URLS[@]}"; do echo "    $u"; done
if [[ -f "$CODE_FILE" ]]; then
  echo
  echo "  First visit: set a dashboard password. From another device, enter this setup code:"
  echo "    $(cat "$CODE_FILE")"
fi
[[ $LISTEN == lan ]] || echo "  (this Mac only; run with --lan to open it to your network)"

