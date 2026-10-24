# Security model

Homeport runs build scripts from repositories you add, as your user, on a machine that is reachable from the internet through a tunnel. The design keeps the reachable surface as small as possible.

## What is exposed

| Listener | Address | Reachable from the internet |
|---|---|---|
| Your apps | 127.0.0.1:30xx | Yes, through Caddy, only for hostnames you added |
| Webhook receiver | 127.0.0.1:9000 | Yes, only `POST /hooks/<app-id>` via the webhook hostname |
| Dashboard and API | 127.0.0.1:7070 | Only if you publish it, and only after a password is set |
| Prometheus, Grafana, exporters | 127.0.0.1 | No |
| Caddy admin API | localhost:2019 | No |

Nothing binds to a public interface and no router ports are opened. Never add a domain that points at 9090, 3300 or 2019. The dashboard (7070) can be published from the Access page; Homeport refuses to route a domain to it until a password exists. See [Public dashboard](/guide/public-dashboard).

## Webhooks

- Each app has its own 48-character random secret.
- The raw body is checked against `X-Hub-Signature-256` with HMAC-SHA256 and a constant-time comparison. Gitea and Gogs headers are accepted too.
- Unsigned or mis-signed requests get `401` and are logged with the sender's address.
- Only `push` events to the configured branch deploy; everything else is acknowledged and ignored.
- Bodies over 25 MB are dropped.

## Dashboard API

- Bound to 127.0.0.1. Remote access goes through the tunnel and Caddy, never a public bind.
- Until a password is set, only a direct loopback request with a loopback `Host` header and no proxy headers is served. That rules out the tunnel, Caddy, the LAN and DNS rebinding.
- After that, every API call needs a session: scrypt-hashed password, optional TOTP two-factor with recovery codes, hashed session tokens in HttpOnly, SameSite=Strict, Secure cookies, and per-address plus global lockouts. Details in [Public dashboard](/guide/public-dashboard#what-protects-it).
- Every state-changing request must carry `X-Homeport: 1` and, when the browser sends one, an `Origin` matching the host. Browsers cannot add custom headers cross-site without a CORS preflight, which the server never approves (CSRF).
- Responses carry a strict Content-Security-Policy (no inline scripts), `X-Frame-Options: DENY` and HSTS over HTTPS.
- Every input is validated with Zod; hostnames, branch names, process names and ports have strict patterns.

## Commands and secrets

- Tools are run with argument arrays, not shell strings. The only shell commands are an app's own install and build commands, which come from you.
- GitHub tokens are sent to git as a per-invocation header and redacted from logs; they are not written into `.git/config`.
- API responses mask tokens and webhook secrets except where you explicitly open them.
- pm2 metadata in Homeport's own environment is stripped before starting anything, so child processes cannot inherit its identity.

## Config changes

A generated Caddyfile is validated by `caddy validate` before it replaces the running one. If Caddy rejects it, the change is rolled back in the database and the error is shown; the running config is never touched. The previous 30 Caddyfiles are kept in `data/backups/`.
