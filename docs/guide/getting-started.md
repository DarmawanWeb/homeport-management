# Getting started

::: tip Not on a Mac?
On a Synology NAS, a Linux server or a Raspberry Pi, follow [Synology NAS and Linux](/guide/synology) instead, then come back for *First run*.
:::

## Requirements

- macOS on Apple Silicon or Intel (Linux works too; the setup script is macOS-only)
- [Homebrew](https://brew.sh)
- Node.js 20 or newer
- A domain on a Cloudflare account

## Install

```bash
git clone https://github.com/DarmawanWeb/homeport-management ~/homeport
cd ~/homeport
bash setup-mac.sh
```

The script is safe to run again; it is also how you update:

1. Installs `git`, `caddy`, `cloudflared`, `prometheus`, `grafana` and `node_exporter` with Homebrew (`--no-monitoring` skips the last three).
2. Stops any `brew services` copies of those tools, because Homeport runs them under pm2.
3. Installs pm2 and pm2-logrotate.
4. Builds Homeport and starts it under pm2 as `homeport`.
5. Prints the one `sudo` command that makes pm2 start at boot.

To update later:

```bash
cd ~/homeport && git pull && bash setup-mac.sh
```

## Already have Caddy or a tunnel?

`reset-mac.sh` removes an existing hand-made setup so it does not fight with Homeport. It shows what it found first and asks before every step:

```bash
bash reset-mac.sh --dry-run
bash reset-mac.sh
```

Old config files are archived to `~/homeport-reset-backup-*.tgz`.

## Open the dashboard

The dashboard only listens on `127.0.0.1:7070`. On the Mac itself, open <http://127.0.0.1:7070>. From another computer, forward the port over SSH and open <http://localhost:17070>:

```bash
ssh -N -L 17070:127.0.0.1:7070 you@mac-mini.local
```

The first visit asks you to **set a dashboard password**. This only works on the Mac or through an SSH forward like the one above, never through a public hostname. Later you can [publish the dashboard](/guide/public-dashboard) on a domain of your own and open it from anywhere.

## First run

The dashboard shows what is missing at the top of each page. In order:

1. **Sign in to Cloudflare.** Over SSH, run `cloudflared tunnel login` and open the printed link on any browser.
2. **Tunnels, Create tunnel.** One tunnel is enough for every domain.
3. **Services, Start Caddy.**
4. **Settings, Webhooks.** Enter a public hostname such as `hooks.example.com` and select *Create domain*.
5. **Apps, Add app.** Paste a repository URL.

## Keep the Mac awake

```bash
sudo pmset -a sleep 0 disksleep 0 autorestart 1 womp 1
```

pm2 on macOS starts as a LaunchAgent, which runs when the user session starts. Turn on *Automatically log in* for that user in System Settings so apps come back after a power cut.
