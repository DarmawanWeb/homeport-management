#!/usr/bin/env bash
# Remove a hand-made Caddy and Cloudflare Tunnel setup so Homeport can start clean.
#
#   bash reset-mac.sh             # ask before every step (recommended)
#   bash reset-mac.sh --dry-run   # only list what was found; change nothing
#   bash reset-mac.sh --yes       # do everything without asking (except cert.pem)
#
# Optional: CF_API_TOKEN=xxx bash reset-mac.sh also deletes CNAME records of deleted tunnels.
#   (Cloudflare token with Zone:DNS:Edit and Zone:Zone:Read)
#
# Never touched: the Homebrew packages themselves, your apps' pm2 processes,
# ~/apps, and the cloudflared login (cert.pem) unless you choose to remove it.
# Works with the bash 3.2 that ships with macOS.

set -uo pipefail

DRY=0; YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a"; exit 1 ;;
  esac
done

b() { printf "\n\033[1m%s\033[0m\n" "$*"; }
g() { printf "\033[32m  ✓ %s\033[0m\n" "$*"; }
y() { printf "\033[33m  • %s\033[0m\n" "$*"; }
r() { printf "\033[31m  ✖ %s\033[0m\n" "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

ask() { # ask "pertanyaan" [default:n]
  if (( DRY )); then return 1; fi
  if (( YES )); then return 0; fi
  local ans
  read -r -p "  → $1 [y/N] " ans </dev/tty || return 1
  case "$ans" in y|Y|ya|yes) return 0 ;; *) return 1 ;; esac
}
run() { # run cmd...  (prints, honours dry-run)
  if (( DRY )); then y "(dry-run) $*"; return 0; fi
  "$@"
}

export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:$PATH"
CF_DIR="$HOME/.cloudflared"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$HOME/homeport-reset-backup-$STAMP.tgz"
DONE=()

(( DRY )) && printf "\033[33mDRY RUN: nothing will be changed.\033[0m\n"

# ======================================================================== 1. inventaris
b "1/6  Looking for an existing setup"

BREW_SVCS=""
if have brew; then
  BREW_SVCS=$(brew services list 2>/dev/null | awk 'NR>1 && ($1=="caddy" || $1=="cloudflared") && $2!="none" {print $1" ("$2")"}')
fi
[[ -n "$BREW_SVCS" ]] && y "brew services: $(echo $BREW_SVCS)" || g "no caddy or cloudflared brew services"

PLISTS=()
for p in /Library/LaunchDaemons/com.cloudflare.cloudflared.plist \
         "$HOME/Library/LaunchAgents/com.cloudflare.cloudflared.plist" \
         /Library/LaunchDaemons/com.caddyserver.caddy.plist \
         "$HOME/Library/LaunchAgents/com.caddyserver.caddy.plist"; do
  [[ -f "$p" ]] && PLISTS+=("$p")
