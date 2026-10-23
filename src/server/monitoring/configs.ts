/**
 * Config files for Prometheus and Grafana. YAML files are written as JSON (valid YAML) so no YAML library is needed
 * and quoting can never go wrong.
 */
import path from 'node:path';
import { paths } from '../config.js';
import { DATASOURCE_UID } from './dashboards.js';
import type { Settings } from '../../shared/types.js';

const HEADER = '# Dibuat otomatis oleh Homeport — jangan edit manual (akan ditimpa)\n';
const yaml = (obj: unknown) => HEADER + JSON.stringify(obj, null, 2) + '\n';

export const monitoringPaths = {
  prometheusYml: path.join(paths.monitoring, 'prometheus', 'prometheus.yml'),
  rulesYml: path.join(paths.monitoring, 'prometheus', 'rules.yml'),
  prometheusData: path.join(paths.monitoring, 'prometheus', 'data'),
  grafanaRoot: path.join(paths.monitoring, 'grafana'),
  grafanaIni: path.join(paths.monitoring, 'grafana', 'grafana.ini'),
  grafanaData: path.join(paths.monitoring, 'grafana', 'data'),
  grafanaLogs: path.join(paths.monitoring, 'grafana', 'logs'),
  grafanaPlugins: path.join(paths.monitoring, 'grafana', 'plugins'),
  grafanaProvisioning: path.join(paths.monitoring, 'grafana', 'provisioning'),
  grafanaDashboards: path.join(paths.monitoring, 'grafana', 'dashboards'),
};

export function prometheusConfig(st: Settings): string {
  const m = st.monitoring;
  const tunnels = Object.entries(st.tunnelMetricsPorts);
  return yaml({
    global: { scrape_interval: '15s', evaluation_interval: '15s', external_labels: { source: 'homeport' } },
    rule_files: ['rules.yml'],
    scrape_configs: [
      { job_name: 'homeport', static_configs: [{ targets: [`127.0.0.1:${m.metricsPort}`] }] },
      { job_name: 'node', static_configs: [{ targets: [`127.0.0.1:${m.nodeExporterPort}`] }] },
      { job_name: 'caddy', static_configs: [{ targets: [st.caddyAdmin] }] },
      ...(tunnels.length
        ? [{ job_name: 'cloudflared', static_configs: tunnels.map(([tunnel, port]) => ({ targets: [`127.0.0.1:${port}`], labels: { tunnel } })) }]
        : []),
      { job_name: 'prometheus', static_configs: [{ targets: [`127.0.0.1:${m.prometheusPort}`] }] },
    ],
  });
}

interface Rule { alert: string; expr: string; for: string; severity: 'critical' | 'warning'; summary: string }

