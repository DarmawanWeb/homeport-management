#!/usr/bin/env bash
# Homeport: install or update on Linux, including Synology DSM 7 and Raspberry Pi. Safe to run again.
# No root needed: tools go to ~/.homeport/bin, pm2 to ~/.local.
#
#   bash setup-linux.sh                    # everything, with Prometheus and node_exporter
#   bash setup-linux.sh --with-grafana     # also Grafana (about 400 MB)
#   bash setup-linux.sh --no-monitoring    # without Prometheus and node_exporter
#   bash setup-linux.sh --local-only       # dashboard on 127.0.0.1 only (default: reachable on the LAN)
#   bash setup-linux.sh --only caddy       # just install or update one tool: caddy, cloudflared,
#                                          # prometheus, node_exporter, grafana
set -euo pipefail
cd "$(dirname "$0")"

CADDY_VERSION="${CADDY_VERSION:-2.10.0}"
CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.5.0}"
PROMETHEUS_VERSION="${PROMETHEUS_VERSION:-3.5.0}"
NODE_EXPORTER_VERSION="${NODE_EXPORTER_VERSION:-1.9.1}"
GRAFANA_VERSION="${GRAFANA_VERSION:-12.0.0}"

HP_HOME="${HOMEPORT_HOME:-$HOME/.homeport}"
BIN="${HOMEPORT_BIN:-$HP_HOME/bin}"
NPM_PREFIX="$HOME/.local"

g() { printf "\033[32m%s\033[0m\n" "$*"; }
y() { printf "\033[33m%s\033[0m\n" "$*"; }
die() { printf "\033[31m%s\033[0m\n" "$*" >&2; exit 1; }

WITH_MONITORING=1
WITH_GRAFANA=0
HOST_ADDR=0.0.0.0
ONLY=""
while (($#)); do
  case "$1" in
    --no-monitoring) WITH_MONITORING=0 ;;
    --with-grafana) WITH_GRAFANA=1 ;;
    --local-only) HOST_ADDR=127.0.0.1 ;;
    --only) ONLY="${2:-}"; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Linux" ]] || die "This installer is for Linux. On a Mac use setup-mac.sh."

SYNOLOGY=0
[[ -f /etc/synoinfo.conf || -f /etc.defaults/synoinfo.conf ]] && SYNOLOGY=1

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64; CF_ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64; CF_ARCH=arm64 ;;
  armv7l|armv7) ARCH=armv7; CF_ARCH=arm ;;
  *) die "Unsupported CPU: $(uname -m). Homeport needs x86_64, arm64 or armv7." ;;
esac

mkdir -p "$BIN"
export PATH="$BIN:$NPM_PREFIX/bin:/usr/local/bin:$PATH"

fetch() { # url dest
  curl -fL --retry 3 --connect-timeout 15 -o "$2" "$1" || die "Download failed: $1"
}

# verify <file> <sums-url> <name-in-sums> <sha256|sha512>
verify() {
  command -v "${4}sum" >/dev/null 2>&1 || { y "  (${4}sum not available, skipped verification)"; return 0; }
  local sums
  sums=$(curl -fsSL --retry 3 "$2") || { y "  (no checksum file, skipped verification)"; return 0; }
  local want
  want=$(printf '%s\n' "$sums" | awk -v f="$3" '$2 == f || $2 == "*"f {print $1}')
  [[ -n "$want" ]] || { y "  (no checksum for $3, skipped verification)"; return 0; }
  local have
  have=$("${4}sum" "$1" | awk '{print $1}')
  [[ "$have" == "$want" ]] || die "Checksum mismatch for $3"
  echo "  ✓ checksum"
}

installed_version() { # bin
  "$BIN/$1" --version 2>/dev/null | head -1 || true
}

install_caddy() {
  if installed_version caddy | grep -q "v$CADDY_VERSION"; then echo "  ✓ caddy $CADDY_VERSION"; return; fi
  local t f="caddy_${CADDY_VERSION}_linux_${ARCH}.tar.gz"
  t=$(mktemp -d)
  echo "  ↓ caddy $CADDY_VERSION"
  fetch "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$f" "$t/$f"
  verify "$t/$f" "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_checksums.txt" "$f" sha512
  tar -xzf "$t/$f" -C "$t" caddy
  install -m 755 "$t/caddy" "$BIN/caddy"
  rm -rf "$t"
}

install_cloudflared() {
  if installed_version cloudflared | grep -q "$CLOUDFLARED_VERSION"; then echo "  ✓ cloudflared $CLOUDFLARED_VERSION"; return; fi
  echo "  ↓ cloudflared $CLOUDFLARED_VERSION"
  fetch "https://github.com/cloudflare/cloudflared/releases/download/$CLOUDFLARED_VERSION/cloudflared-linux-$CF_ARCH" "$BIN/cloudflared.tmp"
  chmod 755 "$BIN/cloudflared.tmp"
  mv "$BIN/cloudflared.tmp" "$BIN/cloudflared"
}

install_prom_tool() { # name version (prometheus | node_exporter)
  local name=$1 v=$2
  if installed_version "$name" | grep -q "version $v"; then echo "  ✓ $name $v"; return; fi
  local t dir="$name-$v.linux-$ARCH" f="$name-$v.linux-$ARCH.tar.gz"
  t=$(mktemp -d)
  echo "  ↓ $name $v"
  fetch "https://github.com/prometheus/$name/releases/download/v$v/$f" "$t/$f"
  verify "$t/$f" "https://github.com/prometheus/$name/releases/download/v$v/sha256sums.txt" "$f" sha256
  tar -xzf "$t/$f" -C "$t"
  install -m 755 "$t/$dir/$name" "$BIN/$name"
  [[ -f "$t/$dir/promtool" ]] && install -m 755 "$t/$dir/promtool" "$BIN/promtool"
  rm -rf "$t"
}

