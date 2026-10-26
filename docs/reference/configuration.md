# Configuration

## Environment variables

Set in `ecosystem.config.cjs` for the `homeport` pm2 process, or as container environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker and from `setup-linux.sh`) | Dashboard bind address, used when `data/network.json` has no choice saved. Access → Local network and `setup-mac.sh --lan` / `--local-only` save one. Remote browsers always need the password, or the setup code before one exists |
| `PORT` | `7070` | Dashboard and API port |
| `TM_PASSWORD` | unset | Deprecated. If set and no password exists yet, it is imported once as the dashboard password |
| `TM_DATA_DIR` | `./data` | Where state and generated files live |
| `HOMEPORT_APPS_DIR` | `~/apps` | Default folder for cloned apps (Docker: `/apps`) |
| `HOMEPORT_CLOUDFLARED_DIR` | `~/.cloudflared` | Cloudflare certificate and tunnel credentials (Docker: `/data/cloudflared`) |
| `HOMEPORT_BIN` | `~/.homeport/bin` | Extra folder searched for caddy, cloudflared and the monitoring tools; `setup-linux.sh` installs there |
| `HOMEPORT_FLAVOR` | detected | `mac`, `linux`, `synology` or `docker`; only changes install hints and texts |

Everything else is in **Settings** and stored in `data/db.json`, including **Default domain for apps**: set it to a zone such as `example.com` and every new app gets `<name>.example.com`, the way Vercel gives each project a URL. The password, two-factor secret and sessions live in `data/auth.json` (mode 600), which is never included in exports.

`npm run reset-password` clears `auth.json` and restarts Homeport.

## Ports

| Port | Used by | Setting |
|---|---|---|
| 7070 | Dashboard and API | `PORT` |
| 8080 | Caddy, the target of every tunnel | Caddy, Proxy port |
| 2019 | Caddy admin API | Caddy, Admin API address |
| 9000 | Webhook receiver | Webhooks, Webhook listener port |
| 9090, 3300, 9100 | Prometheus, Grafana, node_exporter | Monitoring |
| 9101 | Homeport metrics exporter | Monitoring |
| 20241+ | cloudflared metrics, one per tunnel | assigned automatically |
| 3001+ | Apps | Webhooks, First app port |

Homeport refuses to give an app any of these ports.

## Files

```
~/apps/<app>/                   git checkouts
~/.cloudflared/                 cert.pem and tunnel credentials (managed by cloudflared)
data/
  db.json                       apps, domains, settings, deploy records
  Caddyfile                     generated; Caddy runs from this file
  backups/Caddyfile.<time>      last 30 versions
  tunnels/<name>.yml            generated cloudflared ingress per tunnel
  ecosystem/<app>.config.cjs    generated pm2 config per app
  deploy-logs/<id>.log          full output of each deploy (last 30 per app)
  monitoring/
    prometheus/                 prometheus.yml, rules.yml, TSDB data
    grafana/                    grafana.ini, provisioning, dashboards, data
```

`db.json` is written atomically (temp file and rename) and saves are serialized, so a crash mid-write cannot corrupt it. A file that cannot be parsed is copied aside as `db.json.corrupt-<time>` before Homeport starts with defaults.

## Backups

Copy `data/` and `~/.cloudflared/`. **Settings, Export backup** downloads apps, domains and settings without any secrets, useful for review or moving to a new machine.

## Processes Homeport manages

| pm2 name | What |
|---|---|
| `homeport` | This server |
| `hp-caddy` | Caddy |
| `hp-cf-<tunnel>` | One per tunnel |
| `hp-prometheus`, `hp-grafana`, `hp-node-exporter` | Monitoring |
| `<app name>` | Each app |

Names starting with `hp-` and the name `homeport` are reserved and cannot be used for apps.
