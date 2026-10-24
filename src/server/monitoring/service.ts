import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ComponentKey, MonitoringComponent, MonitoringStatus, PromAlert, QueryRangeDTO, Series } from '../../shared/types.js';
import { activity } from '../lib/activity.js';
import { badRequest, errMsg } from '../lib/errors.js';
import { events } from '../lib/events.js';
import { run } from '../lib/exec.js';
import { portOpen } from '../lib/net.js';
import * as caddy from '../services/caddy.js';
import * as pm2 from '../services/pm2.js';
import { saveDb, settings } from '../store.js';
import { grafanaDashboardProvider, grafanaDatasource, grafanaIni, monitoringPaths as P, prometheusConfig, rulesConfig } from './configs.js';
import { allDashboards } from './dashboards.js';

export const PM2_NAMES: Record<ComponentKey, string> = {
  prometheus: 'hp-prometheus',
  grafana: 'hp-grafana',
  nodeExporter: 'hp-node-exporter',
};

const promUrl = () => `http://127.0.0.1:${settings().monitoring.prometheusPort}`;
export const grafanaUrl = () => `http://127.0.0.1:${settings().monitoring.grafanaPort}`;

// ---------------------------------------------------------------- discovery

const isLegacyGrafana = (bin: string) => path.basename(bin).startsWith('grafana-server');

/** Grafana needs its "homepath" (conf/defaults.ini + public/). Homebrew puts it under share/grafana. */
export async function grafanaHome(): Promise<string | null> {
  const configured = settings().monitoring.grafanaHome;
  const ok = (p: string) => fs.existsSync(path.join(p, 'conf', 'defaults.ini'));
  if (configured) return ok(configured) ? configured : null;
  const brew = await run('brew', ['--prefix', 'grafana'], { quiet: true, timeout: 10_000 });
  const candidates = [
    ...(brew.ok ? [path.join(brew.stdout.trim(), 'share', 'grafana')] : []),
    '/opt/homebrew/opt/grafana/share/grafana',
    '/usr/local/opt/grafana/share/grafana',
    '/usr/share/grafana',
  ];
  return candidates.find(ok) ?? null;
}

async function versionOf(key: ComponentKey): Promise<string | null> {
  const m = settings().monitoring;
  const [bin, args] =
    key === 'prometheus'
      ? [m.prometheusBin, ['--version']]
      : key === 'nodeExporter'
        ? [m.nodeExporterBin, ['--version']]
        : [m.grafanaBin, isLegacyGrafana(m.grafanaBin) ? ['-v'] : ['--version']];
  const r = await run(bin, args, { quiet: true, timeout: 10_000 });
  if (!r.ok) return null;
  const text = `${r.stdout}\n${r.stderr}`;
  return /version\s+v?([\d.]+[^\s,)]*)/i.exec(text)?.[1] ?? text.trim().split('\n')[0] ?? 'ok';
}

// ---------------------------------------------------------------- config files

export async function writeConfigs(): Promise<void> {
  const st = settings();
  if (!st.monitoring.grafanaAdminPassword) {
    st.monitoring.grafanaAdminPassword = crypto.randomBytes(12).toString('base64url');
    await saveDb();
  }
  for (const d of [
    path.dirname(P.prometheusYml),
    P.prometheusData,
    P.grafanaData,
    P.grafanaLogs,
    P.grafanaPlugins,
    P.grafanaDashboards,
    ...['datasources', 'dashboards', 'plugins', 'alerting', 'notifiers'].map((s) => path.join(P.grafanaProvisioning, s)),
  ]) {
    await fsp.mkdir(d, { recursive: true });
  }
  await fsp.writeFile(P.prometheusYml, prometheusConfig(st));
  await fsp.writeFile(P.rulesYml, rulesConfig());
  await fsp.writeFile(P.grafanaIni, grafanaIni(st));
  await fsp.writeFile(path.join(P.grafanaProvisioning, 'datasources', 'homeport.yml'), grafanaDatasource(st));
  await fsp.writeFile(path.join(P.grafanaProvisioning, 'dashboards', 'homeport.yml'), grafanaDashboardProvider());
  for (const d of allDashboards()) await fsp.writeFile(path.join(P.grafanaDashboards, d.file), JSON.stringify(d.json, null, 2));
}

