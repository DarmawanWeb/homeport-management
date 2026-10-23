# Homeport

Platform deploy pribadi untuk Mac mini: **push ke GitHub → otomatis build & jalan → online di domain kamu**, lengkap dengan monitoring Prometheus + Grafana dan notifikasi Discord/Telegram.

```
                ┌───────────────────────────────── Mac mini ──────────────────────────────────┐
 git push       │                                                                             │
 GitHub ─webhook─► hooks.domain.com ─┐                                                        │
                │                    │ Cloudflare  ┌────────┐                                 │
 Pengunjung ────►  toko.domain.com ──┼─  Tunnel  ─►│ Caddy  │─► :3001 web-toko ┐              │
                │   api.domain.com ──┘             │ :8080  │─► :3002 api      ├─ pm2         │
                │                                  │        │─► :9000 webhook ─┘→ deploy      │
                │                                  └────────┘                                 │
                │  Prometheus :9090 ◄─ scrape ─ Homeport · Caddy · cloudflared · node_exporter│
                │  Grafana :3300 · Dashboard Homeport :7070 (semua hanya 127.0.0.1)           │
                └─────────────────────────────────────────────────────────────────────────────┘
```

- **Tanpa buka port router / IP publik.** Semua lewat Cloudflare Tunnel, HTTPS dari Cloudflare.
- **Semua proses di pm2:** app kamu, Caddy, tunnel, Prometheus, Grafana, dan Homeport sendiri.
- **TypeScript penuh:** server Fastify + Zod, UI React + Vite, dengan tipe yang dipakai bersama.

## Pasang

**Sudah punya setup Caddy / Cloudflare Tunnel lama?** Bersihkan dulu:

```bash
bash reset-mac.sh --dry-run   # lihat dulu apa saja yang ditemukan
bash reset-mac.sh             # hapus, dengan konfirmasi di setiap langkah
```

Skrip ini menghentikan service lama dan menghapus tunnel di Cloudflare. Config lama di-backup ke `~/homeport-reset-backup-*.tgz`. Login cloudflared (`cert.pem`) dibiarkan kecuali kamu memilih menghapusnya. CNAME DNS ikut terhapus kalau dijalankan dengan `CF_API_TOKEN=…`.


```bash
git clone https://github.com/DarmawanWeb/homeport-management ~/homeport
cd ~/homeport
bash setup-mac.sh                 # tambah --no-monitoring kalau tidak mau Prometheus/Grafana
```

Skrip ini memasang Homebrew packages, pm2, dan pm2-logrotate, lalu build dan menjalankan Homeport. Di akhir, jalankan perintah `sudo …` yang dicetak supaya semuanya hidup lagi setelah reboot. Untuk **update**, cukup `git pull && bash setup-mac.sh`.

Buka **http://127.0.0.1:7070**, lalu:

1. **Login Cloudflare.** Klik banner, pilih domain, lalu Authorize.
2. **Tunnels → Buat tunnel**, misalnya `macmini`. Satu tunnel cukup untuk semua domain.
3. **Services → Start Caddy.**
4. **Settings → Webhook.** Isi `hooks.domainkamu.com`, lalu klik **Buat domain webhook**.
5. **Monitoring → Aktifkan monitoring** (opsional, tapi seru).
6. **Settings → Notifikasi.** Tempel URL webhook Discord atau token bot Telegram, lalu klik **kirim tes**.

## Deploy app

**Apps → + Tambah app dari Git**, lalu isi URL repo, branch, port (otomatis 3001, 3002, …), domain (opsional), dan env vars.

```
git clone → install → build → pm2 start/reload → tunggu port merespon → ✓
```

- Package manager dideteksi dari lockfile (npm / pnpm / yarn / bun). Perintah bisa di-override per app, dan `-` berarti lewati langkah itu.
- **Syarat untuk app kamu:** harus listen di `process.env.PORT`.
- **Auto-deploy:** klik **Webhook** di kartu app, lalu salin URL dan secret ke GitHub → Settings → Webhooks (content type `application/json`, event *push*). Alternatifnya mode **Cek berkala** (polling `git ls-remote`) tanpa endpoint publik.
- **Gagal?** Kalau build error, app crash-loop, atau port tidak terbuka, deploy ditandai gagal dan otomatis **rollback** ke commit terakhir yang sukses. Riwayat menampilkan log tiap deploy, dan kamu bisa deploy commit mana pun.
- **Repo private:** pakai token GitHub fine-grained (Contents: Read) di form app, yang tidak disimpan di `.git/config`. Atau pakai URL `git@github.com:…` dengan SSH key di Mac.

## Monitoring

Satu klik di tab **Monitoring** menjalankan:

| Komponen | Port | Isi |
|---|---|---|
| Prometheus | 9090 | Scrape tiap 15 detik, retensi 30 hari, mengevaluasi aturan alert |
| Grafana | 3300 | Dashboard **Homeport — Overview** dan **Homeport — Mac mini**, sudah ter-provision |
| node_exporter | 9100 | CPU, disk I/O, jaringan, filesystem |
| Homeport exporter | 9101 | Status app, CPU/RAM per proses pm2, deploy (jumlah, durasi, sukses/gagal), webhook, upstream domain, tunnel, RAM/disk Mac |

