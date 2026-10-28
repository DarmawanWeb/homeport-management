#!/usr/bin/env bash
# Remove a hand-made Caddy and Cloudflare Tunnel setup so Homeport can start clean.
#
#   bash reset-mac.sh             # ask before every step (recommended)
#   bash reset-mac.sh --dry-run   # only list what was found; change nothing
#   bash reset-mac.sh --yes       # do everything without asking (except cert.pem)
#   bash reset-mac.sh --full      # also remove Homeport itself: its apps (pm2 processes, logs,
#                                 # checkouts with node_modules and build caches), its data
#                                 # (apps, domains, users, history, metrics), its build, and the
#                                 # npm, pnpm and corepack download caches
#   bash reset-mac.sh --reinstall # --full, then bash setup-mac.sh for a fresh install
#
# Optional: CF_API_TOKEN=xxx bash reset-mac.sh also deletes CNAME records of deleted tunnels.
#   (Cloudflare token with Zone:DNS:Edit and Zone:Zone:Read)
#
# Never touched: the Homebrew packages themselves, pm2 itself, and the cloudflared login
# (cert.pem) unless you choose to remove it. Without --full, also your apps and ~/apps.
# With --full, files in the apps folder that are not Homeport apps are only removed if you say so,
# never with --yes. Works with the bash 3.2 that ships with macOS.

set -uo pipefail

DRY=0; YES=0; FULL=0; REINSTALL=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    --full|--purge) FULL=1 ;;
    --reinstall) FULL=1; REINSTALL=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
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
HP_DIR=$(cd "$(dirname "$0")" && pwd)
HP_DATA="${TM_DATA_DIR:-$HP_DIR/data}"

STEP=0; TOTAL=6; (( FULL )) && TOTAL=8
section() { STEP=$((STEP + 1)); b "$STEP/$TOTAL  $*"; }

(( DRY )) && printf "\033[33mDRY RUN: nothing will be changed.\033[0m\n"
(( FULL && ! DRY )) && printf "\033[33mFULL RESET: Homeport, its apps and its data will be removed.\033[0m\n"

# ======================================================================== 1. inventaris
section "Looking for an existing setup"

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


