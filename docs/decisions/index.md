# Design decisions

Short records of the choices that shaped Homeport, the alternatives considered, and what each choice costs. They are written for someone deciding whether Homeport fits their setup, or wanting to change it.

| | Decision | In one line |
|---|---|---|
| 1 | [pm2 instead of containers](/decisions/0001-pm2-not-containers) | Docker on macOS runs in a VM; for Node apps pm2 gives restarts and logs without one |
| 2 | [Cloudflare Tunnel, no open ports](/decisions/0002-cloudflare-tunnel) | Outbound-only connectivity, TLS and DNS handled at the edge |
| 3 | [One Caddy in front of everything](/decisions/0003-single-caddy) | Tunnels never need to know about apps; routing changes are reloads |
| 4 | [Generate config, validate, then swap](/decisions/0004-generated-config) | No hand-edited config, and a typo can never reach the running proxy |
| 5 | [A JSON file as the database](/decisions/0005-json-store) | Tens of records, one writer, human-readable backups |
| 6 | [Dashboards and diagrams as code](/decisions/0006-as-code) | Generated from the same source as the metrics, so they cannot drift |