Prometheus juga men-scrape **Caddy**, sehingga ada request/detik, status code, dan latensi p50/p95/p99 per domain. Caddy ≥ 2.9 terdeteksi otomatis untuk metrics per host. Prometheus juga men-scrape **cloudflared**, untuk koneksi edge dan request per tunnel.

Grafik utama juga tampil langsung di dashboard Homeport (Overview, Monitoring, dan tombol **Metrics** di tiap app) tanpa perlu membuka Grafana. Grafana bisa dilihat tanpa login (viewer). Password admin ada di Monitoring → Grafana → **Login admin**.

**Alert bawaan** (diteruskan ke Discord/Telegram, termasuk saat pulih):

| Alert | Kondisi |
|---|---|
| AppDown | App tidak merespon > 2 menit (diabaikan selama deploy) |
| AppCrashLoop | Restart > 3x dalam 10 menit |
| AppHighMemory | Proses app > 1.5 GB selama 10 menit |
| DomainUpstreamDown | Upstream sebuah domain tidak merespon > 3 menit |
| TunnelDown / TunnelDisconnected | Proses tunnel mati, atau jalan tapi 0 koneksi ke Cloudflare |
| CaddyDown | Caddy tidak bisa di-scrape |
| HighErrorRate | > 5% request ke sebuah domain error 5xx |
| HostDiskAlmostFull / HostHighMemory / HostHighCpu | Disk > 90%, RAM > 92%, CPU > 90% |

Tanpa monitoring pun, notifikasi **deploy** dan **app down** tetap jalan lewat watcher bawaan.

## Struktur kode

```
src/
  shared/types.ts          tipe yang dipakai server & UI
  server/
    index.ts               bootstrap
    app.ts                 Fastify: auth, CSRF guard, error handler, static UI
    config.ts · store.ts   path, default settings, db.json (tulis berurutan & atomik)
    lib/                   exec (spawn/stream), validators (zod), events, errors
    services/              caddy · cloudflared · cloudflareApi · pm2 · sites · apps · deploy · webhooks · notify
    monitoring/            exporter (prom-client) · configs · dashboards (Grafana JSON dari kode) · service · alerts
    routes/                infra · apps · settings
web/src/                   React: pages/, components/ (Chart SVG, dialog, ui), lib/ (api, queries, toast)
test/                      vitest
```

```bash
npm run dev        # server dengan reload (tsx watch)
npm run dev:web    # UI di http://localhost:5173 (proxy ke :7070)
npm run typecheck
npm test
npm run build
```

## Keamanan

- Dashboard, Prometheus, Grafana, dan exporter hanya listen di `127.0.0.1`. **Jangan** buat domain yang mengarah ke port-port itu.
- Yang terbuka ke internet hanya webhook server (`/hooks/<id>`), dan setiap request diverifikasi dengan HMAC-SHA256 memakai secret per app.
- Semua API yang mengubah data butuh header `X-Homeport: 1`, sehingga situs lain tidak bisa memicu aksi lewat browser kamu (CSRF).
- Untuk akses dari LAN, set `HOST: '0.0.0.0'` dan `TM_PASSWORD` di `ecosystem.config.cjs`. Pilihan yang lebih aman: Cloudflare Access.
- Perintah install/build dijalankan sebagai user kamu. Hanya tambahkan repo yang kamu percaya.

## Troubleshooting

| Masalah | Cek |
|---|---|
| Deploy gagal "tidak listen di port" | App tidak membaca `process.env.PORT`, atau crash. Lihat 40 baris log di akhir log deploy |
| `npm: command not found` saat deploy | `pm2 kill && pm2 resurrect` dari Terminal biasa (agar PATH Homebrew terbawa) |
| Webhook 401 (GitHub → Recent Deliveries) | Secret beda, atau content type bukan `application/json` |
| Domain 404 dari Caddy | Hostname belum ada di Domains, atau perlu Caddyfile → Apply |
| Error 1033 dari Cloudflare | Tunnel tidak jalan → Tunnels → Start |
| Grafana "folder instalasi tidak ditemukan" | Isi Settings → Monitoring → Grafana home, mis. `/opt/homebrew/opt/grafana/share/grafana` |
| Port sudah dipakai | `brew services stop caddy grafana prometheus` |

## Lokasi data

```
~/apps/<app>/                  kode app (hasil clone)
data/db.json                   app, domain, settings, riwayat deploy
data/deploy-logs/              log tiap deploy
data/ecosystem/                config pm2 per app
data/Caddyfile, data/tunnels/  config Caddy & cloudflared
data/monitoring/               config + data Prometheus & Grafana
~/.cloudflared/                cert.pem + kredensial tunnel
```

Untuk backup, salin `data/` atau pakai Settings → Export backup. Secret tidak ikut di file export.
