# Deploying apps

![Apps](/screenshots/apps.png)

## Add an app

**Apps, Add app** asks for a repository, a branch and a port. Homeport picks the next free port starting at 3001; it reaches the app as the `PORT` environment variable.

::: warning The one requirement
The app must listen on `process.env.PORT`. Next.js, Nuxt, Remix, Astro's Node adapter, NestJS and most Express templates already do.
:::

Optionally add a domain and pick a tunnel; the DNS record, Caddy route and tunnel ingress are created in the same step.

## What a deploy does

![Deploy pipeline](/diagrams/deploy-pipeline.drawio.svg)

1. **Fetch.** First deploy clones into `~/apps/<name>`. Later deploys fetch the branch and `git reset --hard` to it, so local edits on the server never block a deploy. Git submodules are fetched too.
2. **Install.** Detected from the lockfile: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` or `bun install`. `NODE_ENV` is unset here so dev dependencies needed for the build are installed.
3. **Build.** `<pm> run build` if `package.json` has a build script; for a monorepo package, `turbo run build --filter=<package>` (see below).
4. **Run.** Homeport writes a pm2 ecosystem file and runs `pm2 reload`. The previous process keeps serving until the new one is up.
5. **Check health.** The deploy waits (40 seconds by default) for the port to accept connections. Three restarts in that window count as a crash loop and fail the deploy early.

Every step streams into the deploy log, readable live from the dashboard.

Commands can be overridden per app under **Settings**. Enter a single dash to skip a step, for example for an app without a build.

## Shipping new commits

| Mode | How | When to use |
|---|---|---|
| Webhook | GitHub posts to `https://hooks.example.com/hooks/<app-id>`; Homeport verifies the HMAC signature | Default. Deploys within seconds of a push. |
| Polling | `git ls-remote` on a timer, 30 seconds minimum | No public webhook hostname, or a Git host without webhooks |
| Manual | Only the Deploy button | Production apps you want to release by hand |

The **Auto-deploy** tab of an app shows the payload URL and secret to paste into GitHub, plus a link straight to the repository's webhook settings.

Pushes that arrive during a deploy collapse into one follow-up deploy of the newest commit; intermediate commits are marked as superseded.

## Rollback

When a deploy fails and **Roll back automatically** is on (the default), Homeport checks out the last commit that deployed successfully, rebuilds it and starts it again. The deploy is recorded as failed and rolled back, and a notification says which commit is running.

To go back or forward by hand, open the **Deploys** tab and select **Deploy this** next to any commit on the branch.

## Monorepos and submodules

One repository can hold several apps: a Turborepo, or pnpm, npm, yarn or bun workspaces. Add one Homeport app per app in the repository, all with the same repository URL, and set **Package (monorepos)** to the package to run, by name (`@acme/web`) or folder (`apps/web`). Homeport then:

- installs once at the repository root, with the lockfile's package manager (through corepack, or `npx` if the machine has no corepack);
- builds only that package and what it depends on: `turbo run build --filter=<package>` when there is a `turbo.json`, otherwise the workspace's own filter (`pnpm --filter`, `npm --workspace`, `yarn workspace`);
- starts it from the package's folder. Next.js is started as `next start --port <port>`, so a `start` script that hardcodes a port (`next start --port 3000`) does not matter.

If the apps live in **git submodules**, every deploy runs `git submodule update --init --recursive`. By default the submodules are deployed at the commits the repository pins, so a deploy happens when you bump them in the main repository. Choose **Latest on their branch** to always take the newest commit of each submodule. A GitHub token on the app is used for private submodules on github.com too.

Each app has its own webhook: add both to the repository on GitHub. A push then deploys both; Homeport lets them take turns at the pm2 reload step, which pm2 only allows one at a time.

**Example: DCTEdu** (a Turborepo with the store and the simulator as submodules)

| | Store | Simulator |
|---|---|---|
| Repository | `https://github.com/DarmawanWeb/DCTEdu` | same |
| Package | `@dctedu/store` | `@dctedu/simulator` |
| Domain | `store.example.com` | `simulator.example.com` |
| Environment | `NEXT_PUBLIC_STORE_URL`, `NEXT_PUBLIC_SIMULATOR_URL`, `NEXT_PUBLIC_WHATSAPP_NUMBER`… | same |

`NEXT_PUBLIC_*` values are baked in at build time; Turborepo passes them through because the repository's `turbo.json` lists them. Change one, then redeploy.

## Private repositories

- **HTTPS:** a fine-grained GitHub token with read access to contents. It is passed to git per command and never written to `.git/config`.
- **SSH:** use a `git@github.com:owner/repo.git` URL. The pm2 user needs an SSH key that GitHub accepts; check with `ssh -T git@github.com`.

## Environment variables

One `KEY=value` per line in the app settings. They are written into the pm2 ecosystem file; changing them restarts the running build without rebuilding. A `.env` file inside the repository still works if the app loads it itself.
