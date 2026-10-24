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

`test/generators.test.ts` covers the generators, command splitting, project detection, webhook signatures, env parsing, monitoring configs, dashboard integrity, and the child environment.

CI also checks every PromQL expression in the dashboards and alert rules against a real Prometheus.

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

1. Biome check
2. Type check
3. Unit tests
4. Build
5. Start Prometheus and validate all dashboard and alert queries, and `promtool check config` on the generated config

`.github/workflows/docs.yml` builds this site and publishes it to GitHub Pages from `main`.
