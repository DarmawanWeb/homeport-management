# HTTP API

The dashboard is a client of this API; everything it does can be scripted. The API listens on `127.0.0.1:7070` with the dashboard.

## Conventions

- JSON in, JSON out. Errors are `{ "error": "message" }` with a 4xx or 5xx status.
- Every request other than `GET` must send `X-Homeport: 1` (CSRF protection).
- Once a password is set, every endpoint except the three open auth endpoints needs the `hp_session` cookie from `POST /api/auth/login`. Before that, only requests made on the Mac itself are served.
- Mutations of domains and apps return `steps`, `warning` and `apply` describing side effects such as DNS changes and Caddy reloads.

```bash
curl -s -X POST localhost:7070/api/apps/<id>/deploy -H 'X-Homeport: 1'
```

## Authentication

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/status` | `passwordSet`, `authenticated`, `local`, `totpEnabled`, `publicUrls` (open) |
| POST | `/api/auth/setup` | `{ password }`: first password; only on the Mac (open) |
| POST | `/api/auth/login` | `{ password, code? }`; answers `401 { totpRequired: true }` when a code is needed (open) |
| POST | `/api/auth/logout` | End this session |
| POST | `/api/auth/password` | `{ current, next }`; signs out every other session |
| POST | `/api/auth/totp/begin` | New secret, `otpauth://` URI and QR code SVG |
| POST | `/api/auth/totp/enable` | `{ code }`; returns eight recovery codes |
| POST | `/api/auth/totp/disable` | `{ password }` |
| POST | `/api/auth/totp/recovery` | `{ password }`; new recovery codes |
| GET | `/api/auth/sessions` | Signed-in devices |
| DELETE | `/api/auth/sessions/:id` | Sign one out |
| POST | `/api/auth/sessions/revoke-others` | Sign out everything but this session |
| GET | `/api/auth/network` | Bind address, LAN URLs, macOS firewall state |
| POST | `/api/auth/network` | `{ lan: boolean }`; saves the choice and restarts Homeport under pm2 |
| GET / POST | `/api/auth/public` | List, or `{ hostname, tunnel? }` to publish the dashboard |
| DELETE | `/api/auth/public/:id?dns=1` | Unpublish |

```bash
# script against the API from the Mac
curl -s -c jar -X POST localhost:7070/api/auth/login -H 'X-Homeport: 1' -H 'Content-Type: application/json' \
  -d '{"password":"…","code":"123456"}'
curl -s -b jar localhost:7070/api/apps
```

## Apps and deploys

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/apps` | Apps with pm2 state, port health, domains and the last 20 deploys |
| POST | `/api/apps` | Create an app; optional `hostname` and `tunnel` also create the domain; deploys unless `deployNow: false` |
| PUT | `/api/apps/:id` | Update settings; `redeploy: true` to rebuild |
| DELETE | `/api/apps/:id?files=1&site=1` | Remove the pm2 process, optionally the checkout and the domains |
| POST | `/api/apps/:id/deploy` | Queue a deploy; `{ "commit": "<sha>" }` deploys a specific commit |
| POST | `/api/apps/:id/(start\|stop\|restart)` | Process control |
| GET | `/api/apps/:id/commits` | Last 25 commits on the branch, marking the running one |
| GET | `/api/apps/:id/webhook` | Payload URL, secret and last delivery time |
| POST | `/api/apps/:id/secret` | Rotate the webhook secret |
| GET | `/api/deploys?app=<id>` | Deploy records, newest first |
| GET | `/api/deploys/:id/log?offset=<n>` | Incremental deploy log from a byte offset, plus the record |

## Domains, tunnels and Caddy

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Domains and settings (secrets masked) |
| POST | `/api/sites` | Add a domain; `routeDns`, `overwriteDns` control the CNAME |
| PUT | `/api/sites/:id` | Update a domain |
| POST | `/api/sites/:id/toggle` | Turn a domain on or off |
| POST | `/api/sites/:id/route-dns` | Re-point DNS at the domain's tunnel |
| DELETE | `/api/sites/:id?dns=1` | Remove a domain, optionally its DNS record |
| GET | `/api/sites/health` | Whether each domain's upstream port answers |
| GET | `/api/tunnels?refresh=1` | Tunnels with connections, process state and routes |
| POST | `/api/tunnels` | Create `{ "name", "start" }` |
| POST | `/api/tunnels/:name/(start\|stop\|restart\|default\|cleanup)` | Tunnel control |
| GET | `/api/tunnels/:name/config` | The generated ingress YAML |
| DELETE | `/api/tunnels/:name?dns=1` | Delete on Cloudflare |
| POST | `/api/cloudflared/login` | Start `cloudflared tunnel login` and return its URL |
| GET | `/api/caddyfile` | Generated and current Caddyfile |
| POST | `/api/caddy/(apply\|validate\|start\|stop\|reload)` | Caddy control |
| POST | `/api/caddy-hash` | bcrypt-hash a password with Caddy |

## Processes, system and monitoring

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/status` | Versions and health of Caddy, cloudflared, pm2 |
| GET | `/api/system` | Host resources and recent deploys |
| GET | `/api/pm2` | Every pm2 process |
| POST | `/api/pm2/:name/(start\|stop\|restart\|reload)` | Control any pm2 process |
| GET | `/api/pm2/:name/logs` | Last 150 log lines |
| POST | `/api/pm2/save` | `pm2 save` |
| GET | `/api/monitoring` | Component state, alerts and scrape targets |
| POST | `/api/monitoring/(start\|stop)` | Turn monitoring on or off |
| POST | `/api/monitoring/:component/restart` | `prometheus`, `grafana` or `nodeExporter` |
| GET | `/api/monitoring/query?preset=<p>&range=<s>&app=<name>` | Named PromQL range queries used by the dashboard charts |
| GET | `/api/monitoring/credentials` | Grafana admin credentials |
| GET | `/api/logs` | Activity log, newest first |

## Settings

| Method | Path | Purpose |
|---|---|---|
| PUT | `/api/settings` | Partial update; masked secrets are left unchanged |
| POST | `/api/settings/notify/test` | Send a test notification |
| POST | `/api/settings/cf-token/test` | List zones visible to the Cloudflare token |
| GET | `/api/export` | Backup of domains, apps and settings without secrets |

## Webhook receiver

Separate listener on `127.0.0.1:9000`, published through Caddy on the webhook hostname.

| Method | Path | Result |
|---|---|---|
| GET | `/health` | `{ ok: true }` |
| POST | `/hooks/:appId` | `202 { queued }` for a signed push to the branch, `200` for `ping`, `202 { ignored }` otherwise, `401` for a bad signature |
