# Security model

Homeport runs build scripts from repositories you add, as your user, on a machine that is reachable from the internet through a tunnel. The design keeps the reachable surface as small as possible.

## What is exposed

| Listener | Address | Reachable from the internet |
|---|---|---|
| Your apps | 127.0.0.1:30xx | Yes, through Caddy, only for hostnames you added |
| Webhook receiver | 127.0.0.1:9000 | Yes, only `POST /hooks/<app-id>` via the webhook hostname |
| Dashboard and API | 127.0.0.1:7070 | No |
| Prometheus, Grafana, exporters | 127.0.0.1 | No |
| Caddy admin API | localhost:2019 | No |

Nothing binds to a public interface and no router ports are opened. Never add a domain that points at 7070, 9090, 3300 or 2019.

## Webhooks

- Each app has its own 48-character random secret.
- The raw body is checked against `X-Hub-Signature-256` with HMAC-SHA256 and a constant-time comparison. Gitea and Gogs headers are accepted too.
- Unsigned or mis-signed requests get `401` and are logged with the sender's address.
- Only `push` events to the configured branch deploy; everything else is acknowledged and ignored.
- Bodies over 25 MB are dropped.

## Dashboard API

- Bound to 127.0.0.1 by default.
- Every state-changing request must carry `X-Homeport: 1`. Browsers cannot add custom headers to cross-site requests without a CORS preflight, which the server never approves, so another tab cannot drive the API (CSRF).
- Optional password (`TM_PASSWORD`) with an HttpOnly, SameSite=Strict session cookie and a constant-time comparison. Required if you bind to anything other than localhost.
- Every input is validated with Zod; hostnames, branch names, process names and ports have strict patterns.

## Commands and secrets

- Tools are run with argument arrays, not shell strings. The only shell commands are an app's own install and build commands, which come from you.
- GitHub tokens are sent to git as a per-invocation header and redacted from logs; they are not written into `.git/config`.
- API responses mask tokens and webhook secrets except where you explicitly open them.
- pm2 metadata in Homeport's own environment is stripped before starting anything, so child processes cannot inherit its identity.

## Config changes

A generated Caddyfile is validated by `caddy validate` before it replaces the running one. If Caddy rejects it, the change is rolled back in the database and the error is shown; the running config is never touched. The previous 30 Caddyfiles are kept in `data/backups/`.