/** Prometheus runs with --web.enable-lifecycle so config changes apply without a restart. */
export async function reloadPrometheus(): Promise<void> {
  if (!settings().monitoring.enabled) return;
  await writeConfigs();
  try {
    const res = await fetch(`${promUrl()}/-/reload`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    if (!res.ok) activity.warn(`Prometheus reload failed: ${res.status} ${await res.text()}`);
  } catch {
    /* not running yet */
  }
}

// ---------------------------------------------------------------- lifecycle

async function startComponent(key: ComponentKey): Promise<void> {
  const m = settings().monitoring;
  if (key === 'prometheus') {
    await pm2.startBinary(PM2_NAMES.prometheus, m.prometheusBin, [
      `--config.file=${P.prometheusYml}`,
      `--storage.tsdb.path=${P.prometheusData}`,
      `--storage.tsdb.retention.time=${m.retention}`,
      `--web.listen-address=127.0.0.1:${m.prometheusPort}`,
      '--web.enable-lifecycle',
    ]);
  } else if (key === 'nodeExporter') {
    await pm2.startBinary(PM2_NAMES.nodeExporter, m.nodeExporterBin, [`--web.listen-address=127.0.0.1:${m.nodeExporterPort}`]);
  } else {
    const home = await grafanaHome();
    if (!home)
      throw badRequest(
        'Could not find the Grafana install folder. Set "Grafana home" in Settings, for example /opt/homebrew/opt/grafana/share/grafana.',
      );
    const args = ['--homepath', home, '--config', P.grafanaIni];
    await pm2.startBinary(PM2_NAMES.grafana, m.grafanaBin, isLegacyGrafana(m.grafanaBin) ? args : ['server', ...args]);
  }
}

export async function start(): Promise<string[]> {
  const st = settings();
  const notes: string[] = [];
  const versions = await Promise.all(
    (['prometheus', 'grafana', 'nodeExporter'] as const).map(async (k) => [k, await versionOf(k)] as const),
  );
  const missing = versions.filter(([, v]) => !v).map(([k]) => k);
  if (missing.includes('prometheus')) throw badRequest('Prometheus is not installed. Run: brew install prometheus');

  st.monitoring.enabled = true;
  await saveDb();
  // Caddy only exposes HTTP metrics when the global option is set; rewrite + reload it.
  try {
    await caddy.writeCaddyfile();
    await caddy.reload();
  } catch (e) {
    notes.push(`Caddy: ${errMsg(e)}`);
  }
  await writeConfigs();

  for (const key of ['nodeExporter', 'prometheus', 'grafana'] as const) {
    if (missing.includes(key)) {
      notes.push(`${key} is not installed, skipped`);
      continue;
    }
    try {
      await startComponent(key);
    } catch (e) {
      notes.push(`${key}: ${errMsg(e)}`);
    }
  }
  activity.info('Monitoring started');
  return notes;
}

export async function stop(): Promise<void> {
  settings().monitoring.enabled = false;
  await saveDb();
  for (const name of Object.values(PM2_NAMES)) await pm2.remove(name);
  activity.info('Monitoring stopped');
}

export async function restartComponent(key: ComponentKey): Promise<void> {
  await writeConfigs();
  await pm2.remove(PM2_NAMES[key]);
  await startComponent(key);
}

// ---------------------------------------------------------------- status & queries

async function promGet<T>(p: string): Promise<T> {
  const res = await fetch(`${promUrl()}${p}`, { signal: AbortSignal.timeout(8000) });
  const j = (await res.json()) as { status: string; data: T; error?: string };
  if (j.status !== 'success') throw new Error(j.error ?? `Prometheus ${res.status}`);
  return j.data;
}

export async function alerts(): Promise<PromAlert[]> {
  const data = await promGet<{
    alerts: { labels: Record<string, string>; annotations: Record<string, string>; state: string; activeAt: string }[];
  }>('/api/v1/alerts');
  return data.alerts.map((a) => ({
    name: a.labels.alertname ?? 'alert',
    state: a.state,
    severity: a.labels.severity ?? 'warning',
    summary: a.annotations.summary ?? '',
    labels: a.labels,
    activeAt: a.activeAt,
  }));
}

export async function status(): Promise<MonitoringStatus> {
  const m = settings().monitoring;
  const procs = (await pm2.list()).list;
  const defs: [ComponentKey, string, number][] = [
    ['prometheus', 'Prometheus', m.prometheusPort],
    ['grafana', 'Grafana', m.grafanaPort],
    ['nodeExporter', 'Node exporter', m.nodeExporterPort],
  ];
  const components: MonitoringComponent[] = await Promise.all(
    defs.map(async ([key, label, port]) => {
      const version = await versionOf(key);
      return {
        key,
        label,
        version,
        installed: !!version,
        port,
        running: procs.find((p) => p.name === PM2_NAMES[key])?.status === 'online' && (await portOpen('127.0.0.1', port, 500)),
        url: `http://127.0.0.1:${port}`,
        pm2Name: PM2_NAMES[key],
      };
    }),
  );
  const promUp = components[0]!.running;
  let alertList: PromAlert[] = [];
  let targets: MonitoringStatus['targets'] = [];
  if (promUp) {
    try {
      alertList = await alerts();
    } catch {
      /* ignore */
    }
    try {
      const t = await promGet<{ activeTargets: { labels: Record<string, string>; health: string; lastError: string }[] }>(
        '/api/v1/targets?state=active',
      );
      targets = t.activeTargets.map((x) => ({
        job: x.labels.job ?? '',
        instance: x.labels.instance ?? '',
        health: x.health,
        lastError: x.lastError,
      }));
    } catch {
      /* ignore */
    }
  }
  return {
    enabled: m.enabled,
    components,
    caddyMetrics: caddy.cachedMetricsMode() ?? 'unknown',
    grafanaUrl: grafanaUrl(),
    prometheusUrl: promUrl(),
    alerts: alertList,
    targets,
  };
}

/** Named PromQL queries for the dashboard's built-in charts. `app` filters per-app series. */
const PRESETS: Record<string, (app?: string) => { expr: string; legend: string }[]> = {
  hostCpu: () => [{ expr: 'homeport_host_cpu_usage_ratio * 100', legend: 'CPU %' }],
  hostMem: () => [{ expr: 'homeport_host_memory_used_bytes', legend: 'Memory in use' }],
  appCpu: (app) => [{ expr: `homeport_process_cpu_percent{kind="app"${app ? `, name="${app}"` : ''}}`, legend: '{{name}}' }],
  appMem: (app) => [{ expr: `homeport_process_memory_bytes{kind="app"${app ? `, name="${app}"` : ''}}`, legend: '{{name}}' }],
  requests: () => [{ expr: 'sum by (host) (rate(caddy_http_requests_total[5m]))', legend: '{{host}}' }],
  errors: () => [{ expr: 'sum(rate(caddy_http_requests_total{code=~"5.."}[5m]))', legend: '5xx/s' }],
  latency: () => [{ expr: 'histogram_quantile(0.95, sum by (le) (rate(caddy_http_request_duration_seconds_bucket[5m])))', legend: 'p95' }],
  tunnel: () => [{ expr: 'cloudflared_tunnel_ha_connections', legend: '{{tunnel}}' }],
};
export const presetNames = Object.keys(PRESETS);

function renderLegend(tpl: string, labels: Record<string, string>): string {
  const text = tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => labels[k] ?? '').trim();
  return text || 'total';
}

