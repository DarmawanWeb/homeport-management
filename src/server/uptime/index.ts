import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { PublicStatusDTO, UptimeCheck, UptimeDTO, UptimeHost, UptimeIncident } from '../../shared/types.js';
import { env, paths } from '../config.js';
import { activity } from '../lib/activity.js';
import { errMsg } from '../lib/errors.js';
import { send } from '../services/notify.js';
import { db, settings } from '../store.js';

/**
 * Uptime checks, like UptimeRobot but from the machine itself.
 *
 * "public" mode requests https://<domain>/ from the internet side: DNS, Cloudflare, the tunnel, Caddy
 * and the app all have to work. "local" mode asks Caddy directly with the Host header, for machines
 * without internet or before DNS is set up. Any answer below 500 counts as up.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FILE = path.join(paths.uptime, 'state.json');
/** Two failures in a row open an incident; one success closes it. */
const FAIL_THRESHOLD = 2;
const UA = 'Homeport-Uptime/1.0';

interface HourAgg {
  checks: number;
  ok: number;
  msSum: number;
}

interface HostState {
  recent: UptimeCheck[];
  hours: Record<string, HourAgg>;
  failStreak: number;
  down: boolean;
}

interface State {
  hosts: Record<string, HostState>;
  incidents: UptimeIncident[];
}

let state: State = { hosts: {}, incidents: [] };
let timer: NodeJS.Timeout | null = null;
let running = false;

const hourKey = (ts: number) => String(Math.floor(ts / HOUR) * HOUR);

/** Domains worth checking: enabled, reachable from outside, not the webhook receiver or the dashboard. */
export function checkedHosts(): string[] {
  const st = settings();
  return db.sites
    .filter((s) => s.enabled && s.upstreamPort !== st.webhookPort && s.upstreamPort !== env.port)
    .map((s) => s.hostname)
    .sort();
}

/** GET through Caddy on this machine. fetch() cannot set Host, so this uses http.request. */
function localGet(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: settings().caddyHttpPort,
        path: '/',
        method: 'GET',
        headers: { Host: host, 'User-Agent': UA },
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('Timed out after 10 s'), { name: 'TimeoutError' })));
    req.on('error', reject);
    req.end();
  });
}

async function publicGet(host: string): Promise<number> {
  const res = await fetch(`https://${host}/`, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  await res.body?.cancel();
  return res.status;
}

export async function checkOnce(host: string, mode = settings().uptime.mode): Promise<UptimeCheck> {
  const started = performance.now();
  const ts = Date.now();
  try {
    const status = mode === 'public' ? await publicGet(host) : await localGet(host);
    const ms = Math.round(performance.now() - started);
    // Caddy's own "unknown host" answer means the domain is not routed, which is not up.
    const ok = status > 0 && status < 500 && !(mode === 'local' && status === 404 && (await isCaddyFallback(host)));
    return { ts, ok, status, ms, ...(ok ? {} : { error: status >= 500 ? `HTTP ${status}` : 'Not routed by Caddy' }) };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    const msg = (e as Error).name === 'TimeoutError' ? 'Timed out after 10 s' : cause ? `${cause}` : errMsg(e);
    return { ts, ok: false, status: null, ms: null, error: msg };
  }
}

/** True when the domain is unknown to Caddy (only then is a 404 Caddy's fallback rather than the app's). */
async function isCaddyFallback(host: string): Promise<boolean> {
  return !db.sites.some((s) => s.enabled && s.hostname === host);
}

/** Fold one result into a host's history, opening or closing incidents. Exported for tests. */
export function record(host: string, c: UptimeCheck, notify = true): void {
  state.hosts[host] ??= { recent: [], hours: {}, failStreak: 0, down: false };
  const h = state.hosts[host];
  h.recent.push(c);
  if (h.recent.length > 60) h.recent.splice(0, h.recent.length - 60);
  const hk = hourKey(c.ts);
  h.hours[hk] ??= { checks: 0, ok: 0, msSum: 0 };
  const agg = h.hours[hk];
  agg.checks++;
  if (c.ok) {
    agg.ok++;
    agg.msSum += c.ms ?? 0;
  }

  if (c.ok) {
    h.failStreak = 0;
    if (h.down) {
      h.down = false;
      const inc = state.incidents.find((i) => i.host === host && i.end === null);
      if (inc) inc.end = c.ts;
      const mins = inc ? Math.max(1, Math.round((c.ts - inc.start) / 60_000)) : 0;
      activity.info(`${host} is back up${mins ? ` after ${mins} min` : ''}`);
      if (notify && settings().notify.onAlerts)
        void send({
          title: `${host} is back up`,
          body: mins ? `Down for ${mins} min.` : 'Responding again.',
          level: 'success',
          url: `https://${host}`,
        });
    }
    return;
  }
  h.failStreak++;
  if (!h.down && h.failStreak >= FAIL_THRESHOLD) {
    h.down = true;
    const first = h.recent.at(-FAIL_THRESHOLD)?.ts ?? c.ts;
    state.incidents.unshift({ host, start: first, end: null, cause: c.error ?? 'No response' });
    state.incidents = state.incidents.slice(0, 200);
    activity.error(`${host} is down: ${c.error ?? 'no response'}`);
    if (notify && settings().notify.onAlerts)
      void send({ title: `${host} is down`, body: c.error ?? 'No response', level: 'error', url: `https://${host}` });
  }
}

async function runChecks(): Promise<void> {
  if (running || !settings().uptime.enabled) return;
  running = true;
  try {
    const hosts = checkedHosts();
    // A few at a time: gentle on the uplink and on Cloudflare.
    for (let i = 0; i < hosts.length; i += 4) {
      const batch = hosts.slice(i, i + 4);
      const results = await Promise.all(batch.map((h) => checkOnce(h)));
      for (const [j, h] of batch.entries()) record(h, results[j]);
    }
    prune();
    save();
  } finally {
    running = false;
  }
}

function prune(): void {
  const cutoff = Date.now() - 91 * DAY;
  const live = new Set(checkedHosts());
  for (const [host, h] of Object.entries(state.hosts)) {
    for (const k of Object.keys(h.hours)) if (Number(k) < cutoff) delete h.hours[k];
    if (!live.has(host) && Object.keys(h.hours).length === 0) delete state.hosts[host];
  }
}

function save(): void {
  fs.mkdirSync(paths.uptime, { recursive: true });
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state));
  fs.renameSync(`${FILE}.tmp`, FILE);
}

