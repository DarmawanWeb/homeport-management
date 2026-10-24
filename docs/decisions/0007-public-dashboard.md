# 7. Public dashboard, local-first trust

**Status:** accepted

## Context

Hosted platforms are useful because their dashboard is reachable from a phone or a laptop anywhere. Homeport's dashboard was bound to localhost, which meant SSH port forwarding to check a deploy. Exposing it is risky in a specific way: whoever signs in can set an app's build command, which is arbitrary code execution on the Mac.

Options considered:

- **Bind to the LAN or 0.0.0.0 with a password.** Opens a port, and still does not help outside the house.
- **Rely on Cloudflare Access alone.** Strong, but needs a Zero Trust setup many users will not have, and leaves the app itself unauthenticated if the policy is ever removed.
- **Publish through the existing tunnel and Caddy, with Homeport's own authentication.** Reuses the routing that apps already use, and works with or without Cloudflare Access in front.

## Decision

- The dashboard stays bound to 127.0.0.1. Publishing it creates an ordinary domain that routes to it through the tunnel and Caddy.
- **Trust is anchored on the machine.** A request counts as local only with a loopback socket, a loopback `Host` and no proxy headers. Before a password exists, remote requests are refused and Homeport will not route a domain to the dashboard. The first password can be set locally, or from another computer with a one-time setup code that Homeport prints to its log and writes to a mode-600 file. Reading either already requires access to the machine, which is what a NAS or container owner has and an attacker on the LAN does not. Recovery (`npm run reset-password`) also needs that access.
- Credentials: scrypt password hash, optional TOTP with replay protection and hashed recovery codes. Sessions are random tokens stored as hashes, in HttpOnly SameSite=Strict cookies, Secure over HTTPS.
- Brute force: per-address exponential lockout and a global failure budget that pauses remote sign-ins but never the Mac's own.
- Auth state lives in `data/auth.json` (mode 600), separate from `db.json`, so backups and exports never carry it.

## Consequences

- The dashboard behaves like a hosted one, with no open ports and no extra service to run.
- A lost password or phone needs physical or SSH access to the Mac. That is deliberate.
- A distributed guessing attack can lock remote sign-in for up to ten minutes at a time. The Mac can always sign in, and Cloudflare Access in front removes the problem entirely.
- Grafana and Prometheus remain local-only; only Homeport's own monitoring views are reachable remotely.
