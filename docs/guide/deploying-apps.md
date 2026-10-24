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

1. **Fetch.** First deploy clones into `~/apps/<name>`. Later deploys fetch the branch and `git reset --hard` to it, so local edits on the server never block a deploy.
2. **Install.** Detected from the lockfile: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` or `bun install`. `NODE_ENV` is unset here so dev dependencies needed for the build are installed.
3. **Build.** `<pm> run build` if `package.json` has a build script.
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

## Private repositories

- **HTTPS:** a fine-grained GitHub token with read access to contents. It is passed to git per command and never written to `.git/config`.
- **SSH:** use a `git@github.com:owner/repo.git` URL. The pm2 user needs an SSH key that GitHub accepts; check with `ssh -T git@github.com`.

## Environment variables

One `KEY=value` per line in the app settings. They are written into the pm2 ecosystem file; changing them restarts the running build without rebuilding. A `.env` file inside the repository still works if the app loads it itself.