install_grafana() {
  local dest="$HP_HOME/grafana"
  if [[ -f "$dest/VERSION" ]] && grep -qx "$GRAFANA_VERSION" "$dest/VERSION"; then echo "  ✓ grafana $GRAFANA_VERSION"; return; fi
  local t f="grafana-$GRAFANA_VERSION.linux-$ARCH.tar.gz"
  t=$(mktemp -d)
  echo "  ↓ grafana $GRAFANA_VERSION (large download)"
  fetch "https://dl.grafana.com/oss/release/$f" "$t/$f"
  rm -rf "$dest"
  mkdir -p "$dest"
  tar -xzf "$t/$f" -C "$dest" --strip-components=1
  echo "$GRAFANA_VERSION" >"$dest/VERSION"
  ln -sf "$dest/bin/grafana" "$BIN/grafana"
  rm -rf "$t"
}

install_one() {
  case "$1" in
    caddy) install_caddy ;;
    cloudflared) install_cloudflared ;;
    prometheus) install_prom_tool prometheus "$PROMETHEUS_VERSION" ;;
    node_exporter|nodeExporter) install_prom_tool node_exporter "$NODE_EXPORTER_VERSION" ;;
    grafana) install_grafana ;;
    *) die "Unknown tool: $1" ;;
  esac
}

if [[ -n "$ONLY" ]]; then
  g "▸ Installing $ONLY into $BIN"
  install_one "$ONLY"
  g "✓ Done. Homeport finds it automatically; refresh the dashboard."
  exit 0
fi

# ---------------------------------------------------------------- prerequisites

g "▸ Checking prerequisites$( ((SYNOLOGY)) && echo ' (Synology DSM)')"
if ! command -v node >/dev/null 2>&1; then
  if ((SYNOLOGY)); then die "Node.js is missing. Install \"Node.js v20\" (or newer) from Package Center, then run this again."; fi
  die "Node.js 20 or newer is missing. Install it from your distribution or https://nodejs.org, then run this again."
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
((NODE_MAJOR >= 20)) || die "Node $NODE_MAJOR is too old; Homeport needs 20 or newer."
echo "  ✓ node $(node -v)"
if ! command -v git >/dev/null 2>&1; then
  if ((SYNOLOGY)); then die "git is missing. Install \"Git Server\" from Package Center, then run this again."; fi
  die "git is missing. Install it (for example: sudo apt install git), then run this again."
fi
echo "  ✓ $(git --version)"
[[ -w "$HOME" ]] || die "Your home folder $HOME is not writable. On Synology: Control Panel → User & Group → Advanced → Enable user home service."

# ---------------------------------------------------------------- tools

g "▸ Tools for $ARCH into $BIN"
install_caddy
install_cloudflared
if ((WITH_MONITORING)); then
  install_prom_tool prometheus "$PROMETHEUS_VERSION"
  install_prom_tool node_exporter "$NODE_EXPORTER_VERSION"
fi
((WITH_GRAFANA)) && install_grafana

g "▸ pm2"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g --prefix "$NPM_PREFIX" pm2 --no-audit --no-fund
fi
echo "  ✓ pm2 $(pm2 --version 2>/dev/null | tail -1)"
command -v corepack >/dev/null 2>&1 && { corepack enable --install-directory "$NPM_PREFIX/bin" >/dev/null 2>&1 || true; }
if ! pm2 ls 2>/dev/null | grep -q pm2-logrotate; then
  pm2 install pm2-logrotate >/dev/null
  pm2 set pm2-logrotate:max_size 10M >/dev/null
  pm2 set pm2-logrotate:retain 7 >/dev/null
fi

# ---------------------------------------------------------------- Homeport

g "▸ Building Homeport"
npm ci --no-audit --no-fund
npm run build

g "▸ Starting Homeport on $HOST_ADDR:7070"
mkdir -p "$HOME/apps"
HOST="$HOST_ADDR" HOMEPORT_BIN="$BIN" PATH="$PATH" pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save --force >/dev/null

# ---------------------------------------------------------------- start on boot

echo
PM2_BIN=$(command -v pm2)
if ((SYNOLOGY)); then
  g "▸ Start on boot (one time, in DSM)"
  echo "  Control Panel → Task Scheduler → Create → Triggered Task → User-defined script"
  echo "    User:  $(id -un)        Event: Boot-up"
  echo "    Script:"
  echo "      export HOME=$HOME PATH=$BIN:$NPM_PREFIX/bin:/usr/local/bin:\$PATH"
  echo "      $PM2_BIN resurrect"
elif command -v systemctl >/dev/null 2>&1; then
  g "▸ Start on boot: run this once (needs sudo)"
  pm2 startup systemd -u "$(id -un)" --hp "$HOME" 2>/dev/null | grep -E '^sudo' || pm2 startup
else
  y "▸ No systemd found. Add \"$PM2_BIN resurrect\" to your system's startup scripts."
fi

echo
ADDR=127.0.0.1
[[ "$HOST_ADDR" == "0.0.0.0" ]] && ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
ADDR=${ADDR:-$(hostname)}
CODE_FILE="$(pwd)/data/setup-code"
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -f "$CODE_FILE" ]] && break; sleep 1; done
g "✓ Done. Open http://$ADDR:7070"
if [[ -f "$CODE_FILE" ]]; then
  echo "  Setup code for the first password: $(cat "$CODE_FILE")"
fi
