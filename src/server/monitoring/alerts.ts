/**
 * Turns problems into notifications.
 *
 * When monitoring is on, Prometheus evaluates the alert rules and Homeport forwards firing/resolved
 * alerts to Discord/Telegram (a tiny Alertmanager). When monitoring is off, a built-in watcher still
 * reports apps that go down, so notifications work without Prometheus.
 */
import { activity } from '../lib/activity.js';
import { errMsg } from '../lib/errors.js';
import { portOpen } from '../lib/net.js';
import { db, settings } from '../store.js';
import { isDeploying } from '../services/deploy.js';
import * as notify from '../services/notify.js';
import * as pm2 from '../services/pm2.js';
import { alerts as promAlerts } from './service.js';
import type { PromAlert } from '../../shared/types.js';

const firing = new Map<string, PromAlert>();
let primed = false;

const keyOf = (a: PromAlert) => `${a.name}|${Object.entries(a.labels).filter(([k]) => k !== 'alertstate').sort().map(([k, v]) => `${k}=${v}`).join(',')}`;

async function checkPrometheus(): Promise<boolean> {
  let list: PromAlert[];
  try { list = (await promAlerts()).filter((a) => a.state === 'firing'); } catch { return false; }
  const now = new Map(list.map((a) => [keyOf(a), a]));
  // On the first successful read, only remember what is already firing (no flood after a restart).
  if (primed && settings().notify.onAlerts) {
    for (const [k, a] of now) {
      if (!firing.has(k)) void notify.send({ level: a.severity === 'critical' ? 'error' : 'warning', title: `🔔 ${a.name}`, body: a.summary });
    }
    for (const [k, a] of firing) {
      if (!now.has(k)) void notify.send({ level: 'success', title: `Pulih: ${a.name}`, body: a.summary });
    }
  }
  firing.clear();
  for (const [k, a] of now) firing.set(k, a);
  primed = true;
  return true;
}

// ---------------------------------------------------------------- fallback watcher (no Prometheus)

const downSince = new Map<string, number>();
const notified = new Set<string>();
const DOWN_AFTER_MS = 90_000;

async function checkApps(): Promise<void> {
  const procs = (await pm2.list(true)).list;
  for (const a of db.apps) {
    if (isDeploying(a.id) || !a.lastDeploy) continue;
    const online = procs.find((p) => p.name === a.name)?.status === 'online';
    const up = online && (await portOpen('127.0.0.1', a.port, 600));
    if (up) {
      downSince.delete(a.id);
      if (notified.delete(a.id) && settings().notify.onAlerts) void notify.send({ level: 'success', title: `Pulih: ${a.name}`, body: `App kembali merespon di port ${a.port}` });
      continue;
    }
    const since = downSince.get(a.id) ?? Date.now();
    downSince.set(a.id, since);
    if (!notified.has(a.id) && Date.now() - since >= DOWN_AFTER_MS) {
      notified.add(a.id);
      if (settings().notify.onAlerts) void notify.send({ level: 'error', title: `🔔 ${a.name} down`, body: `Tidak merespon di port ${a.port} (pm2: ${procs.find((p) => p.name === a.name)?.status ?? 'tidak ada'})` });
    }
  }
}

export function startAlertLoop(): void {
  const tick = async () => {
    try {
      const viaPrometheus = settings().monitoring.enabled && (await checkPrometheus());
      if (!viaPrometheus) await checkApps();
    } catch (e) {
      activity.warn(`Pengecekan alert gagal: ${errMsg(e)}`);
    }
  };
  setInterval(() => void tick(), 30_000);
}
