# 4. Generate config, validate, then swap

**Status:** accepted

## Context

Hand-edited Caddyfiles and tunnel YAML drift from what the operator thinks is running, and a single syntax error on reload can take every site down at once.

## Decision

Homeport owns the Caddyfile, every tunnel's ingress file, every app's pm2 ecosystem file and the monitoring configuration. They are produced by pure functions from the stored state. Before a Caddy change is saved, the complete new Caddyfile is written to a scratch file and checked with `caddy validate`; if Caddy rejects it, the state change is rolled back and the error is returned.

## Consequences

- What the dashboard shows is what is running. The *Caddyfile* page compares the generated and live files.
- Generators are pure and covered by unit tests.
- A bad custom directive is caught before it ships, with Caddy's own error message.
- Hand edits to generated files are overwritten. Escape hatches exist for Caddy (global options and raw blocks in Settings, extra directives per domain), and all of them pass through the same validation.
- The installed Caddy version is probed once to choose the right metrics syntax, since `metrics { per_host }` only exists from 2.9.
