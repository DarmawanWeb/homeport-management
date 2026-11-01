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

A domain maps a hostname to a local host and port. The hostname can be a root domain (`example.com`) or any subdomain (`edu.example.com`, `edu-sim.example.com`). Add one when creating an app, from **Add domain** on the app's page, or on the Domains page. Options:

- **Point DNS at the tunnel** creates a proxied CNAME to `<tunnel-id>.cfargotunnel.com`. A CNAME on a root domain works because Cloudflare flattens it.
- **Replace an existing DNS record** is needed when the hostname already has a record, for example one left by Vercel or an old tunnel. Without it, Homeport stops and says which record is in the way.
- **Also add www** appears for a root domain and serves `www.example.com` from the same app. To keep a single address, add a Cloudflare redirect rule from `www` to the root domain.
- **Password** adds Caddy `basic_auth`; the password is hashed with bcrypt by `caddy hash-password` and only the hash is stored.
- **Extra Caddy directives** are placed inside the site block, for headers, body limits and so on.

## More than one domain

`cloudflared tunnel login` signs cloudflared in to a single zone (`cert.pem`), and `cloudflared tunnel route dns` can only make records in that zone: for `shop.other.com` it would make `shop.other.com.first.com`. Homeport notices this and stops with a message instead.

To use several domains, add a Cloudflare API token in **Settings** with **Zone, DNS, Edit** and **Zone, Zone, Read** for all zones. Homeport then makes every DNS record over the API, in whichever zone the hostname belongs to, and cloudflared's login only matters for creating tunnels. A domain you just bought must be added to Cloudflare, and its nameservers changed at the registrar, before Homeport can point it at a tunnel.
- **Password** adds Caddy `basic_auth`; the password is hashed with bcrypt by `caddy hash-password` and only the hash is stored.
- **Extra Caddy directives** are placed inside the site block, for headers, body limits and so on.

Domains do not have to belong to a Homeport app. Anything listening on a local port can be published, such as Home Assistant or a Grafana instance.

## Deleting DNS records

`cloudflared` can create DNS records but not delete them. With a Cloudflare API token in **Settings** (Zone DNS Edit and Zone Read), deleting a domain or tunnel also deletes its CNAME. Without one, Homeport tells you which record to remove by hand.