export function loadUptime(): void {
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8')) as State;
  } catch {
    state = { hosts: {}, incidents: [] };
  }
}

export function startUptime(): void {
  loadUptime();
  const schedule = () => {
    timer = setTimeout(async () => {
      await runChecks().catch((e) => activity.warn(`Uptime: ${errMsg(e)}`));
      schedule();
    }, settings().uptime.intervalSec * 1000);
    timer.unref();
  };
  // First round shortly after start, so the page fills quickly.
  setTimeout(() => void runChecks().catch(() => undefined), 5000).unref();
  schedule();
}

/** Run a round now (from the UI). */
export const checkNow = () => runChecks();

// ---------------------------------------------------------------- views

function ratio(h: HostState, from: number): number | null {
  let checks = 0;
  let ok = 0;
  for (const [k, a] of Object.entries(h.hours)) {
    if (Number(k) + HOUR <= from) continue;
    checks += a.checks;
    ok += a.ok;
  }
  return checks ? ok / checks : null;
}

function hostView(host: string, now = Date.now()): UptimeHost {
  const h = state.hosts[host];
  const last = h?.recent.at(-1) ?? null;
  const days: UptimeHost['days'] = [];
  const today = Math.floor(now / DAY) * DAY;
  for (let i = 89; i >= 0; i--) {
    const start = today - i * DAY;
    let checks = 0;
    let ok = 0;
    for (const [k, a] of Object.entries(h?.hours ?? {})) {
      const t = Number(k);
      if (t >= start && t < start + DAY) {
        checks += a.checks;
        ok += a.ok;
      }
    }
    days.push({ day: new Date(start).toISOString().slice(0, 10), uptime: checks ? ok / checks : null });
  }
  let msSum = 0;
  let okCount = 0;
  for (const [k, a] of Object.entries(h?.hours ?? {}))
    if (Number(k) + HOUR > now - DAY) {
      msSum += a.msSum;
      okCount += a.ok;
    }
  return {
    host,
    state: !last ? 'unknown' : h.down ? 'down' : last.ok ? 'up' : 'unknown',
    last,
    uptime24h: h ? ratio(h, now - DAY) : null,
    uptime7d: h ? ratio(h, now - 7 * DAY) : null,
    uptime30d: h ? ratio(h, now - 30 * DAY) : null,
    avgMs24h: okCount ? Math.round(msSum / okCount) : null,
    days,
    recent: h?.recent ?? [],
  };
}

export function uptime(): UptimeDTO {
  const st = settings();
  return {
    enabled: st.uptime.enabled,
    mode: st.uptime.mode,
    hosts: checkedHosts().map((h) => hostView(h)),
    incidents: state.incidents.slice(0, 50),
    statusPage: st.statusPage,
  };
}

/** What the public status page may show: chosen domains, their uptime and incidents. Nothing else. */
export function publicStatus(): PublicStatusDTO | null {
  const sp = settings().statusPage;
  if (!sp.enabled) return null;
  const hosts = (sp.hosts.length ? sp.hosts.filter((h) => checkedHosts().includes(h)) : checkedHosts()).map((h) => {
    const v = hostView(h);
    return { host: v.host, state: v.state, uptime30d: v.uptime30d, days: v.days };
  });
  const down = hosts.filter((h) => h.state === 'down').length;
  const shown = new Set(hosts.map((h) => h.host));
  return {
    title: sp.title || 'Status',
    state: !hosts.length ? 'unknown' : down === 0 ? 'operational' : down === hosts.length ? 'down' : 'degraded',
    hosts,
    incidents: state.incidents.filter((i) => shown.has(i.host) && i.start > Date.now() - 30 * DAY).slice(0, 20),
    updatedAt: Date.now(),
  };
}

/** Test hook. */
export const resetUptime = () => {
  state = { hosts: {}, incidents: [] };
};
