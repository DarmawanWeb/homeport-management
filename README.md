<div align="center">

<img src="docs/public/favicon.svg" width="56" alt="" />

# Homeport

**Push to GitHub, and it runs on the Mac mini or Synology NAS under your desk.**

A self-hosted deploy platform for Node apps: git push deploys with automatic rollback, domains through Cloudflare Tunnel with no open ports, Prometheus and Grafana monitoring, and a dashboard you can open from anywhere behind a password and two-factor sign-in.

[![CI](https://github.com/DarmawanWeb/homeport-management/actions/workflows/ci.yml/badge.svg)](https://github.com/DarmawanWeb/homeport-management/actions/workflows/ci.yml)
[![Docs](https://github.com/DarmawanWeb/homeport-management/actions/workflows/docs.yml/badge.svg)](https://darmawanweb.github.io/homeport-management/)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-1d5c88)
![License](https://img.shields.io/badge/license-MIT-1e8a5a)

[Documentation](https://darmawanweb.github.io/homeport-management/) · [Architecture](https://darmawanweb.github.io/homeport-management/reference/architecture) · [Design decisions](https://darmawanweb.github.io/homeport-management/decisions/)

<img src="docs/public/screenshots/overview.png" alt="Homeport overview: the traffic route from visitors through Cloudflare, the tunnel and Caddy to each app, with a status light per hop" />

</div>

## The problem

A Mac mini makes a very good small server: quiet, cheap to run, and fast enough for a handful of Node services. Running apps on it, though, usually means:

- **Manual deploys.** SSH in, `git pull`, `npm ci`, `npm run build`, `pm2 restart`, for every change to every app.
- **No way back.** A broken build stays broken until someone notices and reverts by hand.
- **Fragile routing.** A hand-edited `cloudflared` config plus a hand-edited Caddyfile, where one typo on reload takes every site down.
- **Flying blind.** No history of what version is running, and no alert when an app crashes at night.

Hosted platforms fix all of this, but they charge per app, sleep free services, and move code and data off hardware you already own.

## What Homeport does

| Before | With Homeport |
|---|---|
| SSH, pull, build, restart | `git push`, then watch the build log live in the dashboard |
| Broken deploy stays broken | The last good commit is rebuilt automatically, and you get a message saying so |
| Edit tunnel YAML, add DNS, edit Caddyfile, restart | Fill in one form; DNS, tunnel ingress and Caddy update together |
| A Caddyfile typo takes all sites down | Caddy validates the generated file before it replaces the running one |
| `pm2 logs` over SSH | Logs, deploy history, metrics and alerts in one place |
| Find out from users | Discord or Telegram when an app goes down, and again when it recovers |
| One shared login, or SSH keys for everyone | People with usernames and roles: admins deploy, viewers only look (secrets masked) |
| Pick a hostname for every project | A default domain: `shop` is live at `shop.yourdomain.com`, like a Vercel project URL |
| Add Google Analytics to every app | Visitors, countries, cities, pages, sources and devices from the proxy log; no script, no cookies, no IPs stored |
| A separate uptime service | Each domain checked end to end every minute, incidents with notifications, a public status page |
| SSH in to check a deploy | Open `mac-mini.local:7070` on your Wi-Fi, your private Tailscale address from anywhere, or `deploy.yourdomain.com`, and sign in |
| Hand-written scripts for a Turborepo with submodules | Pick the package; Homeport fetches submodules, builds it with `turbo --filter` and starts Next.js on its port |

## Screenshots

| | |
|---|---|
| ![Apps with deploy history strips](docs/public/screenshots/apps.png) | ![App page with deploy history and commits](docs/public/screenshots/app-detail.png) |
| **Apps.** Each row has a strip of the last 20 deploys: green succeeded, red failed, split for rolled back. | **App page.** Deploy history with build logs, and any commit on the branch one click from production. |
| ![A failed deploy rolling back](docs/public/screenshots/deploy-log.png) | ![Monitoring with alerts and charts](docs/public/screenshots/monitoring.png) |
| **Live deploy log.** This build failed its health check and was rolled back automatically. | **Monitoring.** Prometheus alerts, request rate and latency per domain, CPU and memory per app. |
| ![Command palette](docs/public/screenshots/command-palette.png) | ![Dark theme](docs/public/screenshots/overview-dark.png) |
| **⌘K command palette** to jump to any page or app, or start a deploy. | **Night palette** taken from marine chart displays, following the system setting. |
| ![Analytics with world map](docs/public/screenshots/analytics.png) | ![Uptime with 90-day bars](docs/public/screenshots/uptime.png) |
| **Analytics.** Visitors, page views, bandwidth and p95 with change against the previous period; a world map, cities, top pages, sources and a live feed. | **Uptime.** End-to-end checks every minute, incidents, 90-day history, and a public status page. |
| ![Network](docs/public/screenshots/network.png) | ![Public status page](docs/public/screenshots/status-page.png) |
| **Network.** Throughput, latency and packet loss to Cloudflare, public IP, and which Cloudflare data centres each tunnel reaches. | **Status page** at `/status`, without sign-in, showing only the domains you pick. |
| ![Sign-in with two-factor](docs/public/screenshots/login-code.png) | ![Access page](docs/public/screenshots/access.png) |
| **Sign in from anywhere.** Password plus a TOTP code; recovery codes if the phone is gone. | **Access.** Publish the dashboard on a hostname, manage two-factor, see and sign out devices. |
| ![People and roles](docs/public/screenshots/people.png) | ![Viewer mode](docs/public/screenshots/viewer.png) |
| **People.** Usernames, admin and viewer roles, per-person two-factor. | **Viewer mode.** Read-only, with environment variables and tokens masked. |

## How it works

<img src="docs/public/diagrams/architecture.drawio.svg" alt="Architecture diagram" />

Visitors and GitHub webhooks reach Cloudflare. A `cloudflared` tunnel, dialled out from the Mac, brings every hostname to a single Caddy, which routes by Host header to each app's local port. Homeport generates all of that configuration from what you enter in the dashboard, and runs every piece under pm2. Nothing listens on a public interface.

### A deploy

<img src="docs/public/diagrams/deploy-pipeline.drawio.svg" alt="Deploy pipeline diagram" />

1. A push arrives. The webhook's HMAC-SHA256 signature and branch are checked.
2. The deploy joins the app's queue. Pushes that land during a deploy collapse into one follow-up.
3. The branch is fetched and reset hard. The package manager is detected from the lockfile (npm, pnpm, yarn, bun).
4. Install and build run in their own process group with timeouts.
5. pm2 reloads the app; the old process serves until the new one is ready.
6. Homeport waits for the port to answer. Three restarts in that window fail the deploy early.
7. On failure, the last commit that worked is rebuilt. Either way, a notification goes out.

Diagrams are `.drawio.svg` files generated by [`scripts/diagrams.ts`](scripts/diagrams.ts). GitHub renders them as images, and draw.io opens them as editable diagrams.

## Engineering highlights

Things that were harder than they looked, and how they were solved.

- **Configuration that cannot break production.** The Caddyfile, tunnel ingress, pm2 ecosystem files, Prometheus config, alert rules and Grafana dashboards are all produced by pure functions from stored state. A Caddy change is validated with `caddy validate` before it is saved, and rolled back in memory if Caddy rejects it. ([decision 4](docs/decisions/0004-generated-config.md))
- **pm2 inheriting its own identity.** Under pm2 7, every process Homeport started was registered as `homeport`, because pm2 had injected `name=homeport` into Homeport's environment and reads it back in preference to `--name`. Found on the real Mac mini, reproduced against the same pm2 version, and fixed by stripping pm2's metadata from every child environment. A regression test covers it.
- **Telling crashes from deploys.** pm2's restart counter rises on every reload, so a naive crash-loop alert fired on busy deploy days. Planned actions now open a short "expected restart" window, and only restarts outside it increment `homeport_app_crashes_total`.
- **Version-aware metrics.** `metrics { per_host }` only exists in Caddy 2.9 and newer. Homeport probes the installed Caddy once and emits the syntax it accepts.
- **Safe concurrent state.** Early versions occasionally failed a rename when several saves overlapped. Writes are now serialized and coalesced, and always go through a temp file and rename. ([decision 5](docs/decisions/0005-json-store.md))
- **One codebase, four platforms.** Homeport only drives CLIs, so macOS, Linux, Synology DSM and Docker differ in install hints and defaults, not code paths. A headless machine sets its first password with a one-time code from its own log. Homeport keeps pm2's saved process list in step with every change, so `pm2 resurrect` from launchd, systemd, DSM's Task Scheduler or the container entrypoint brings back exactly what was running. CI boots the image, sets it up from "another computer", restarts it and checks that everything came back.
- **Monitoring checked in CI.** Every PromQL expression in the dashboards and alert rules is sent to a real Prometheus in CI, and the generated config goes through `promtool check config`. Renaming a metric can't quietly break a panel. ([decision 6](docs/decisions/0006-as-code.md))
- **A public dashboard whose trust starts on the Mac.** The dashboard can be published like a hosted platform's, but only a request that is genuinely local (loopback socket, loopback `Host`, no proxy headers, which also defeats DNS rebinding) can set the first password or recover a lost one. Passwords are scrypt-hashed, two-factor is RFC 6238 TOTP with replay protection and single-use recovery codes, session tokens are stored only as hashes, and sign-in has per-address and global lockouts. An integration test drives the whole flow, from first setup through remote sign-in, code replay and password change. ([decision 7](docs/decisions/0007-public-dashboard))
- **Monorepos as first-class apps.** One repository, several apps: Homeport finds workspace packages from `pnpm-workspace.yaml` or `workspaces`, fetches git submodules, builds with `turbo run build --filter=<package>`, and starts Next.js on the assigned port even when the package's own script hardcodes another. Two apps deployed by the same push take turns at pm2's single reload slot. Verified by deploying a real Turborepo (a Next.js store and simulator kept in submodules) end to end.
- **Analytics without a tracking script.** Caddy's JSON access log and Cloudflare's location headers become visitors, countries, cities, pages, sources and devices. Unique visitors are hashed with a salt that is thrown away daily, so nobody is followed across days and no IP address is stored; only hourly counts per domain are kept. A tail reader with a saved offset survives restarts and log rotation. ([decision 8](docs/decisions/0008-privacy-first-analytics))
- **Uptime the way visitors see it.** Checks go out to `https://domain/` and come back through Cloudflare and the tunnel, so a broken DNS record or tunnel shows up, not just a dead process. Two misses open an incident and notify; the next success closes it.
- **Grafana and Prometheus behind one login.** Both stay on `127.0.0.1`; Homeport proxies them at `/grafana` and `/prometheus` after its own session check and signs the user into Grafana through auth-proxy headers (spoofed headers dropped, session cookie never forwarded), mapping Homeport roles to Grafana roles. Prometheus's reload, quit and admin endpoints are blocked on the way.
- **Small public surface.** Apps and the webhook path are public; the dashboard only if you publish it. The API binds to localhost, requires a custom header and matching Origin on every mutation (CSRF), sends a strict CSP, validates all input with Zod, and never builds shell strings from input. ([security model](docs/guide/security.md))

## Tech stack

| Layer | Choice |
|---|---|
| Server | Node 20+, TypeScript (strict), Fastify 5, Zod 4, prom-client |
| Dashboard | React 19, TanStack Query, Vite, lucide icons, hand-written CSS with design tokens, hand-rolled SVG charts |
| Runtime | pm2, Caddy, cloudflared; macOS, Linux, Synology DSM, Docker (amd64 and arm64) |
| Observability | Prometheus, Grafana, node_exporter, Discord and Telegram webhooks |
| Quality | Biome (lint and format), Vitest, `tsc` for both projects; CI also checks PromQL against Prometheus, builds and boots the Docker image, and runs the Linux installer on x86 and ARM runners |
| Docs | VitePress on GitHub Pages, architecture decision records, draw.io diagrams as code |

## Quick start

**Mac**

```bash
git clone https://github.com/DarmawanWeb/homeport-management ~/homeport
cd ~/homeport
bash setup-mac.sh          # installs Caddy, cloudflared, pm2, Prometheus, Grafana; builds and starts Homeport
# then open the printed http://mac-mini.local:7070 from any laptop or phone on your Wi-Fi
```

**Synology NAS** (Container Manager → Project, or any Docker host)

```yaml
services:
  homeport:
    image: ghcr.io/darmawanweb/homeport:latest
    network_mode: host
    restart: unless-stopped
    volumes: [./data:/data, ./apps:/apps]
```

Open `http://<nas-ip>:7070` and enter the setup code from the container log. Without Container Manager, or on any Linux box or Raspberry Pi: `bash setup-linux.sh`. See the [Synology and Linux guide](https://darmawanweb.github.io/homeport-management/guide/synology).

Moving from a hand-made Caddy or tunnel setup? `bash reset-mac.sh --dry-run` lists what it would remove, and `bash reset-mac.sh` removes it step by step after backing up the config.

The [getting started guide](https://darmawanweb.github.io/homeport-management/guide/getting-started) covers first-run setup, remote access over SSH, and keeping the Mac awake.

## Development

```bash
npm ci
npm run dev          # API on :7070 with reload
npm run dev:web      # dashboard on :5173
npm run check        # Biome
npm run typecheck
npm test
npm run docs:dev
```

```
src/shared/       types shared by server and dashboard
src/server/       Fastify app, services (deploy, caddy, cloudflared, pm2, webhooks, notify), monitoring
web/src/          React dashboard
scripts/          diagram generator, monitoring checks
docs/             VitePress site, guides, reference, decision records
```

See [development](https://darmawanweb.github.io/homeport-management/reference/development) for conventions and the CI pipeline.

## Scope

Homeport is meant for one person or a small team running trusted Node services on one machine. It is not a multi-tenant host, and apps are not isolated from each other. The [design decisions](https://darmawanweb.github.io/homeport-management/decisions/) explain why it uses pm2 instead of containers, and what that costs.

## License

[MIT](LICENSE)
