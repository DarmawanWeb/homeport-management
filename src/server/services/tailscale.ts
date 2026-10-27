import fs from 'node:fs';
import type { TailscaleDTO } from '../../shared/types.js';
import { env } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { run } from '../lib/exec.js';

/**
 * Private access with Tailscale: `tailscale serve` gives the dashboard an HTTPS address on your
 * tailnet (https://<machine>.<tailnet>.ts.net) that only your own signed-in devices can reach.
 * Nothing is opened to the internet, and Homeport's sign-in still applies.
 */

// The Mac App Store and standalone apps ship the CLI inside the bundle.
const CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

async function bin(): Promise<string | null> {
  for (const c of CANDIDATES) {
    if (c.startsWith('/') && !fs.existsSync(c)) continue;
    const r = await run(c, ['version'], { quiet: true, timeout: 5000 });
    if (r.ok) return c;
  }
  return null;
}

interface StatusJson {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[]; HostName?: string };
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string };
}

interface ServeJson {
  TCP?: Record<string, { HTTPS?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

/** Pure: status + serve JSON → what the Access page shows. Exported for tests. */
export function parseTailscale(status: StatusJson | null, serve: ServeJson | null, port: number): Omit<TailscaleDTO, 'installed'> {
  const dns = status?.Self?.DNSName?.replace(/\.$/, '') ?? '';
  const running = status?.BackendState === 'Running';
  let url: string | null = null;
  for (const [hostPort, web] of Object.entries(serve?.Web ?? {})) {
    for (const h of Object.values(web.Handlers ?? {})) {
      if (h.Proxy && new RegExp(`(127\\.0\\.0\\.1|localhost):${port}/?$`).test(h.Proxy)) {
        const [host, p] = hostPort.split(':');
        url = `https://${host}${p && p !== '443' ? `:${p}` : ''}`;
      }
    }
  }
  return {
    running,
    state: status?.BackendState ?? 'NoState',
    dnsName: dns || null,
    ip: status?.Self?.TailscaleIPs?.find((i) => i.includes('.')) ?? null,
    tailnet: status?.CurrentTailnet?.Name ?? null,
    serving: url,
  };
}

export async function tailscaleStatus(): Promise<TailscaleDTO> {
  const b = await bin();
  if (!b) return { installed: false, running: false, state: 'NotInstalled', dnsName: null, ip: null, tailnet: null, serving: null };
  const parse = <T>(text: string): T | null => {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  };
  const st = await run(b, ['status', '--json'], { quiet: true, timeout: 8000 });
  const sv = await run(b, ['serve', 'status', '--json'], { quiet: true, timeout: 8000 });
  return { installed: true, ...parseTailscale(parse<StatusJson>(st.stdout), parse<ServeJson>(sv.stdout), env.port) };
}

export async function setTailscaleServe(on: boolean): Promise<TailscaleDTO> {
  const b = await bin();
  if (!b) throw new HttpError(400, 'Tailscale is not installed on this machine');
  const args = on ? ['serve', '--bg', '--https=443', `http://127.0.0.1:${env.port}`] : ['serve', '--https=443', 'off'];
  const r = await run(b, args, { quiet: true, timeout: 30_000 });
  if (!r.ok) {
    const msg = `${r.stderr}\n${r.stdout}`.trim();
    // First use on a tailnet needs HTTPS certificates switched on in the admin console.
    if (/HTTPS|cert|enable/i.test(msg))
      throw new HttpError(
        400,
        `Tailscale said: ${msg.split('\n').slice(-2).join(' ')} (turn on HTTPS under DNS in the Tailscale admin console)`,
      );
    throw new HttpError(400, `Tailscale said: ${msg.split('\n').slice(-2).join(' ')}`);
  }
  return tailscaleStatus();
}
