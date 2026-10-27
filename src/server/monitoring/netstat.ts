import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import client from 'prom-client';
import type { NetIface, NetworkStatsDTO } from '../../shared/types.js';
import { IS_MAC } from '../config.js';
import { activity } from '../lib/activity.js';
import { run } from '../lib/exec.js';
import { send } from '../services/notify.js';
import { settings } from '../store.js';
import { registry } from './exporter.js';

/**
 * Network health: how much goes in and out, whether the internet (Cloudflare) is reachable and how
 * fast, which public IP and Cloudflare location the machine uses, and where each tunnel is connected.
 */

const SAMPLE_MS = 15_000;
const PING_MS = 30_000;
const TRACE_MS = 10 * 60_000;
// Overridable so tests and offline demos can point at something local.
const PING_TARGET = process.env.HOMEPORT_PING_TARGET ?? '1.1.1.1:443';

/** Interfaces that never carry the machine's own traffic. */
const SKIP_IFACE = /^(lo|docker|veth|br-|virbr|vmnet|utun|bridge|awdl|llw|anpi|ap\d|gif|stf|tun|tap)/;

type Counters = Map<string, { rx: number; tx: number }>;

/** Parse /proc/net/dev (Linux). Exported for tests. */
export function parseProcNetDev(text: string): Counters {
  const out: Counters = new Map();
  for (const line of text.split('\n').slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    out.set(m[1].trim(), { rx: f[0], tx: f[8] });
  }
  return out;
}

/** Parse `netstat -ibn` (macOS): one <Link#> row per interface. Exported for tests. */
export function parseNetstat(text: string): Counters {
  const out: Counters = new Map();
  for (const line of text.split('\n').slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 7 || !c[2]?.startsWith('<Link#') || out.has(c[0])) continue;
    const n = c.length;
    out.set(c[0], { rx: Number(c[n - 5]), tx: Number(c[n - 2]) });
  }
  return out;
}

