# 8. Analytics from the proxy log, privacy first

**Status:** accepted

## Context

People who host on Vercel or Netlify expect visitor numbers next to their deploys. The usual options are a client-side script (Google Analytics, Plausible) or a hosted service, which means changing every app, sending visitors' data elsewhere, and showing cookie banners.

Every request already passes through Caddy, and through Cloudflare, which tells Caddy the visitor's country and, if asked, city.

## Decision

- Read analytics from Caddy's JSON access log. No change to apps, no script, no cookie, and it also counts API and asset traffic, errors and latency.
- Take location from Cloudflare's headers (`CF-IPCountry`, and the free "visitor location headers" transform for city and coordinates). No GeoIP database to ship or update.
- Count unique visitors with a hash of a daily salt, the IP and the user agent; drop the salt every day. Store only hourly aggregates per host.
- Keep the last few minutes and the latest page views in memory for the live view; they are not persisted.

## Consequences

- Works for any app on any stack, from the first request, including traffic that never runs JavaScript.
- Unique visitors over several days are the sum of daily uniques, so someone visiting on three days counts three times. That is the price of not tracking people across days.
- Numbers differ from a client-side tool: bots that run JavaScript are counted there and filtered here, and prefetches or cached pages behave differently.
- Caddy's raw log does contain IP addresses until it rolls over; it lives in the data folder with the rest of Homeport's state.