export async function queryRange(preset: string, rangeSec: number, app?: string): Promise<QueryRangeDTO> {
  const build = PRESETS[preset];
  if (!build) throw badRequest('Unknown metric preset');
  if (app && !/^[a-z0-9._-]+$/.test(app)) throw badRequest('Invalid app name');
  if (!settings().monitoring.enabled) return { series: [], available: false, error: 'Monitoring is off' };
  const end = Math.floor(Date.now() / 1000);
  const start = end - rangeSec;
  const stepSec = Math.max(15, Math.round(rangeSec / 120));
  try {
    const series: Series[] = [];
    for (const q of build(app)) {
      const data = await promGet<{ result: { metric: Record<string, string>; values: [number, string][] }[] }>(
        `/api/v1/query_range?query=${encodeURIComponent(q.expr)}&start=${start}&end=${end}&step=${stepSec}`,
      );
      for (const r of data.result) {
        series.push({
          label: renderLegend(q.legend, r.metric),
          points: r.values.map(([t, v]) => ({ t: t * 1000, v: Number(v) })).filter((p) => Number.isFinite(p.v)),
        });
      }
    }
    return { series, available: true };
  } catch (e) {
    return { series: [], available: false, error: errMsg(e) };
  }
}

export function registerMonitoringHooks(): void {
  events.on('config:changed', () => {
    void reloadPrometheus();
  });
}
