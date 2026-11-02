---
layout: home
hero:
  name: Homeport
  text: Deploy Node apps to the computer under your desk.
  tagline: Push to GitHub and your Mac mini, Linux box or Synology NAS builds, starts and checks the app. Automatic rollback, domains through Cloudflare Tunnel, and monitoring, all from one dashboard.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why Homeport
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/DarmawanWeb/homeport-management
features:
  - title: Deploy on push
    details: A GitHub webhook (HMAC verified) or a polling timer triggers clone, install, build and a pm2 reload. The old process keeps serving until the new one answers on its port.
  - title: Automatic rollback
    details: If a build fails or the app never comes up, Homeport rebuilds the last commit that worked and tells you on Discord or Telegram.
  - title: No open ports
    details: Traffic arrives through an outbound Cloudflare Tunnel, and one Caddy routes every hostname to its local port. Nothing listens on the internet.
  - title: Config checked before it goes live
    details: The Caddyfile and tunnel routes are generated from your domains and validated by Caddy before they replace what is running.
  - title: Monitoring built in
    details: Prometheus, eleven alert rules, two provisioned Grafana dashboards, uptime checks, and analytics read from the proxy log.
  - title: Open it from anywhere
    details: Local network by default, Tailscale or a public hostname when you need it, with usernames, roles and two-factor sign-in.
---

<figure class="home-shot">
  <img class="on-light" src="/screenshots/overview.png" alt="The Homeport overview: the route from visitors through Cloudflare, the tunnel and Caddy to each app, with a status light per hop, and the machine's load below" />
  <img class="on-dark" src="/screenshots/overview-dark.png" alt="The same overview in the dark theme" />
</figure>

