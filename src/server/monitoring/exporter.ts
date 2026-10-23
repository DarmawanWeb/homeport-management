/**
 * Prometheus exporter for Homeport itself: apps, pm2 processes, deploys, webhooks, upstreams and host basics.
 * Served on a separate localhost-only port so Prometheus can scrape it without dashboard auth.
 */
import http from 'node:http';
import os from 'node:os';
import client from 'prom-client';
import { activity } from '../lib/activity.js';
import { events } from '../lib/events.js';
import { portOpen } from '../lib/net.js';
import { db, settings } from '../store.js';
import * as pm2 from '../services/pm2.js';
import { isDeploying } from '../services/deploy.js';
import { hostCpuUsage, hostDisk, hostMemory } from './host.js';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'homeport_self_' });

const g = (name: string, help: string, labelNames: string[] = []) =>
  new client.Gauge({ name, help, labelNames, registers: [registry] });

const m = {
  info: g('homeport_info', 'Homeport build/host info', ['hostname', 'platform']),
  appUp: g('homeport_app_up', '1 if the app process is online and its port accepts connections', ['app']),
  appDeploying: g('homeport_app_deploying', '1 while a deploy is running', ['app']),
  appInfo: g('homeport_app_info', 'Currently deployed commit', ['app', 'branch', 'commit']),
  lastDeployTs: g('homeport_app_last_deploy_timestamp_seconds', 'Finish time of the last deploy', ['app']),
  lastDeployOk: g('homeport_app_last_deploy_success', '1 if the last deploy succeeded', ['app']),
  procOnline: g('homeport_process_online', '1 if the pm2 process is online', ['name', 'kind']),
  procCpu: g('homeport_process_cpu_percent', 'pm2 process CPU %', ['name', 'kind']),
  procMem: g('homeport_process_memory_bytes', 'pm2 process memory (RSS)', ['name', 'kind']),
  procRestarts: g('homeport_process_restarts', 'pm2 restart counter (resets when the process is recreated)', ['name', 'kind']),
  procUptime: g('homeport_process_uptime_seconds', 'Seconds since the pm2 process started', ['name', 'kind']),
  siteUp: g('homeport_site_upstream_up', '1 if the upstream of a domain accepts connections', ['host', 'app']),
  siteEnabled: g('homeport_site_enabled', '1 if the domain is enabled', ['host']),
  tunnelRunning: g('homeport_tunnel_running', '1 if the tunnel process is online under pm2', ['tunnel']),
  hostMemTotal: g('homeport_host_memory_total_bytes', 'Physical memory'),
  hostMemUsed: g('homeport_host_memory_used_bytes', 'Memory in use (excluding reclaimable cache)'),
  hostCpu: g('homeport_host_cpu_usage_ratio', 'CPU busy ratio since previous scrape'),
  hostLoad: g('homeport_host_load', 'Load average', ['period']),
  hostCpus: g('homeport_host_cpu_count', 'Logical CPUs'),
  hostDiskTotal: g('homeport_host_disk_total_bytes', 'Size of the volume holding the apps folder'),
  hostDiskAvail: g('homeport_host_disk_available_bytes', 'Free space on the volume holding the apps folder'),
};

const deploys = new client.Counter({ name: 'homeport_deploys_total', help: 'Finished deploys', labelNames: ['app', 'status', 'trigger'], registers: [registry] });
const deployDuration = new client.Histogram({
  name: 'homeport_deploy_duration_seconds', help: 'Deploy duration', labelNames: ['app'],
  buckets: [5, 15, 30, 60, 120, 300, 600, 1200], registers: [registry],
});
const webhooks = new client.Counter({ name: 'homeport_webhooks_total', help: 'Webhook requests', labelNames: ['app', 'result'], registers: [registry] });

events.on('deploy:finished', (d) => {
  deploys.inc({ app: d.app, status: d.status, trigger: d.trigger });
  if (d.duration) deployDuration.observe({ app: d.app }, d.duration / 1000);
});
events.on('webhook:received', (app, result) => webhooks.inc({ app, result }));

