# Development

```bash
npm ci
npm run dev        # API on :7070 with reload (tsx watch)
npm run dev:web    # UI on :5173, proxying /api to :7070
```

The server needs `caddy`, `cloudflared` and `pm2` on `PATH` for most features, but starts without them; the dashboard shows what is missing.

## Scripts

| Script | What it does |
|---|---|
| `npm run check` | Biome lint and format check |
| `npm run fix` | Biome with safe fixes applied |
| `npm run typecheck` | `tsc` for server and web projects |
| `npm test` | Vitest unit tests |
| `npm run build` | Compile the server to `dist/server`, bundle the UI to `dist/web` |
| `npm run diagrams` | Regenerate the `.drawio.svg` diagrams |
| `npm run docs:dev` / `docs:build` | This documentation site |

## Conventions

- **Biome** is the only linter and formatter: two-space indent, single quotes, 140 columns. CI fails on any diagnostic.
- **Types first.** Shapes shared with the browser live in `src/shared/types.ts`. Inputs are parsed with Zod at the edge; services receive typed values.
- **Generators are pure.** `generateCaddyfile`, `generateIngress`, `generateEcosystem` and the dashboard builders take data and return text, so they are unit tested without touching the system.
- **Never shell out with user strings.** `run()` takes an argument array. The only shell strings are an app's own install and build commands.
- **Strip inherited process metadata.** Anything spawned goes through `childEnv()`, which removes pm2's variables from Homeport's own environment.

## Tests

Vitest covers the parts that can be checked without touching the machine:

| File | What it covers |
|---|---|
| `generators.test.ts` | Caddyfile, tunnel ingress and pm2 ecosystem generators, command splitting, webhook signatures, env parsing, monitoring configs, dashboard integrity, the child environment |
| `project.test.ts` | Package manager and monorepo detection, Turborepo filters, Next.js start commands, Tailscale status |
| `domains.test.ts`, `cloudflare-dns.test.ts` | Zone matching for any hostname, the cloudflared route parser, DNS upserts against a mocked Cloudflare API |
| `auth.test.ts`, `auth-flow.test.ts`, `users.test.ts` | Passwords, TOTP, sessions, lockouts, the whole sign-in flow, people and roles |
| `proxy.test.ts` | The Grafana and Prometheus proxies behind the sign-in |
| `network.test.ts`, `observe.test.ts`, `platform.test.ts` | Network checks, analytics and uptime, platform defaults |

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. **Lint, types, tests, build:** Biome, `tsc` for both projects, Vitest, the production build, and a syntax check of the shell scripts.
2. **Prometheus:** generates the config, runs `promtool check config`, and sends every PromQL expression from the dashboards and alert rules to a real Prometheus.
3. **Docs:** builds this site and checks that the diagrams match `scripts/diagrams.ts`.
4. **Docker image:** builds the image, starts it, completes the first setup with the code from the container log, restarts it and checks that everything came back.
5. **Linux installer:** runs `setup-linux.sh` on x86 and ARM runners, sets up from another address, then kills pm2 and resurrects it as a reboot would.

`.github/workflows/docker.yml` publishes the image to the GitHub Container Registry, and `.github/workflows/docs.yml` publishes this site to GitHub Pages from `main`.
