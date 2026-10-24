# Domains and tunnels

## How a request is routed

```
https://shop.example.com
  → Cloudflare edge (TLS ends here)
  → cloudflared on the Mac, over an outbound connection
  → Caddy on 127.0.0.1:8080, which matches the Host header
  → the app on 127.0.0.1:3001
```

Every hostname in a tunnel points at the same Caddy port. Caddy is the only place that knows which host goes to which app, so adding or changing a domain is a Caddy reload rather than a tunnel restart in most cases.

The **Overview** page draws this path with a status light per hop:

![Traffic route](/screenshots/overview.png)

## Tunnels

A tunnel is created once with `cloudflared tunnel create`, which stores credentials in `~/.cloudflared/<id>.json`. Homeport runs each tunnel under pm2 as `hp-cf-<name>` with:

- an ingress file generated from your domains (`data/tunnels/<name>.yml`)
- a local metrics endpoint so Prometheus can see edge connections

Because cloudflared does not reload its config, Homeport restarts a running tunnel only when its ingress file actually changed.

## Domains

A domain maps a hostname to a local host and port. Options:

- **Point DNS at the tunnel** runs `cloudflared tunnel route dns`, creating a proxied CNAME to `<tunnel-id>.cfargotunnel.com`.
- **Replace an existing DNS record** is needed when the hostname already has a record, for example one left by an old tunnel.
- **Password** adds Caddy `basic_auth`; the password is hashed with bcrypt by `caddy hash-password` and only the hash is stored.
- **Extra Caddy directives** are placed inside the site block, for headers, body limits and so on.

Domains do not have to belong to a Homeport app. Anything listening on a local port can be published, such as Home Assistant or a Grafana instance.

## Deleting DNS records

`cloudflared` can create DNS records but not delete them. With a Cloudflare API token in **Settings** (Zone DNS Edit and Zone Read), deleting a domain or tunnel also deletes its CNAME. Without one, Homeport tells you which record to remove by hand.
