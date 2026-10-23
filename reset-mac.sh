#!/usr/bin/env bash
# Hapus setup Caddy + Cloudflare Tunnel lama di Mac, supaya bisa mulai bersih dengan Homeport.
#
#   bash reset-mac.sh             # tanya dulu sebelum setiap langkah (disarankan)
#   bash reset-mac.sh --dry-run   # hanya tampilkan apa yang ditemukan, tidak menghapus apa pun
#   bash reset-mac.sh --yes       # jalankan semua tanpa bertanya (kecuali cert.pem)
#
# Opsional: CF_API_TOKEN=xxx bash reset-mac.sh   → CNAME DNS milik tunnel yang dihapus ikut dihapus.
#   (token Cloudflare dengan izin Zone:DNS:Edit + Zone:Zone:Read)
#
# Yang TIDAK disentuh: aplikasi brew (caddy, cloudflared tetap terpasang), proses pm2 app kamu,
# folder ~/apps, dan login cloudflared (cert.pem) kecuali kamu pilih sendiri.
# Kompatibel dengan bash 3.2 bawaan macOS.

set -uo pipefail

DRY=0; YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Opsi tidak dikenal: $a"; exit 1 ;;
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

(( DRY )) && printf "\033[33mMODE DRY-RUN: tidak ada yang diubah.\033[0m\n"

# ======================================================================== 1. inventaris
b "1/6  Memeriksa setup yang ada"

BREW_SVCS=""
if have brew; then
  BREW_SVCS=$(brew services list 2>/dev/null | awk 'NR>1 && ($1=="caddy" || $1=="cloudflared") && $2!="none" {print $1" ("$2")"}')
fi
[[ -n "$BREW_SVCS" ]] && y "brew services: $(echo $BREW_SVCS)" || g "tidak ada brew services caddy/cloudflared"

PLISTS=()
for p in /Library/LaunchDaemons/com.cloudflare.cloudflared.plist \
         "$HOME/Library/LaunchAgents/com.cloudflare.cloudflared.plist" \
         /Library/LaunchDaemons/com.caddyserver.caddy.plist \
         "$HOME/Library/LaunchAgents/com.caddyserver.caddy.plist"; do
  [[ -f "$p" ]] && PLISTS+=("$p")
