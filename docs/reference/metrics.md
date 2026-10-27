# Metrics

Homeport serves Prometheus metrics on `127.0.0.1:9101/metrics`. Values are refreshed on every scrape.

## Apps and processes

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `homeport_app_up` | gauge | app | 1 when the pm2 process is online and its port accepts connections |
| `homeport_app_deploying` | gauge | app | 1 while a deploy runs |
| `homeport_app_info` | gauge | app, branch, commit | Running commit (value always 1) |
| `homeport_app_last_deploy_timestamp_seconds` | gauge | app | When the last deploy finished |
| `homeport_app_last_deploy_success` | gauge | app | 1 if it succeeded |
| `homeport_app_crashes_total` | counter | app | pm2 restarts not caused by a deploy or manual action |
| `homeport_process_online` | gauge | name, kind | Every pm2 process; kind is `app`, `system` or `other` |
| `homeport_process_cpu_percent` | gauge | name, kind | |
| `homeport_process_memory_bytes` | gauge | name, kind | Resident memory |
| `homeport_process_restarts` | gauge | name, kind | pm2's raw counter, planned restarts included |
| `homeport_process_uptime_seconds` | gauge | name, kind | |

## Deploys and webhooks

| Metric | Type | Labels |
|---|---|---|
| `homeport_deploys_total` | counter | app, status, trigger |
| `homeport_deploy_duration_seconds` | histogram | app |
| `homeport_webhooks_total` | counter | app, result (`deployed`, `ignored`, `bad_signature`, `ping`) |

## Routing

| Metric | Type | Labels |
|---|---|---|
| `homeport_site_enabled` | gauge | host |
| `homeport_site_upstream_up` | gauge | host, app |
| `homeport_tunnel_running` | gauge | tunnel |

## Host

`homeport_host_cpu_usage_ratio`, `homeport_host_memory_used_bytes` (excludes reclaimable cache; read from `vm_stat` on macOS), `homeport_host_memory_total_bytes`, `homeport_host_load{period}`, `homeport_host_cpu_count`, `homeport_host_disk_total_bytes`, `homeport_host_disk_available_bytes` (the volume holding the apps folder).

## Network

| Metric | Type | Labels |
|---|---|---|
| `homeport_network_receive_bytes_total` | gauge (counter value) | iface |
| `homeport_network_transmit_bytes_total` | gauge (counter value) | iface |
| `homeport_internet_up` | gauge | |
| `homeport_internet_latency_seconds` | gauge | |

## Scraped from other components

- **Caddy** at its admin address: `caddy_http_requests_total`, `caddy_http_request_duration_seconds` and friends, labelled by `host` on Caddy 2.9 and newer.
- **cloudflared** per tunnel: `cloudflared_tunnel_ha_connections`, `cloudflared_tunnel_total_requests`, `cloudflared_tunnel_request_errors`.
- **node_exporter**: the usual `node_*` series.

## Example queries

```txt
# apps that are down right now, ignoring ones being deployed
homeport_app_up == 0 unless on(app) homeport_app_deploying == 1

# error rate by hostname
sum by (host) (rate(caddy_http_requests_total{code=~"5.."}[5m]))
  / sum by (host) (rate(caddy_http_requests_total[5m]))

# median deploy time per app over a day
histogram_quantile(0.5, sum by (le, app) (rate(homeport_deploy_duration_seconds_bucket[1d])))
```