done
(( ${#PLISTS[@]} )) && for p in "${PLISTS[@]}"; do y "launchd service: $p"; done || g "no cloudflared or caddy launchd services"

PM2_LIST=""
if have pm2; then
  # pm2 processes running caddy, cloudflared, prometheus or grafana, or left by older versions of this tool.
  PM2_LIST=$(pm2 jlist 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let a=[];try{a=JSON.parse(s.slice(s.indexOf("[")))}catch{}
      const re=/(^|\/)(caddy|cloudflared|prometheus|grafana(-server)?|node_exporter)$/;
      for(const p of a){
        const exe=String(p.pm2_env&&p.pm2_env.pm_exec_path||"");
        if(re.test(exe)||/^(tm-|hp-)/.test(p.name)) console.log(p.name);
      }
    })' 2>/dev/null)
fi
[[ -n "$PM2_LIST" ]] && y "pm2 processes: $(echo $PM2_LIST)" || g "no caddy or cloudflared pm2 processes"

PROCS=$(pgrep -lx 'caddy|cloudflared' 2>/dev/null || true)
[[ -n "$PROCS" ]] && y "running processes: $(echo "$PROCS" | awk '{print $2"["$1"]"}' | tr '\n' ' ')" || g "no caddy or cloudflared processes running"

TUNNEL_IDS=(); TUNNEL_NAMES=()
if have cloudflared && [[ -f "$CF_DIR/cert.pem" ]]; then
  TJSON=$(cloudflared tunnel list --output json 2>/dev/null || echo "[]")
  while IFS=$'\t' read -r id name conns; do
    [[ -z "$id" ]] && continue
    TUNNEL_IDS+=("$id"); TUNNEL_NAMES+=("$name")
    y "tunnel on Cloudflare: $name ($id, $conns active connections)"
  done < <(echo "$TJSON" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let a=[];try{a=JSON.parse(s)||[]}catch{}
      for(const t of a) console.log([t.id,t.name,(t.connections||[]).length].join("\t"));
    })')
  (( ${#TUNNEL_IDS[@]} )) || g "no tunnels on this Cloudflare account"
elif have cloudflared; then
  y "cloudflared is not signed in (no cert.pem), so tunnels on Cloudflare cannot be listed"
fi

FILES=()
for f in "$CF_DIR"/config.yml "$CF_DIR"/config.yaml "$CF_DIR"/*.json \
         /etc/cloudflared /usr/local/etc/cloudflared /opt/homebrew/etc/cloudflared \
         /opt/homebrew/etc/Caddyfile /usr/local/etc/Caddyfile /etc/caddy \
         "$HOME/Library/Application Support/Caddy" "$HOME/.config/caddy" "$HOME/.local/share/caddy" \
         "$HOME/tunnel-manager/data" "$HOME/homeport/data"; do
  [[ -e "$f" ]] && FILES+=("$f")
done
(( ${#FILES[@]} )) && for f in "${FILES[@]}"; do y "file/folder: $f"; done || g "no old config files"

if [[ -z "$BREW_SVCS$PM2_LIST$PROCS" ]] && (( ${#PLISTS[@]} == 0 && ${#TUNNEL_IDS[@]} == 0 && ${#FILES[@]} == 0 )); then
  b "Nothing to remove. This Mac is clean ✓"; exit 0
fi
(( DRY )) && { b "Dry run finished. Run without --dry-run to remove these."; exit 0; }

# ======================================================================== 2. hentikan service
b "2/6  Stopping caddy and cloudflared services"
if [[ -n "$BREW_SVCS" ]] && ask "Stop the caddy and cloudflared brew services?"; then
  for s in caddy cloudflared; do brew services stop "$s" >/dev/null 2>&1 && g "brew services stop $s"; done
  DONE+=("brew services stopped")
fi
for p in ${PLISTS[@]+"${PLISTS[@]}"}; do
  if ask "Remove launchd service $(basename "$p")?"; then
    case "$p" in
      *cloudflared*)
        if [[ "$p" == /Library/* ]]; then sudo cloudflared service uninstall 2>/dev/null || { sudo launchctl bootout system "$p" 2>/dev/null; sudo rm -f "$p"; }
        else cloudflared service uninstall 2>/dev/null || { launchctl bootout "gui/$(id -u)" "$p" 2>/dev/null; rm -f "$p"; }; fi ;;
      *)
        if [[ "$p" == /Library/* ]]; then sudo launchctl bootout system "$p" 2>/dev/null; sudo rm -f "$p"
        else launchctl bootout "gui/$(id -u)" "$p" 2>/dev/null; rm -f "$p"; fi ;;
    esac
    [[ -f "$p" ]] && r "still there: $p" || { g "removed: $p"; DONE+=("launchd $(basename "$p")"); }
  fi
done

# ======================================================================== 3. pm2
b "3/6  pm2 processes"
if [[ -n "$PM2_LIST" ]] && ask "Delete pm2 processes: $(echo $PM2_LIST)?"; then
  for n in $PM2_LIST; do pm2 delete "$n" >/dev/null 2>&1 && g "pm2 delete $n"; done
  pm2 save >/dev/null 2>&1
  DONE+=("old pm2 processes")
else g "skipped"; fi

# ======================================================================== 4. proses sisa
b "4/6  Processes still running"
PROCS=$(pgrep -lx 'caddy|cloudflared' 2>/dev/null || true)
if [[ -n "$PROCS" ]]; then
  y "$(echo "$PROCS" | awk '{print $2"["$1"]"}' | tr '\n' ' ')"
  if ask "Stop these caddy and cloudflared processes?"; then
    have caddy && caddy stop >/dev/null 2>&1
    pkill -x cloudflared 2>/dev/null; pkill -x caddy 2>/dev/null; sleep 2
    pkill -9 -x cloudflared 2>/dev/null; pkill -9 -x caddy 2>/dev/null
    REMAIN=$(pgrep -lx 'caddy|cloudflared' 2>/dev/null || true)
    if [[ -n "$REMAIN" ]]; then r "still running (perhaps owned by root): $(echo $REMAIN). Try: sudo pkill -x cloudflared; sudo pkill -x caddy"
    else g "all stopped"; DONE+=("processes stopped"); fi
  fi
else g "none"; fi

# ======================================================================== 5. tunnel di Cloudflare
b "5/6  Tunnels on your Cloudflare account"
DELETED_IDS=()
if (( ${#TUNNEL_IDS[@]} )); then
  echo "  Deleting a tunnel cannot be undone. Its domains stay down until you add them again in Homeport."
  for i in "${!TUNNEL_IDS[@]}"; do
    id=${TUNNEL_IDS[$i]}; name=${TUNNEL_NAMES[$i]}
    if ask "Delete tunnel \"$name\" ($id)?"; then
      cloudflared tunnel cleanup "$id" >/dev/null 2>&1
      if cloudflared tunnel delete -f "$id" >/dev/null 2>&1; then g "tunnel $name deleted"; DELETED_IDS+=("$id"); DONE+=("tunnel $name")
      else r "could not delete $name (still connected from another machine?)"; fi
    fi
  done
else g "no tunnels"; fi

if (( ${#DELETED_IDS[@]} )); then
  if [[ -n "${CF_API_TOKEN:-}" ]]; then
    echo "  Deleting CNAME records that point at the deleted tunnels…"
    CF_API_TOKEN="$CF_API_TOKEN" node - "${DELETED_IDS[@]}" <<'NODE'
const ids = process.argv.slice(2);
const H = { Authorization: `Bearer ${process.env.CF_API_TOKEN}`, 'Content-Type': 'application/json' };
const cf = async (m, p) => { const r = await fetch('https://api.cloudflare.com/client/v4' + p, { method: m, headers: H }); const j = await r.json(); if (!j.success) throw new Error(JSON.stringify(j.errors)); return j; };
(async () => {
  let zones = [], page = 1;
  for (;;) { const j = await cf('GET', `/zones?per_page=50&page=${page}`); zones.push(...j.result); if (page >= (j.result_info?.total_pages ?? 1)) break; page++; }
  let n = 0;
  for (const z of zones) {
    const recs = (await cf('GET', `/zones/${z.id}/dns_records?type=CNAME&per_page=5000`)).result;
    for (const r of recs) if (ids.some((id) => r.content === `${id}.cfargotunnel.com`)) {
      await cf('DELETE', `/zones/${z.id}/dns_records/${r.id}`); console.log(`  \x1b[32m✓ DNS ${r.name} deleted\x1b[0m`); n++;
    }
  }
  if (!n) console.log('  • no CNAME records point at those tunnels');
})().catch((e) => { console.log(`  \x1b[31m✖ Cloudflare API: ${e.message}\x1b[0m`); });
NODE
  else
    y "CNAME records were not deleted. Remove them at dash.cloudflare.com, your domain, DNS:"
    y "CNAME records whose target is: $(printf '%s.cfargotunnel.com ' "${DELETED_IDS[@]}")"
    y "(or run again with CF_API_TOKEN=… to do it automatically)"
  fi
fi

# ======================================================================== 6. file config
b "6/6  Old config files"
FILES=()
for f in "$CF_DIR"/config.yml "$CF_DIR"/config.yaml "$CF_DIR"/*.json \
         /etc/cloudflared /usr/local/etc/cloudflared /opt/homebrew/etc/cloudflared \
         /opt/homebrew/etc/Caddyfile /usr/local/etc/Caddyfile /etc/caddy \
         "$HOME/Library/Application Support/Caddy" "$HOME/.config/caddy" "$HOME/.local/share/caddy" \
         "$HOME/tunnel-manager/data" "$HOME/homeport/data"; do
  [[ -e "$f" ]] && FILES+=("$f")
done
if (( ${#FILES[@]} )); then
  for f in "${FILES[@]}"; do y "$f"; done
  if ask "Back up, then delete the files above?"; then
    tar czf "$BACKUP" "${FILES[@]}" 2>/dev/null && g "backup: $BACKUP" || y "partial backup (some files need sudo)"
    for f in "${FILES[@]}"; do
      if rm -rf "$f" 2>/dev/null && [[ ! -e "$f" ]]; then g "deleted: $f"
      elif sudo rm -rf "$f" && [[ ! -e "$f" ]]; then g "deleted (sudo): $f"
      else r "failed: $f"; fi
    done
    DONE+=("config files (backed up to $BACKUP)")
  fi
else g "none"; fi

if [[ -f "$CF_DIR/cert.pem" ]]; then
  echo
  echo "  cert.pem is the cloudflared login. Keep it if you use the same Cloudflare account with Homeport."
  if (( ! YES )) && ask "Also remove the cloudflared login (cert.pem)?"; then
    mv "$CF_DIR/cert.pem" "$HOME/cert.pem.bak-$STAMP" && g "moved to ~/cert.pem.bak-$STAMP"; DONE+=("cert.pem")
  fi
fi

# ======================================================================== ringkasan
b "Done"
if (( ${#DONE[@]} )); then for d in "${DONE[@]}"; do g "$d"; done; else y "nothing changed"; fi
LEFT=$(pgrep -lx 'caddy|cloudflared' 2>/dev/null || true)
[[ -n "$LEFT" ]] && r "processes still running: $(echo $LEFT)"
echo
echo "  Next: bash setup-mac.sh"