function kindOf(name: string): 'app' | 'system' | 'other' {
  const st = settings();
  if (db.apps.some((a) => a.name === name)) return 'app';
  if (name === 'homeport' || name === st.caddyPm2Name || name.startsWith(st.tunnelPm2Prefix) || name.startsWith('hp-')) return 'system';
  return 'other';
}

/** Refresh all gauges. Called on every scrape so values are never stale. */
async function refresh(): Promise<void> {
  const st = settings();
  const [procs, mem, disk] = await Promise.all([pm2.list(), hostMemory(), hostDisk()]);
  const byName = new Map(procs.list.map((p) => [p.name, p]));
  for (const metric of Object.values(m)) metric.reset();

  m.info.set({ hostname: os.hostname(), platform: `${os.type()} ${os.release()}` }, 1);
  for (const p of procs.list) {
    const labels = { name: p.name, kind: kindOf(p.name) };
    m.procOnline.set(labels, p.status === 'online' ? 1 : 0);
    m.procCpu.set(labels, p.cpu);
    m.procMem.set(labels, p.mem);
    m.procRestarts.set(labels, p.restarts);
    if (p.uptime && p.status === 'online') m.procUptime.set(labels, (Date.now() - p.uptime) / 1000);
  }

  await Promise.all(db.apps.map(async (a) => {
    const online = byName.get(a.name)?.status === 'online';
    const listening = online && (await portOpen('127.0.0.1', a.port, 400));
    m.appUp.set({ app: a.name }, listening ? 1 : 0);
    m.appDeploying.set({ app: a.name }, isDeploying(a.id) ? 1 : 0);
    if (a.currentCommit) m.appInfo.set({ app: a.name, branch: a.branch, commit: a.currentCommit.sha.slice(0, 7) }, 1);
    if (a.lastDeploy) {
      m.lastDeployTs.set({ app: a.name }, Date.parse(a.lastDeploy.at) / 1000);
      m.lastDeployOk.set({ app: a.name }, a.lastDeploy.status === 'success' ? 1 : 0);
    }
  }));

  await Promise.all(db.sites.map(async (s) => {
    m.siteEnabled.set({ host: s.hostname }, s.enabled ? 1 : 0);
    if (s.enabled) m.siteUp.set({ host: s.hostname, app: s.pm2Name }, (await portOpen(s.upstreamHost, s.upstreamPort, 400)) ? 1 : 0);
  }));

  for (const name of new Set(db.sites.map((s) => s.tunnel).filter(Boolean))) {
    m.tunnelRunning.set({ tunnel: name }, byName.get(st.tunnelPm2Prefix + name)?.status === 'online' ? 1 : 0);
  }

  m.hostMemTotal.set(mem.total);
  m.hostMemUsed.set(mem.used);
  m.hostCpu.set(hostCpuUsage());
  m.hostCpus.set(os.cpus().length);
  const [l1, l5, l15] = os.loadavg();
  m.hostLoad.set({ period: '1m' }, l1 ?? 0);
  m.hostLoad.set({ period: '5m' }, l5 ?? 0);
  m.hostLoad.set({ period: '15m' }, l15 ?? 0);
  if (disk) {
    m.hostDiskTotal.set(disk.total);
    m.hostDiskAvail.set(disk.avail);
  }
}

let server: http.Server | null = null;

export function startExporter(): void {
  server?.close();
  const port = settings().monitoring.metricsPort;
  server = http.createServer((req, res) => {
    if (req.url !== '/metrics') { res.writeHead(404).end(); return; }
    refresh()
      .then(() => registry.metrics())
      .then((body) => { res.writeHead(200, { 'Content-Type': registry.contentType }); res.end(body); })
      .catch((e: Error) => { res.writeHead(500).end(e.message); });
  });
  server.on('error', (e) => activity.error(`Metrics exporter gagal listen di port ${port}: ${e.message}`));
  server.listen(port, '127.0.0.1', () => activity.info(`Metrics exporter di http://127.0.0.1:${port}/metrics`));
}
