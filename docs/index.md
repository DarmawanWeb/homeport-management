---
layout: home
hero:
  name: Homeport
  text: Push to GitHub, it runs on the Mac mini under your desk.
  tagline: A small, self-hosted deploy platform for Node apps. Git push deploys with automatic rollback, domains through Cloudflare Tunnel, and Prometheus monitoring, managed from one local dashboard.
  image:
    src: /favicon.svg
    alt: Homeport
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why it exists
      link: /guide/introduction
    - theme: alt
      text: GitHub
      link: https://github.com/DarmawanWeb/homeport-management
features:
  - title: Deploy on push
    details: A GitHub webhook (HMAC verified) or a polling timer triggers clone, install, build and a pm2 reload. The old process keeps serving until the new one answers on its port.
  - title: Rollback without thinking about it
    details: If a build fails or the app never comes up, Homeport rebuilds the last commit that worked and tells you on Discord or Telegram.
  - title: No open ports
    details: Traffic arrives through an outbound Cloudflare Tunnel, and one Caddy routes every hostname to its local port. Nothing listens on the internet.
  - title: Config you can trust
    details: The Caddyfile and tunnel routes are generated from your domains and validated by Caddy before they replace what is running.
  - title: Observability included
    details: A Prometheus exporter, eleven alert rules, two provisioned Grafana dashboards, and charts built into the dashboard itself.
  - title: Typed end to end
    details: Fastify and Zod on the server, React and TanStack Query in the browser, sharing one set of TypeScript types. Linted with Biome, tested with Vitest.
---
