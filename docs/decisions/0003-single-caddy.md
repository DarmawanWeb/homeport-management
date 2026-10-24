# 3. One Caddy in front of everything

**Status:** accepted

## Context

cloudflared can route each hostname straight to a local port, which is how a hand-written tunnel config usually looks. But every change then needs a tunnel restart, which drops in-flight requests for every site on that tunnel, and per-site features like basic auth, compression or custom headers are not available.

## Decision

Every hostname in every tunnel points at one Caddy on `127.0.0.1:8080`. Caddy routes by Host header to each app's port. Homeport generates the Caddyfile and reloads Caddy through its admin API.

## Consequences

- Changing which port a domain reaches, or adding auth or headers, is a graceful Caddy reload. The tunnel restarts only when the set of hostnames it carries changes.
- Caddy's metrics give request rate, status codes and latency per hostname for free.
- Caddy's own HTTPS is turned off (`auto_https off`), since TLS ends at Cloudflare.
- Caddy is a single point of failure on the machine; it runs under pm2 like everything else, and the `CaddyDown` alert covers it.
