# Troubleshooting

Start at **Overview**. The traffic route lights the first broken hop in red; work from left to right.

## Deploys

**"The app did not start listening on port 30xx"**
The app ignores `process.env.PORT`, or crashes on start. The last 40 lines of its log are at the end of the deploy log.

**`npm: command not found` during install**
pm2 was started from an environment without Homebrew on `PATH`. Run `pm2 kill && pm2 resurrect` from a normal Terminal window.

**`npm ci` fails with "can only install with an existing package-lock.json"**
The repository has no lockfile. Commit one, or set the install command to `npm install` in the app settings.

**A push did not deploy**
Check GitHub, repository Settings, Webhooks, Recent Deliveries. A `401` means the secret differs or the content type is not `application/json`. A `202` with `ignored` names the reason, such as a different branch.

## Domains

**Caddy answers "Homeport: unknown host" (404)**
The hostname is not in **Domains**, or the latest change has not been applied. Open **Caddyfile** and select *Apply and reload*.

**Cloudflare error 1033**
The tunnel is not running or not connected. **Tunnels**, then Start or Restart, then check its logs.

**"An A, AAAA, or CNAME record with that host already exists"**
Edit the domain and turn on *Replace an existing DNS record*.

## Processes

**Everything restarted with the name `homeport`**
Fixed in 3.1.0. Older versions inherited pm2's own environment, and pm2 7 read the inherited `name` instead of `--name`. Update, then remove the extra entries with `pm2 delete <id>`.

**Apps show as stopped, or "could not parse pm2 output"**
pm2 was upgraded without restarting its daemon, so it prints *In-memory PM2 is out-of-date*. Homeport copes with that since 3.7.0, but run `pm2 update` once to clear it.

**"Reload already in progress"**
pm2 runs one reload at a time. Since 3.7.0 Homeport queues its own reloads and retries if something else is reloading; on older versions, deploy again.

**A monorepo package builds but `next start` warns about `output: standalone`**
Harmless. The app is served by `next start`; the standalone output is only used by Docker images.

**Port already in use when starting Caddy or Grafana**
Another copy runs as a Homebrew service. `brew services stop caddy grafana prometheus node_exporter`.

**Grafana: "Could not find the Grafana install folder"**
Set *Grafana home* in **Settings, Monitoring** to `/opt/homebrew/opt/grafana/share/grafana`.

## Getting more detail

- **Activity log** lists every command Homeport ran and its output.
- `pm2 logs homeport` shows the server's own log.
- `data/deploy-logs/<id>.log` holds each deploy's full output.
