# Why Homeport

## The problem

A Mac mini is a very good small server: quiet, cheap to run, fast enough for a handful of Node apps, and already sitting on a desk. Hosting on it usually turns into a pile of manual steps:

- `git pull`, `npm install`, `npm run build`, `pm2 restart` over SSH for every change.
- A hand-edited `~/.cloudflared/config.yml` that has to be restarted after every new hostname.
- A Caddyfile edited in place, where one typo takes every site down on reload.
- No record of what version is running, and no way back when a deploy breaks.
- Nothing tells you when an app crashes at 3 a.m.

Hosted platforms solve this, but they cost money per app, sleep free-tier services, and move your code and data off a machine you already own.

## What Homeport does

Homeport is one Node process that turns the Mac mini into a tiny platform:

| Without Homeport | With Homeport |
|---|---|
| SSH in, pull, build, restart | `git push`, watch the build log in the dashboard |
| Broken deploy stays broken | Last good commit is rebuilt automatically |
| Edit cloudflared YAML, restart, add DNS by hand | Add a domain in a form; DNS, ingress and Caddy update together |
| Caddyfile typo takes all sites down | Caddy validates the generated file before anything changes |
| `pm2 logs` over SSH | Logs, deploy history, metrics and alerts in one place |
| Find out from users | Discord or Telegram message when an app goes down, and when it recovers |

## Who it is for

One person or a small team running several Node services on one Apple Silicon machine at home or in an office, reachable on their own domain through Cloudflare. It is deliberately not a cluster scheduler, a multi-tenant PaaS, or a container platform; see [the design decisions](/decisions/) for why.

## How it fits together

![Architecture](/diagrams/architecture.drawio.svg)

The rest of this guide walks through [installing it](/guide/getting-started), [deploying an app](/guide/deploying-apps), and [what happens to a request](/reference/architecture).