export const ALERT_RULES: Rule[] = [
  {
    alert: 'AppDown', for: '2m', severity: 'critical',
    expr: 'homeport_app_up == 0 unless on(app) homeport_app_deploying == 1',
    summary: 'App {{ $labels.app }} tidak merespon di port-nya',
  },
  {
    alert: 'AppCrashLoop', for: '0m', severity: 'warning',
    expr: 'delta(homeport_process_restarts{kind="app"}[10m]) > 3',
    summary: '{{ $labels.name }} restart {{ $value | humanize }}x dalam 10 menit',
  },
  {
    alert: 'AppHighMemory', for: '10m', severity: 'warning',
    expr: 'homeport_process_memory_bytes{kind="app"} > 1.5e9',
    summary: '{{ $labels.name }} memakai {{ $value | humanize1024 }}B RAM',
  },
  {
    alert: 'DomainUpstreamDown', for: '3m', severity: 'warning',
    expr: 'homeport_site_upstream_up == 0',
    summary: 'Upstream domain {{ $labels.host }} tidak merespon',
  },
  {
    alert: 'TunnelDown', for: '2m', severity: 'critical',
    expr: 'homeport_tunnel_running == 0',
    summary: 'Cloudflare Tunnel {{ $labels.tunnel }} mati — semua domainnya tidak bisa diakses',
  },
  {
    alert: 'TunnelDisconnected', for: '5m', severity: 'critical',
    expr: 'cloudflared_tunnel_ha_connections < 1',
    summary: 'Tunnel {{ $labels.tunnel }} jalan tapi tidak terhubung ke Cloudflare',
  },
  {
    alert: 'CaddyDown', for: '2m', severity: 'critical',
    expr: 'up{job="caddy"} == 0',
    summary: 'Caddy tidak bisa di-scrape (mati?)',
  },
  {
    alert: 'HighErrorRate', for: '5m', severity: 'warning',
    expr: '(sum by (host) (rate(caddy_http_requests_total{code=~"5.."}[5m])) / sum by (host) (rate(caddy_http_requests_total[5m]))) > 0.05',
    summary: 'Lebih dari 5% request ke {{ $labels.host }} error 5xx',
  },
  {
    alert: 'HostDiskAlmostFull', for: '10m', severity: 'warning',
    expr: '1 - homeport_host_disk_available_bytes / homeport_host_disk_total_bytes > 0.9',
    summary: 'Disk terisi {{ $value | humanizePercentage }}',
  },
  {
    alert: 'HostHighMemory', for: '15m', severity: 'warning',
    expr: 'homeport_host_memory_used_bytes / homeport_host_memory_total_bytes > 0.92',
    summary: 'RAM terpakai {{ $value | humanizePercentage }}',
  },
  {
    alert: 'HostHighCpu', for: '15m', severity: 'warning',
    expr: 'homeport_host_cpu_usage_ratio > 0.9',
    summary: 'CPU sibuk {{ $value | humanizePercentage }} selama 15 menit',
  },
];

export function rulesConfig(): string {
  return yaml({
    groups: [{
      name: 'homeport',
      rules: ALERT_RULES.map((r) => ({
        alert: r.alert, expr: r.expr, for: r.for,
        labels: { severity: r.severity },
        annotations: { summary: r.summary },
      })),
    }],
  });
}

export function grafanaIni(st: Settings): string {
  const m = st.monitoring;
  const p = monitoringPaths;
  return `; Dibuat otomatis oleh Homeport — jangan edit manual (akan ditimpa)
[paths]
data = ${p.grafanaData}
logs = ${p.grafanaLogs}
plugins = ${p.grafanaPlugins}
provisioning = ${p.grafanaProvisioning}

[server]
http_addr = 127.0.0.1
http_port = ${m.grafanaPort}
root_url = http://127.0.0.1:${m.grafanaPort}/

[security]
admin_user = admin
admin_password = ${m.grafanaAdminPassword}
allow_embedding = true
cookie_samesite = lax

[auth.anonymous]
enabled = true
org_role = Viewer

[users]
default_theme = dark
allow_sign_up = false

[dashboards]
default_home_dashboard_path = ${path.join(p.grafanaDashboards, 'homeport-overview.json')}

[analytics]
reporting_enabled = false
check_for_updates = false
check_for_plugin_updates = false

[news]
news_feed_enabled = false

[log]
mode = console
level = warn
`;
}

export function grafanaDatasource(st: Settings): string {
  return yaml({
    apiVersion: 1,
    datasources: [{
      name: 'Prometheus (Homeport)', uid: DATASOURCE_UID, type: 'prometheus', access: 'proxy',
      url: `http://127.0.0.1:${st.monitoring.prometheusPort}`, isDefault: true, editable: false,
      jsonData: { timeInterval: '15s', httpMethod: 'POST' },
    }],
  });
}

export function grafanaDashboardProvider(): string {
  return yaml({
    apiVersion: 1,
    providers: [{
      name: 'homeport', folder: 'Homeport', type: 'file', disableDeletion: true, allowUiUpdates: false,
      updateIntervalSeconds: 30, options: { path: monitoringPaths.grafanaDashboards, foldersFromFilesStructure: false },
    }],
  });
}
