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

## Start over

To wipe Homeport and install it fresh, with no apps, history or caches left behind:

```bash
bash reset-mac.sh --full --dry-run   # list what would go
bash reset-mac.sh --reinstall        # remove everything, then run setup-mac.sh
```

`--full` stops Homeport and removes, after asking at each step:

- every app in Homeport: its pm2 process and logs, and its checkout in `~/apps` with `node_modules` and build caches
- Homeport's data folder: apps, domains, users and two-factor, deploy history, metrics. The settings are archived to `~/homeport-data-backup-*.tgz` first
- Homeport's own `dist` and `node_modules`
- the npm, pnpm and corepack download caches
- everything the plain reset removes (Caddy, tunnels, old config)

Files in `~/apps` that Homeport did not deploy are only deleted if you say yes, never with `--yes`. Homebrew packages, pm2 and the cloudflared login stay.

To remove a single app instead, use **Delete app** on the Apps page or the app's page. It removes the pm2 process and its logs and the deploy history, and by default the checkout too.

## Open the dashboard

A Mac mini used as a server usually has no screen or keyboard, so `setup-mac.sh` opens the dashboard to your local network on the first install and prints where to find it:

```
✓ Done. Open Homeport from any device on your network:
    http://mac-mini.local:7070
    http://192.168.1.20:7070

  First visit: set a dashboard password. From another device, enter this setup code:
    JUB6-FQC6-PIOE-LHQI
```

Open either address from a laptop or phone on the same Wi-Fi or LAN. The first visit asks for the **setup code** and a new **dashboard password**; after that, every device signs in with the password. Lost the code? Over SSH, run `pm2 logs homeport` or `cat ~/homeport/data/setup-code`.

The `.local` name works on Macs, iPhones and most PCs without any setup. If it does not resolve, use the IP address, and consider a DHCP reservation in your router so it never changes.

**Firewall.** If the macOS firewall is on, it would show an "allow incoming connections" prompt that nobody can click. The installer and the Access page print the command that allows Node once, over SSH.

**This Mac only.** To keep the dashboard on `127.0.0.1`, run `bash setup-mac.sh --local-only`, or use **Access → Local network → Limit to this machine**. You can then still reach it through an SSH tunnel:

```bash
ssh -N -L 17070:127.0.0.1:7070 you@mac-mini.local   # then open http://localhost:17070
```

The choice is saved in `data/network.json`, so it survives restarts, reboots and re-running the installer. Later you can also [publish the dashboard](/guide/public-dashboard) on a domain and open it from anywhere.

![Local network on the Access page](/screenshots/access-lan.png)

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