done
(( ${#PLISTS[@]} )) && for p in "${PLISTS[@]}"; do y "launchd service: $p"; done || g "tidak ada launchd service cloudflared/caddy"

PM2_LIST=""
if have pm2; then
  # Proses pm2 yang menjalankan caddy/cloudflared/prometheus/grafana, atau buatan versi lama tool ini.
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
[[ -n "$PM2_LIST" ]] && y "proses pm2: $(echo $PM2_LIST)" || g "tidak ada proses pm2 caddy/cloudflared"

PROCS=$(pgrep -lx 'caddy|cloudflared' 2>/dev/null || true)
[[ -n "$PROCS" ]] && y "proses berjalan: $(echo "$PROCS" | awk '{print $2"["$1"]"}' | tr '\n' ' ')" || g "tidak ada proses caddy/cloudflared yang berjalan"

TUNNEL_IDS=(); TUNNEL_NAMES=()
if have cloudflared && [[ -f "$CF_DIR/cert.pem" ]]; then
  TJSON=$(cloudflared tunnel list --output json 2>/dev/null || echo "[]")
  while IFS=$'\t' read -r id name conns; do
    [[ -z "$id" ]] && continue
    TUNNEL_IDS+=("$id"); TUNNEL_NAMES+=("$name")
    y "tunnel di Cloudflare: $name ($id, $conns koneksi aktif)"
  done < <(echo "$TJSON" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      let a=[];try{a=JSON.parse(s)||[]}catch{}
      for(const t of a) console.log([t.id,t.name,(t.connections||[]).length].join("\t"));
    })')
  (( ${#TUNNEL_IDS[@]} )) || g "tidak ada tunnel di akun Cloudflare ini"
elif have cloudflared; then
  y "cloudflared belum login (tidak ada cert.pem) — daftar tunnel di Cloudflare tidak bisa dicek"
fi

FILES=()
for f in "$CF_DIR"/config.yml "$CF_DIR"/config.yaml "$CF_DIR"/*.json \
         /etc/cloudflared /usr/local/etc/cloudflared /opt/homebrew/etc/cloudflared \
         /opt/homebrew/etc/Caddyfile /usr/local/etc/Caddyfile /etc/caddy \
         "$HOME/Library/Application Support/Caddy" "$HOME/.config/caddy" "$HOME/.local/share/caddy" \
         "$HOME/tunnel-manager/data" "$HOME/homeport/data"; do
  [[ -e "$f" ]] && FILES+=("$f")
done
(( ${#FILES[@]} )) && for f in "${FILES[@]}"; do y "file/folder: $f"; done || g "tidak ada file config lama"

if [[ -z "$BREW_SVCS$PM2_LIST$PROCS" ]] && (( ${#PLISTS[@]} == 0 && ${#TUNNEL_IDS[@]} == 0 && ${#FILES[@]} == 0 )); then
  b "Tidak ada yang perlu dihapus. Mac sudah bersih ✓"; exit 0
fi
(( DRY )) && { b "Dry-run selesai. Jalankan tanpa --dry-run untuk menghapus."; exit 0; }

# ======================================================================== 2. hentikan service
b "2/6  Menghentikan service caddy & cloudflared"
if [[ -n "$BREW_SVCS" ]] && ask "Hentikan brew services caddy/cloudflared?"; then
  for s in caddy cloudflared; do brew services stop "$s" >/dev/null 2>&1 && g "brew services stop $s"; done
  DONE+=("brew services dihentikan")
fi
for p in ${PLISTS[@]+"${PLISTS[@]}"}; do
  if ask "Hapus launchd service $(basename "$p")?"; then
    case "$p" in
      *cloudflared*)
        if [[ "$p" == /Library/* ]]; then sudo cloudflared service uninstall 2>/dev/null || { sudo launchctl bootout system "$p" 2>/dev/null; sudo rm -f "$p"; }
        else cloudflared service uninstall 2>/dev/null || { launchctl bootout "gui/$(id -u)" "$p" 2>/dev/null; rm -f "$p"; }; fi ;;
      *)
        if [[ "$p" == /Library/* ]]; then sudo launchctl bootout system "$p" 2>/dev/null; sudo rm -f "$p"
        else launchctl bootout "gui/$(id -u)" "$p" 2>/dev/null; rm -f "$p"; fi ;;
    esac
    [[ -f "$p" ]] && r "masih ada: $p" || { g "dihapus: $p"; DONE+=("launchd $(basename "$p")"); }
  fi
done

# ======================================================================== 3. pm2
b "3/6  Proses pm2"
if [[ -n "$PM2_LIST" ]] && ask "Hapus proses pm2: $(echo $PM2_LIST)?"; then
  for n in $PM2_LIST; do pm2 delete "$n" >/dev/null 2>&1 && g "pm2 delete $n"; done
  pm2 save >/dev/null 2>&1
  DONE+=("proses pm2 lama")
else g "dilewati"; fi

# ======================================================================== 4. proses sisa
b "4/6  Proses yang masih berjalan"
PROCS=$(pgrep -lx 'caddy|cloudflared' 2>/dev/null || true)
if [[ -n "$PROCS" ]]; then
  y "$(echo "$PROCS" | awk '{print $2"["$1"]"}' | tr '\n' ' ')"
  if ask "Hentikan proses caddy & cloudflared ini?"; then
    have caddy && caddy stop >/dev/null 2>&1
    pkill -x cloudflared 2>/dev/null; pkill -x caddy 2>/dev/null; sleep 2
    pkill -9 -x cloudflared 2>/dev/null; pkill -9 -x caddy 2>/dev/null
    REMAIN=$(pgrep -lx 'caddy|cloudflared' 2>/dev/null || true)
    if [[ -n "$REMAIN" ]]; then r "masih jalan (mungkin milik root): $(echo $REMAIN) — coba: sudo pkill -x cloudflared caddy"
    else g "semua berhenti"; DONE+=("proses dihentikan"); fi
  fi
else g "tidak ada"; fi

# ======================================================================== 5. tunnel di Cloudflare
b "5/6  Tunnel di akun Cloudflare"
DELETED_IDS=()
if (( ${#TUNNEL_IDS[@]} )); then
  echo "  Menghapus tunnel TIDAK bisa dibatalkan. Domain yang memakainya akan mati sampai kamu buat ulang di Homeport."
  for i in "${!TUNNEL_IDS[@]}"; do
    id=${TUNNEL_IDS[$i]}; name=${TUNNEL_NAMES[$i]}
    if ask "Hapus tunnel \"$name\" ($id)?"; then
      cloudflared tunnel cleanup "$id" >/dev/null 2>&1
      if cloudflared tunnel delete -f "$id" >/dev/null 2>&1; then g "tunnel $name dihapus"; DELETED_IDS+=("$id"); DONE+=("tunnel $name")
      else r "gagal menghapus $name (masih ada koneksi? proses cloudflared lain di komputer lain?)"; fi
    fi
  done
else g "tidak ada tunnel"; fi

if (( ${#DELETED_IDS[@]} )); then
  if [[ -n "${CF_API_TOKEN:-}" ]]; then
    echo "  Menghapus CNAME DNS yang mengarah ke tunnel yang dihapus…"
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
      await cf('DELETE', `/zones/${z.id}/dns_records/${r.id}`); console.log(`  \x1b[32m✓ DNS ${r.name} dihapus\x1b[0m`); n++;
    }
  }
  if (!n) console.log('  • tidak ada CNAME yang mengarah ke tunnel tersebut');
})().catch((e) => { console.log(`  \x1b[31m✖ Cloudflare API: ${e.message}\x1b[0m`); });
NODE
  else
    y "CNAME DNS tidak terhapus otomatis. Hapus manual di dash.cloudflare.com → domain → DNS,"
    y "record CNAME yang isinya: $(printf '%s.cfargotunnel.com ' "${DELETED_IDS[@]}")"
    y "(atau jalankan ulang dengan CF_API_TOKEN=… supaya otomatis)"
  fi
fi

# ======================================================================== 6. file config
b "6/6  File config lama"
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
  if ask "Backup lalu hapus file/folder di atas?"; then
    tar czf "$BACKUP" "${FILES[@]}" 2>/dev/null && g "backup: $BACKUP" || y "backup sebagian (beberapa file butuh sudo)"
    for f in "${FILES[@]}"; do
      if rm -rf "$f" 2>/dev/null && [[ ! -e "$f" ]]; then g "dihapus: $f"
      elif sudo rm -rf "$f" && [[ ! -e "$f" ]]; then g "dihapus (sudo): $f"
      else r "gagal: $f"; fi
    done
    DONE+=("file config (backup di $BACKUP)")
  fi
else g "tidak ada"; fi

if [[ -f "$CF_DIR/cert.pem" ]]; then
  echo
  echo "  cert.pem = login cloudflared ke akun Cloudflare. Biarkan kalau akun/domain tetap sama (Homeport memakainya)."
  if (( ! YES )) && ask "Hapus juga login cloudflared (cert.pem)?"; then
    mv "$CF_DIR/cert.pem" "$HOME/cert.pem.bak-$STAMP" && g "dipindah ke ~/cert.pem.bak-$STAMP"; DONE+=("cert.pem")
  fi
fi

# ======================================================================== ringkasan
b "Selesai"
if (( ${#DONE[@]} )); then for d in "${DONE[@]}"; do g "$d"; done; else y "tidak ada yang diubah"; fi
LEFT=$(pgrep -lx 'caddy|cloudflared' 2>/dev/null || true)
[[ -n "$LEFT" ]] && r "masih ada proses: $(echo $LEFT)"
echo
echo "  Langkah berikutnya: cd ~/homeport && bash setup-mac.sh"