async function readCounters(): Promise<Counters> {
  if (IS_MAC) {
    const r = await run('netstat', ['-ibn'], { quiet: true, timeout: 5000 });
    return r.ok ? parseNetstat(r.stdout) : new Map();
  }
  try {
    return parseProcNetDev(fs.readFileSync('/proc/net/dev', 'utf8'));
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------- state

let prev: { at: number; c: Counters } | null = null;
let ifaces: NetIface[] = [];
const throughput: NetworkStatsDTO['throughput'] = [];
const pings: { t: number; ms: number | null }[] = [];
let dnsMs: number | null = null;
let trace: { ip: string; loc: string; colo: string; at: number } | null = null;
let internetDown = false;

const gRx = new client.Gauge({
  name: 'homeport_network_receive_bytes_total',
  help: 'Bytes received per interface',
  labelNames: ['iface'],
  registers: [registry],
});
const gTx = new client.Gauge({
  name: 'homeport_network_transmit_bytes_total',
  help: 'Bytes sent per interface',
  labelNames: ['iface'],
  registers: [registry],
});
const gLatency = new client.Gauge({
  name: 'homeport_internet_latency_seconds',
  help: 'TCP connect time to Cloudflare',
  registers: [registry],
});
const gUp = new client.Gauge({ name: 'homeport_internet_up', help: '1 if Cloudflare is reachable', registers: [registry] });

async function sample(): Promise<void> {
  const c = await readCounters();
  const now = Date.now();
  const list: NetIface[] = [];
  let rxSum = 0;
  let txSum = 0;
  for (const [name, v] of c) {
    if (SKIP_IFACE.test(name)) continue;
    const p = prev?.c.get(name);
    const dt = prev ? (now - prev.at) / 1000 : 0;
    // Counters reset on reboot or interface restart: treat a drop as no data.
    const rxRate = p && dt > 0 && v.rx >= p.rx ? (v.rx - p.rx) / dt : 0;
    const txRate = p && dt > 0 && v.tx >= p.tx ? (v.tx - p.tx) / dt : 0;
    if (v.rx === 0 && v.tx === 0) continue;
    list.push({ name, rxRate, txRate, rxTotal: v.rx, txTotal: v.tx });
    rxSum += rxRate;
    txSum += txRate;
    gRx.set({ iface: name }, v.rx);
    gTx.set({ iface: name }, v.tx);
  }
  ifaces = list.sort((a, b) => b.rxTotal + b.txTotal - (a.rxTotal + a.txTotal));
  if (prev) {
    throughput.push({ t: now, rx: rxSum, tx: txSum });
    if (throughput.length > 240) throughput.shift();
  }
  prev = { at: now, c };
}

function tcpPing(target: string): Promise<number | null> {
  const [host, port] = target.split(':');
  return new Promise((resolve) => {
    const started = performance.now();
    const sock = net.connect({ host, port: Number(port), timeout: 3000 });
    const done = (ms: number | null) => {
      sock.destroy();
      resolve(ms);
    };
    sock.once('connect', () => done(Math.round((performance.now() - started) * 10) / 10));
    sock.once('timeout', () => done(null));
    sock.once('error', () => done(null));
  });
}

async function ping(): Promise<void> {
  const ms = await tcpPing(PING_TARGET);
  pings.push({ t: Date.now(), ms });
  if (pings.length > 120) pings.shift();
  gUp.set(ms === null ? 0 : 1);
  if (ms !== null) gLatency.set(ms / 1000);

  const started = performance.now();
  dnsMs = await dns
    .resolve4('cloudflare.com')
    .then(() => Math.round(performance.now() - started))
    .catch(() => null);

  // Three misses in a row is an outage worth telling someone about once it is over.
  const lastThree = pings.slice(-3);
  const down = lastThree.length === 3 && lastThree.every((p) => p.ms === null);
  if (down && !internetDown) {
    internetDown = true;
    activity.error('Internet looks down: Cloudflare is not reachable');
  } else if (!down && internetDown && ms !== null) {
    internetDown = false;
    activity.info('Internet is back');
    if (settings().notify.onAlerts)
      void send({
        title: 'Internet connection restored',
        body: 'Cloudflare was unreachable for a while; apps may have been offline.',
        level: 'warning',
      });
  }
}

async function cfTrace(): Promise<void> {
  try {
    const res = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) });
    const kv = Object.fromEntries(
      (await res.text())
        .split('\n')
        .map((l) => l.split('='))
        .filter((p) => p.length === 2),
    ) as Record<string, string>;
    if (kv.ip) trace = { ip: kv.ip, loc: kv.loc ?? '', colo: kv.colo ?? '', at: Date.now() };
  } catch {
    /* offline; keep the last known value */
  }
}

/** Which Cloudflare data centres each tunnel is connected to, from cloudflared's own metrics. */
async function tunnelEdges(): Promise<NetworkStatsDTO['tunnels']> {
  const out: NetworkStatsDTO['tunnels'] = [];
  for (const [name, port] of Object.entries(settings().tunnelMetricsPorts)) {
    try {
      const text = await (await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(2000) })).text();
      const conns = Number(/^cloudflared_tunnel_ha_connections\s+([\d.]+)/m.exec(text)?.[1] ?? 0);
      const edges = [...text.matchAll(/cloudflared_tunnel_server_locations\{[^}]*edge_location="([^"]+)"[^}]*\}\s+1/g)].map((m) => m[1]);
      out.push({ name, connections: conns, edges: [...new Set(edges)] });
    } catch {
      out.push({ name, connections: 0, edges: [] });
    }
  }
  return out;
}

export function startNetstat(): void {
  void sample();
  void ping();
  void cfTrace();
  setInterval(() => void sample(), SAMPLE_MS).unref();
  setInterval(() => void ping(), PING_MS).unref();
  setInterval(() => void cfTrace(), TRACE_MS).unref();
}

export async function networkStats(): Promise<NetworkStatsDTO> {
  const recent = pings.slice(-20);
  const lost = recent.filter((p) => p.ms === null).length;
  const last = pings.at(-1);
  return {
    interfaces: ifaces,
    throughput,
    internet: {
      up: last ? last.ms !== null : null,
      latencyMs: last?.ms ?? null,
      lossPct: recent.length ? (lost / recent.length) * 100 : 0,
      dnsMs,
      series: pings,
      publicIp: trace?.ip ?? null,
      country: trace?.loc ?? null,
      colo: trace?.colo ?? null,
      checkedAt: trace?.at ?? null,
    },
    tunnels: await tunnelEdges(),
  };
}