# --full: Homeport itself, the apps it deployed, and what they leave behind.
HP_APPS=(); APPS_DIR=""; HP_PROC=0; HP_CACHE=()
if (( FULL )); then
  # The apps folder and app names come from Homeport's own database.
  if [[ -f "$HP_DATA/db.json" ]] && have node; then
    APPS_DIR=$(node -e '
      const db=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      console.log((db.settings&&db.settings.appsDir)||"")' "$HP_DATA/db.json" 2>/dev/null || true)
    while IFS= read -r n; do
      [[ -n "$n" ]] && HP_APPS+=("$n")
    done < <(node -e '
      const db=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      for (const a of db.apps||[]) if (/^[a-z0-9][a-z0-9._-]{0,39}$/.test(a.name)) console.log(a.name)' "$HP_DATA/db.json" 2>/dev/null)
  fi
  [[ -z "$APPS_DIR" ]] && APPS_DIR="${HOMEPORT_APPS_DIR:-$HOME/apps}"
  # Never treat /, the home folder or the Homeport folder as the apps folder.
  case "$APPS_DIR" in /|"$HOME"|"$HOME/"|"$HP_DIR"|"") APPS_DIR="" ;; esac

  have pm2 && pm2 describe homeport >/dev/null 2>&1 && HP_PROC=1
  (( HP_PROC )) && y "Homeport is running under pm2" || g "Homeport is not running under pm2"
  if (( ${#HP_APPS[@]} )); then
    y "Homeport apps: ${HP_APPS[*]}"
  else
    g "no apps in Homeport's database"
  fi
  [[ -n "$APPS_DIR" && -d "$APPS_DIR" ]] && y "apps folder: $APPS_DIR ($(ls -A "$APPS_DIR" 2>/dev/null | wc -l | tr -d ' ') entries)"
  [[ -d "$HP_DATA" ]] && y "Homeport data: $HP_DATA ($(du -sh "$HP_DATA" 2>/dev/null | cut -f1))"
  for f in "$HP_DIR/dist" "$HP_DIR/node_modules" "$HP_DIR/.tmp" "$HP_DIR/docs/.vitepress/cache" "$HP_DIR/docs/.vitepress/dist"; do
    [[ -e "$f" ]] && HP_CACHE+=("$f")
  done
  (( ${#HP_CACHE[@]} )) && y "Homeport build output: ${HP_CACHE[*]}"
fi

if [[ -z "$BREW_SVCS$PM2_LIST$PROCS" ]] && (( ${#PLISTS[@]} == 0 && ${#TUNNEL_IDS[@]} == 0 && ${#FILES[@]} == 0 )) \
  && (( ! FULL || (HP_PROC == 0 && ${#HP_APPS[@]} == 0 && ${#HP_CACHE[@]} == 0) )) \
  && [[ ! -d "$HP_DATA" || $FULL == 0 ]] && [[ -z "$APPS_DIR" || ! -d "$APPS_DIR" || $FULL == 0 ]]; then
  b "Nothing to remove. This Mac is clean ✓"
  (( REINSTALL )) && exec bash "$HP_DIR/setup-mac.sh"
  exit 0
fi
(( DRY )) && { b "Dry run finished. Run without --dry-run to remove these."; exit 0; }

# ======================================================================== Homeport and its apps (--full)
pm2_logs_of() { # log files pm2 keeps for a process, rotated copies included
  pm2 jlist 2>/dev/null | node -e '
    const name=process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let a=[];try{a=JSON.parse(s.slice(s.indexOf("[")))}catch{}
      const e=(a.find(p=>p.name===name)||{}).pm2_env||{};
      for (const f of [e.pm_out_log_path,e.pm_err_log_path,e.pm_log_path]) if (f&&f[0]==="/"&&!f.startsWith("/dev/")) console.log(f);
    })' "$1" 2>/dev/null
}
pm2_purge() { # pm2_purge name: delete the process and its logs
  local n=$1 logs f
  pm2 describe "$n" >/dev/null 2>&1 || return 1
  logs=$(pm2_logs_of "$n")
  pm2 delete "$n" >/dev/null 2>&1
  for f in $logs; do rm -f "$f" "${f%.log}"__*.log 2>/dev/null; done
  return 0
}

if (( FULL )); then
  section "Homeport and its apps"
  if have pm2 && (( HP_PROC )) && ask "Stop Homeport and remove it from pm2?"; then
    pm2_purge homeport && g "pm2 delete homeport (and its logs)"
    DONE+=("Homeport stopped")
  fi
  if (( ${#HP_APPS[@]} )) && ask "Remove the apps ${HP_APPS[*]} (pm2 processes, logs and checkouts)?"; then
    for n in "${HP_APPS[@]}"; do
      have pm2 && pm2_purge "$n" && g "pm2 delete $n (and its logs)"
      if [[ -n "$APPS_DIR" && -e "$APPS_DIR/$n" ]]; then
        rm -rf "${APPS_DIR:?}/$n" && g "deleted $APPS_DIR/$n"
      fi
    done
    DONE+=("apps: ${HP_APPS[*]}")
  fi
  have pm2 && pm2 save --force >/dev/null 2>&1
  if [[ -n "$APPS_DIR" && -d "$APPS_DIR" ]]; then
    LEFTOVER=$(ls -A "$APPS_DIR" 2>/dev/null)
    if [[ -z "$LEFTOVER" ]]; then
      rmdir "$APPS_DIR" 2>/dev/null && g "removed the empty $APPS_DIR"
    else
      y "still in $APPS_DIR: $(echo $LEFTOVER)"
      # Not Homeport's to delete, so never with --yes.
      if (( ! YES )) && ask "Delete everything in $APPS_DIR too?"; then
        rm -rf "${APPS_DIR:?}" && g "deleted $APPS_DIR"; DONE+=("$APPS_DIR")
      fi
    fi
  fi
fi

# ======================================================================== 2. hentikan service
section "Stopping caddy and cloudflared services"
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
section "pm2 processes"
if [[ -n "$PM2_LIST" ]] && ask "Delete pm2 processes: $(echo $PM2_LIST)?"; then
  for n in $PM2_LIST; do
    if (( FULL )); then pm2_purge "$n" && g "pm2 delete $n (and its logs)"
    else pm2 delete "$n" >/dev/null 2>&1 && g "pm2 delete $n"; fi
  done
  pm2 save >/dev/null 2>&1
  DONE+=("old pm2 processes")
else g "skipped"; fi

# ======================================================================== 4. proses sisa
section "Processes still running"
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
section "Tunnels on your Cloudflare account"
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
section "Old config files"
FILES=()
for f in "$CF_DIR"/config.yml "$CF_DIR"/config.yaml "$CF_DIR"/*.json \
         /etc/cloudflared /usr/local/etc/cloudflared /opt/homebrew/etc/cloudflared \
         /opt/homebrew/etc/Caddyfile /usr/local/etc/Caddyfile /etc/caddy \
         "$HOME/Library/Application Support/Caddy" "$HOME/.config/caddy" "$HOME/.local/share/caddy" \
         "$HOME/tunnel-manager/data" "$HOME/homeport/data"; do
  [[ -e "$f" ]] && FILES+=("$f")
done
if (( FULL )); then # the data step below handles Homeport's own data folder
  KEEP=(); for f in ${FILES[@]+"${FILES[@]}"}; do [[ "$f" -ef "$HP_DATA" ]] || KEEP+=("$f"); done
  FILES=(${KEEP[@]+"${KEEP[@]}"})
fi
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

# ======================================================================== Homeport data and caches (--full)
if (( FULL )); then
  section "Homeport data, build and caches"
  if [[ -d "$HP_DATA" ]]; then
    echo "  $HP_DATA holds the apps, domains, users and two-factor, deploy history and metrics."
    if ask "Back up the settings, then delete Homeport's data?"; then
      # Settings only: metrics, analytics and logs are large and not worth restoring.
      tar czf "$HOME/homeport-data-backup-$STAMP.tgz" -C "$HP_DATA" \
        --exclude monitoring --exclude analytics --exclude uptime --exclude deploy-logs . 2>/dev/null \
        && g "backup: ~/homeport-data-backup-$STAMP.tgz" || y "could not back up $HP_DATA"
      rm -rf "${HP_DATA:?}" && g "deleted $HP_DATA"
      DONE+=("Homeport data")
    fi
  fi
  if (( ${#HP_CACHE[@]} )) && ask "Delete Homeport's build output and node_modules (setup-mac.sh rebuilds them)?"; then
    for f in "${HP_CACHE[@]}"; do rm -rf "$f" && g "deleted $f"; done
    DONE+=("Homeport build output")
  fi
  if ask "Clear the npm, pnpm and corepack download caches (they fill up again on the next install)?"; then
    have npm && npm cache clean --force >/dev/null 2>&1 && g "npm cache cleared"
    have pnpm && pnpm store prune >/dev/null 2>&1 && g "pnpm store pruned"
    for d in "${COREPACK_HOME:-$HOME/.cache/node/corepack}" "$HOME/Library/Caches/node/corepack"; do
      [[ -d "$d" ]] && rm -rf "$d" && g "deleted $d"
    done
    DONE+=("package manager caches")
  fi
fi

# ======================================================================== ringkasan
b "Done"
if (( ${#DONE[@]} )); then for d in "${DONE[@]}"; do g "$d"; done; else y "nothing changed"; fi
LEFT=$(pgrep -lx 'caddy|cloudflared' 2>/dev/null || true)
[[ -n "$LEFT" ]] && r "processes still running: $(echo $LEFT)"
echo
if (( REINSTALL )); then
  b "Installing Homeport again"
  exec bash "$HP_DIR/setup-mac.sh"
fi
echo "  Next: bash setup-mac.sh"
