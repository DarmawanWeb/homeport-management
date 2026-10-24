# Synology NAS and Linux

Homeport runs on Linux as well as macOS: a Synology NAS, a mini PC, a VPS or a Raspberry Pi. Everything Homeport drives (pm2, Caddy, cloudflared, Prometheus) behaves the same there. There are two ways to install it.

| | Docker (Container Manager) | Native installer |
|---|---|---|
| Synology models | Plus and value series with Container Manager (x86 and ARM) | Any DSM 7 model, including ones without Container Manager |
| Other machines | Anything with Docker | Debian, Ubuntu, Raspberry Pi OS and similar |
| Installs | One container with Homeport, pm2, Caddy, cloudflared, Prometheus, node_exporter | Binaries in `~/.homeport/bin`, pm2 in `~/.local`, no root |
| Your apps run | Inside the container, Node 22 | On the machine, with its Node |
| Grafana | Not included; Homeport's own charts cover the same metrics | `--with-grafana` |
| Updates | Pull the new image, recreate the container | `git pull && bash setup-linux.sh` |

Either way the dashboard opens from your LAN at `http://<nas-ip>:7070`, and you can [publish it on a domain](/guide/public-dashboard) afterwards.

## First password: the setup code

A NAS has no screen, so the first password is set from another computer. To make sure that is you, Homeport prints a one-time **setup code** when it starts and waits for it:

```
  No dashboard password yet. Open the dashboard and set one.
  From another computer, enter this setup code:  JUB6-FQC6-PIOE-LHQI
```

The setup screen asks for it above the new password.

![Setup screen with the setup code](/screenshots/setup-nas.png)
 The code is also in the file `setup-code` in the data folder, and is deleted once the password is set. Wrong codes count towards the same lockout as wrong passwords.

## Docker with Container Manager

1. **Folders.** In File Station, create `docker/homeport/data` and `docker/homeport/apps` on a volume.
2. **Project.** Container Manager → Project → Create. Name `homeport`, path `docker/homeport`, source *Create docker-compose.yml*, and paste:

   ```yaml
   services:
     homeport:
       image: ghcr.io/darmawanweb/homeport:latest
       container_name: homeport
       network_mode: host
       restart: unless-stopped
       environment:
         TZ: Asia/Jakarta
       volumes:
         - ./data:/data
         - ./apps:/apps
   ```

3. **Start it**, then open Container → homeport → **Log** and copy the setup code.
4. Open `http://<nas-ip>:7070`, enter the code and choose a password.
5. Continue as on a Mac: **Sign in to Cloudflare**, create a tunnel, start Caddy, add apps. The Cloudflare certificate and tunnel credentials live in `data/cloudflared`.

Host networking matters: it lets Caddy, the webhook listener and each app use the NAS's ports, and lets cloudflared reach Caddy on `127.0.0.1`. DSM itself uses 80, 443, 5000 and 5001, which Homeport never touches.

**Updating:** Container Manager → Project → homeport → Action → *Build* (pulls `latest`) or, over SSH, `docker compose pull && docker compose up -d`. pm2's process list is on the data volume, so Caddy, tunnels and every app come back by themselves after an update or a NAS reboot.

**Building apps with native modules** works out of the box: the image includes `python3`, `make` and `g++`.

## Native install on DSM

1. **Package Center:** install *Node.js v20* (or newer) and *Git Server* (which provides the `git` command).
2. **Control Panel → User & Group → Advanced:** enable the user home service.
3. **Control Panel → Terminal & SNMP:** enable SSH, then connect as your admin user.
4. Install:

   ```bash
   git clone https://github.com/DarmawanWeb/homeport-management ~/homeport
   cd ~/homeport
   bash setup-linux.sh
   ```

   At the end it prints the dashboard address and the setup code.
5. **Start on boot.** The installer prints a script for DSM's Task Scheduler: Control Panel → Task Scheduler → Create → Triggered Task → User-defined script, event *Boot-up*, run as your user. It runs `pm2 resurrect`, which brings back Homeport, Caddy, tunnels and apps.

Options:

```bash
bash setup-linux.sh --with-grafana     # add Grafana (large download)
bash setup-linux.sh --no-monitoring    # skip Prometheus and node_exporter
bash setup-linux.sh --local-only       # dashboard on 127.0.0.1 only
bash setup-linux.sh --only cloudflared # install or update one tool
```

The installer picks the right build for x86_64, arm64 or armv7, checks release checksums where the project publishes them, and never needs root.

## Other Linux machines

Same steps as DSM without Package Center: install Node 20+ and git with your package manager, then run `bash setup-linux.sh`. On systemd machines it prints the one `sudo` command that starts pm2 on boot.

## Locked out

```bash
docker exec homeport npm run reset-password   # Docker
npm run reset-password                        # native, in the Homeport folder
```

A new setup code is printed when Homeport restarts.
