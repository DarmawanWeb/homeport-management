# 2. Cloudflare Tunnel, no open ports

**Status:** accepted

## Context

Home and office connections often sit behind CGNAT, change their public IP, or belong to someone who does not want router ports opened. Serving HTTPS directly would also mean certificate management and exposing the machine's IP.

## Decision

All public traffic, including GitHub webhooks, arrives through `cloudflared` tunnels that dial out to Cloudflare. Nothing on the Mac listens on a public interface. TLS terminates at Cloudflare; the hop from cloudflared to Caddy is plain HTTP on localhost.

## Consequences

- Works behind CGNAT and dynamic IPs; no router changes, no certificates on the machine.
- Cloudflare's DDoS protection and caching sit in front of every app.
- A Cloudflare account and a domain on it are required, and Cloudflare can see the traffic. For a private service, Cloudflare Access can add login in front without any change to Homeport.
- cloudflared does not reload its configuration, so a routing change means a tunnel restart. [Decision 3](/decisions/0003-single-caddy) keeps those restarts rare.
