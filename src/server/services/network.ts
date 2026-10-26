import { spawn } from 'node:child_process';
import os from 'node:os';
import type { NetworkDTO } from '../../shared/types.js';
import { env, writeListenPreference } from '../config.js';
import { HttpError } from '../lib/errors.js';
import { childEnv, run } from '../lib/exec.js';
import { FLAVOR } from '../platform.js';
import { settings } from '../store.js';

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** True when the dashboard listens on more than loopback. */
export const isLanBind = (host: string) => !['127.0.0.1', 'localhost', '::1'].includes(host);

/** This machine's private IPv4 addresses (LAN, and Tailscale's 100.64/10), most useful first. */
export function lanAddresses(ifaces = os.networkInterfaces()): string[] {
  const all: string[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    for (const a of list ?? []) {
      // Docker and VM bridges are not where other devices find this machine.
      if (a.family !== 'IPv4' || a.internal || /^(docker|br-|veth|virbr|vmnet|utun|bridge)/.test(name)) continue;
      all.push(a.address);
    }
  }
  const priv = all.filter((a) => PRIVATE_V4.test(a));
  // A machine with only public addresses (some servers) still gets something to show.
  const out = priv.length ? priv : all;
  // 192.168.x / 10.x home networks before Tailscale-style addresses.
  return out.sort((a, b) => Number(a.startsWith('100.')) - Number(b.startsWith('100.')));
}

/** The Bonjour name other Macs, iPhones and most PCs resolve without any setup. */
export function bonjourName(hostname = os.hostname()): string | null {
  if (FLAVOR !== 'mac' && FLAVOR !== 'synology') return null;
  const base = hostname.replace(/\.local$/i, '').replace(/\..*$/, '');
  return base ? `${base.toLowerCase()}.local` : null;
}

async function macFirewall(): Promise<NetworkDTO['firewall']> {
  if (FLAVOR !== 'mac') return null;
  const r = await run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'], { quiet: true, timeout: 5000 });
  if (!r.ok) return null;
  return /enabled/i.test(r.stdout) ? 'on' : 'off';
}

export async function networkInfo(): Promise<NetworkDTO> {
  const port = env.port;
  const hosts = [bonjourName(), ...lanAddresses()].filter((h): h is string => !!h);
  const firewall = await macFirewall();
  return {
    bind: env.host,
    lan: isLanBind(env.host),
    port,
    urls: hosts.map((h) => `http://${h}:${port}`),
    canChange: process.env.pm_id !== undefined,
    firewall,
    firewallFix:
      firewall === 'on'
        ? `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add ${process.execPath} && sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp ${process.execPath}`
        : '',
  };
}

/**
 * Remember the choice in data/network.json (read at startup, ahead of HOST) and restart Homeport
 * under pm2 so it takes effect. The restart runs detached because it ends this process.
 */
export function setLanAccess(on: boolean): void {
  const id = process.env.pm_id;
  if (id === undefined) throw new HttpError(400, 'Homeport is not running under pm2. Restart it yourself after this change.');
  writeListenPreference(on ? 'lan' : 'local');
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const child = spawn('sh', ['-c', `sleep 1; ${q(settings().pm2Bin)} restart ${Number(id)}`], {
    detached: true,
    stdio: 'ignore',
    env: childEnv(),
  });
  child.unref();
}
