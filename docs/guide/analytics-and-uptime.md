# Analytics, uptime and network

Three pages under **Observe** answer the questions a hosted platform's dashboard answers: who is visiting, is everything up, and is the connection healthy.

## Analytics

![Analytics](/screenshots/analytics.png)

Visitors, page views, requests, bandwidth, server errors and p95 response time, each compared with the previous period. Below: traffic over time, a world map, countries and cities, top pages, where visitors came from, devices, browsers, operating systems, response codes, and a live list of the latest page views. Filter by domain and by 1 hour, 24 hours, 7 or 30 days.

**How it works.** Caddy writes a JSON access log for every public domain (not for the dashboard or the webhook receiver). Homeport follows that file, remembers its read position across restarts, and folds each request into hourly counts per domain. There is no script to add to your sites and no cookie.

**Location.** Cloudflare adds the visitor's country (`CF-IPCountry`) to every request through the tunnel, so countries work from the start. For **cities and the dots on the map**, turn on a free Managed Transform once per zone:

> Cloudflare dashboard → your domain → **Rules → Settings → Managed Transforms → Add visitor location headers**

Requests from your own network show as *Local network*.

**What counts as what.**

| | Counted when |
|---|---|
| Request | Anything Caddy answered |
| Page view | A `GET` for a page (not an asset or `/api/…`) answered below 400, by a browser that is not a bot |
| Visitor | A distinct visitor ID per day (below) |
| Bot | User agents of crawlers, link previews, `curl` and similar; counted as requests only |

**Privacy.** Raw IP addresses are never stored by Homeport. A visitor ID is `sha256(daily salt + IP + user agent)`, and the salt is replaced every day and never kept, so nobody can be followed from one day to the next. This is the approach Plausible and Fathom use. Only hourly counts are written to `data/analytics/`, kept for 90 days by default (Settings → Analytics and uptime). Caddy's raw log rolls over at 20 MB and keeps two old files; it redacts cookies and authorization headers by itself.

## Uptime

![Uptime](/screenshots/uptime.png)

Every enabled domain is requested once a minute. In the default **public** mode the check goes to `https://<domain>/` from the internet side, so DNS, Cloudflare, the tunnel, Caddy and the app must all work. **Local** mode asks Caddy on the machine directly, for setups without internet or before DNS exists. Any answer below 500 counts as up.

Two failures in a row open an **incident** and send a message to Discord or Telegram; the next good check closes it and says how long it lasted. The page shows uptime over 24 hours, 7 and 30 days, response times, and a 90-day bar per domain.

### Public status page

Turn on **Public status page** on the Uptime page to publish `/status` on every address the dashboard has, for example `https://deploy.example.com/status`. It needs no sign-in and shows only the title, the domains you tick, their uptime and recent incidents.

![Status page](/screenshots/status-page.png)

## Network

![Network](/screenshots/network.png)

- **Throughput** per interface and in total, from `/proc/net/dev` on Linux and `netstat -ib` on macOS, sampled every 15 seconds.
- **Internet**: TCP connect time to Cloudflare every 30 seconds, packet loss over the last ten minutes, DNS lookup time. Three misses in a row are logged as an outage, and you get a message when it is over.
- **Public address**: the IP, country and nearest Cloudflare data centre, as Cloudflare's trace endpoint reports them. The IP is hidden until you click.
- **Tunnel connections**: how many of each tunnel's four connections are up, and which Cloudflare data centres they reach (`SIN`, `CGK`…), read from cloudflared's metrics.

The same numbers are exported to Prometheus (`homeport_network_*`, `homeport_internet_*`); see [Metrics](/reference/metrics).
