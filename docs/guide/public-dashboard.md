# Public dashboard

Homeport can be opened from anywhere, the way you would open a hosted platform's dashboard, while still running on the Mac. There are two ways, both without opening router ports:

| | Tailscale (private) | Public hostname (Cloudflare Tunnel) |
|---|---|---|
| Address | `https://mac-mini.<tailnet>.ts.net` | `https://deploy.example.com` |
| Who can reach the sign-in page | Only devices signed in to your Tailscale account | Anyone on the internet |
| Needs | Tailscale on the Mac and on your phone or laptop | A domain on Cloudflare and a tunnel (you already have both for your apps) |
| Recommended for | Managing the machine | Sharing with people who cannot install Tailscale |

Homeport's sign-in and two-factor apply either way.

## Private access with Tailscale

1. Install Tailscale on the Mac (`brew install --cask tailscale`, or from tailscale.com) and sign in. Install it on your phone and laptop with the same account.
2. In the Tailscale admin console, under **DNS**, turn on **MagicDNS** and **HTTPS certificates** (once per tailnet).
3. In Homeport: **Access → Private access with Tailscale → Serve on my tailnet**.

Homeport runs `tailscale serve --bg --https=443 http://127.0.0.1:7070`. The dashboard keeps listening on `127.0.0.1` only; Tailscale terminates HTTPS and forwards to it, and requests that arrive this way are treated as remote, so they always need a sign-in.

## Public hostname

The dashboard gets a hostname on your Cloudflare zone and comes in through the same tunnel as your apps.

![Sign-in page on a public hostname](/screenshots/login.png)

## 1. Create your account

The first time you open `http://127.0.0.1:7070` on the Mac, Homeport asks for a password before showing anything else. From any other computer (a NAS has no screen) the same screen also asks for the one-time **setup code** that Homeport prints to its log and writes to `data/setup-code`. Without it nobody can claim an unprotected dashboard, whether over the LAN or a tunnel.

Passwords need at least 10 characters. A few unrelated words work well.

## 2. Turn on two-factor sign-in

**Access → Two-factor sign-in → Set up authenticator.** Scan the QR code with any TOTP app (1Password, Google Authenticator, Authy, Bitwarden), type the 6-digit code to confirm, and save the eight recovery codes somewhere safe. Each recovery code works once.

The dashboard can run any build command on the Mac, so treat two-factor as required once it is public. The sidebar shows a yellow dot on **Access** while the dashboard is public without it.

## 3. Publish

**Access → Public dashboard**: enter a hostname such as `deploy.example.com`, pick a tunnel, and press **Publish**. Homeport creates the DNS record, adds the hostname to the tunnel and points Caddy at the dashboard. **Unpublish** removes all three; the dashboard stays available on the Mac.

![Access page](/screenshots/access.png)

## What protects it

| Layer | Behaviour |
|---|---|
| Password | Stored as an scrypt hash (N=2^15, r=8) in `data/auth.json`, mode 600, outside `db.json` and backups |
| Two-factor | RFC 6238 TOTP, ±30 s drift, a code is never accepted twice; single-use recovery codes stored as hashes |
| Sessions | Random 256-bit token in an HttpOnly, SameSite=Strict cookie, Secure over HTTPS. Only its SHA-256 is stored. Expire after 30 days idle or 90 days total |
| Brute force | 5 free attempts per address, then waits that double from 30 s up to an hour. If 30 attempts fail across all addresses within 10 minutes, remote sign-in pauses; the Mac can still sign in |
| CSRF | Mutations need `X-Homeport: 1` and a matching `Origin` |
| DNS rebinding | "On the Mac" means a loopback connection, a loopback `Host` header and no proxy headers |
| Headers | Strict CSP with no inline scripts, `frame-ancestors 'none'`, HSTS over HTTPS |

Changing the password signs out every other device. **Signed-in devices** lists sessions with their address and lets you sign any of them out.

## People and roles

Everyone signs in with a **username** and password. Under **Access → People**, an admin can add more people:

| Role | Can |
|---|---|
| Admin | Everything: deploy, change domains, tunnels and settings, manage people. Grafana admin. |
| Viewer | Look at apps, deploys, logs, metrics and Grafana. Cannot change anything. Environment variables, tokens and webhook secrets are masked, and the backup export is closed. |

Admins can set a new password for someone (they are signed out everywhere) or turn off two-factor for someone who lost their phone. There is always at least one admin, and nobody can delete their own account. Each person has their own two-factor, recovery codes and devices.

Upgrading from a version without usernames turns the existing password into the account **`admin`**; rename it under **Your account**.

![People on the Access page](/screenshots/people.png)

## Extra gate: Cloudflare Access

For a second, independent check, add a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) application for the dashboard hostname, allowing only your email. Visitors then pass Cloudflare's login before they reach Homeport's. Do not put the webhook hostname behind Access, since GitHub cannot sign in.

## Locked out

On the Mac, in the Homeport folder:

```bash
npm run reset-password
```

This clears the password, two-factor and all sessions, then restarts Homeport with a new setup code. In Docker: `docker exec homeport npm run reset-password`.

## Grafana

Grafana and Prometheus stay on the Mac. The dashboard's own Monitoring page works remotely; the "Open Grafana" links only work on the Mac or over SSH port forwarding.
