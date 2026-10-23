/**
 * Grafana dashboards, built in code so they stay in sync with the metric names Homeport exports.
 * They are provisioned from files, so edits in the Grafana UI are overwritten on the next start.
 */
export const DATASOURCE_UID = 'homeport-prometheus';
const ds = { type: 'prometheus', uid: DATASOURCE_UID };

type Unit = 'percent' | 'percentunit' | 'bytes' | 'reqps' | 's' | 'short' | 'none' | 'Bps' | 'dtdurations';
interface Target { expr: string; legend?: string; instant?: boolean }
interface Pos { x: number; y: number; w: number; h: number }

let nextId = 1;

function targets(ts: Target[]) {
  return ts.map((t, i) => ({
    datasource: ds, refId: String.fromCharCode(65 + i), expr: t.expr,
    legendFormat: t.legend ?? '__auto', range: !t.instant, instant: !!t.instant,
  }));
}

function timeseries(title: string, pos: Pos, ts: Target[], unit: Unit = 'short', opts: { stack?: boolean; bars?: boolean; min?: number; max?: number; description?: string } = {}) {
  return {
    id: nextId++, type: 'timeseries', title, description: opts.description, gridPos: pos, datasource: ds, targets: targets(ts),
    fieldConfig: {
      defaults: {
        unit, min: opts.min, max: opts.max,
        custom: {
          drawStyle: opts.bars ? 'bars' : 'line', lineWidth: 2, fillOpacity: opts.bars ? 80 : 12, gradientMode: 'opacity',
          showPoints: 'never', spanNulls: true, stacking: { mode: opts.stack ? 'normal' : 'none' },
        },
      },
      overrides: [],
    },
    options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'desc' } },
  };
}

function stat(title: string, pos: Pos, t: Target, unit: Unit = 'short', thresholds: [number, string][] = [[0, 'green']], opts: { decimals?: number; mappings?: unknown[]; graph?: boolean } = {}) {
  return {
    id: nextId++, type: 'stat', title, gridPos: pos, datasource: ds, targets: targets([{ ...t, instant: !opts.graph }]),
    fieldConfig: {
      defaults: {
        unit, decimals: opts.decimals, mappings: opts.mappings ?? [],
        thresholds: { mode: 'absolute', steps: thresholds.map(([value, color], i) => ({ color, value: i === 0 ? null : value })) },
      },
      overrides: [],
    },
    options: { colorMode: 'value', graphMode: opts.graph ? 'area' : 'none', justifyMode: 'auto', textMode: 'auto', reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false } },
  };
}

function gauge(title: string, pos: Pos, t: Target, unit: Unit = 'percentunit') {
  return {
    id: nextId++, type: 'gauge', title, gridPos: pos, datasource: ds, targets: targets([{ ...t, instant: true }]),
    fieldConfig: {
      defaults: {
        unit, min: 0, max: unit === 'percentunit' ? 1 : 100,
        thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'orange', value: unit === 'percentunit' ? 0.75 : 75 }, { color: 'red', value: unit === 'percentunit' ? 0.9 : 90 }] },
      },
      overrides: [],
    },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, showThresholdLabels: false, showThresholdMarkers: true },
  };
}

function stateTimeline(title: string, pos: Pos, t: Target) {
  return {
    id: nextId++, type: 'state-timeline', title, gridPos: pos, datasource: ds, targets: targets([t]),
    fieldConfig: {
      defaults: {
        mappings: [{ type: 'value', options: { 0: { text: 'DOWN', color: 'red' }, 1: { text: 'UP', color: 'green' } } }],
        thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'green', value: 1 }] },
        custom: { fillOpacity: 80, lineWidth: 0 },
      },
      overrides: [],
    },
    options: { showValue: 'never', mergeValues: true, rowHeight: 0.8, alignValue: 'left', legend: { showLegend: false } },
  };
}

function table(title: string, pos: Pos, ts: Target[], renames: Record<string, string>, excludes: string[]) {
  return {
    id: nextId++, type: 'table', title, gridPos: pos, datasource: ds,
    targets: targets(ts.map((t) => ({ ...t, instant: true }))).map((t) => ({ ...t, format: 'table' })),
    transformations: [
      { id: 'merge', options: {} },
      { id: 'organize', options: { excludeByName: Object.fromEntries(excludes.map((e) => [e, true])), renameByName: renames } },
    ],
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' } } }, overrides: [] },
    options: { showHeader: true, cellHeight: 'sm' },
  };
}

const row = (title: string, y: number) => ({ id: nextId++, type: 'row', title, collapsed: false, gridPos: { x: 0, y, w: 24, h: 1 }, panels: [] });

function dashboard(uid: string, title: string, panels: unknown[], templating: unknown[] = [], tags: string[] = []) {
  return {
    uid, title, tags: ['homeport', ...tags], timezone: 'browser', schemaVersion: 39, version: 1, editable: true,
    refresh: '30s', time: { from: 'now-6h', to: 'now' }, graphTooltip: 1,
    templating: { list: templating }, annotations: { list: [deployAnnotation] }, panels,
    links: [{ title: 'Homeport', type: 'dashboards', tags: ['homeport'], asDropdown: true, icon: 'external link' }],
  };
}

/** Vertical markers whenever a deploy finishes. */
const deployAnnotation = {
  name: 'Deploys', datasource: ds, enable: true, iconColor: 'rgba(243, 128, 32, 0.9)',
  expr: 'changes(homeport_app_last_deploy_timestamp_seconds[2m]) > 0', step: '60s',
  titleFormat: 'Deploy {{app}}', textFormat: '', useValueForTime: false,
};

const appVar = {
  name: 'app', label: 'App', type: 'query', datasource: ds, query: { query: 'label_values(homeport_app_up, app)', refId: 'apps' },
  definition: 'label_values(homeport_app_up, app)', includeAll: true, multi: true, allValue: '.*', current: { text: 'All', value: '$__all' }, refresh: 2, sort: 1,
};

export function overviewDashboard() {
  nextId = 1;
  const A = 'app=~"$app"';
  const N = 'name=~"$app"';
  return dashboard('homeport-overview', 'Homeport — Overview', [
    stat('Apps online', { x: 0, y: 0, w: 4, h: 4 }, { expr: `sum(homeport_app_up{${A}}) or vector(0)` }, 'short', [[0, 'red'], [1, 'green']]),
    stat('Apps down', { x: 4, y: 0, w: 4, h: 4 }, { expr: `count(homeport_app_up{${A}} == 0 unless on(app) homeport_app_deploying == 1) or vector(0)` }, 'short', [[0, 'green'], [1, 'red']]),
    stat('Deploy 24 jam', { x: 8, y: 0, w: 4, h: 4 }, { expr: 'sum(increase(homeport_deploys_total[24h])) or vector(0)' }, 'short', [[0, 'blue']], { decimals: 0 }),
    stat('Deploy gagal 24 jam', { x: 12, y: 0, w: 4, h: 4 }, { expr: 'sum(increase(homeport_deploys_total{status="failed"}[24h])) or vector(0)' }, 'short', [[0, 'green'], [1, 'orange']], { decimals: 0 }),
    stat('Request/detik', { x: 16, y: 0, w: 4, h: 4 }, { expr: 'sum(rate(caddy_http_requests_total[5m])) or vector(0)' }, 'reqps', [[0, 'blue']], { graph: true }),
    stat('Error 5xx', { x: 20, y: 0, w: 4, h: 4 }, { expr: 'sum(rate(caddy_http_requests_total{code=~"5.."}[5m])) / sum(rate(caddy_http_requests_total[5m])) or vector(0)' }, 'percentunit', [[0, 'green'], [0.01, 'orange'], [0.05, 'red']], { graph: true }),

    row('Apps', 4),
    stateTimeline('Status app', { x: 0, y: 5, w: 24, h: Math.max(4, 6) }, { expr: `homeport_app_up{${A}}`, legend: '{{app}}' }),
    timeseries('CPU per app', { x: 0, y: 11, w: 12, h: 8 }, [{ expr: `homeport_process_cpu_percent{kind="app", ${N}}`, legend: '{{name}}' }], 'percent', { min: 0 }),
    timeseries('Memori per app', { x: 12, y: 11, w: 12, h: 8 }, [{ expr: `homeport_process_memory_bytes{kind="app", ${N}}`, legend: '{{name}}' }], 'bytes', { min: 0 }),
    timeseries('Restart (per jam)', { x: 0, y: 19, w: 12, h: 7 }, [{ expr: `sum by (name) (clamp_min(delta(homeport_process_restarts{kind="app", ${N}}[1h]), 0))`, legend: '{{name}}' }], 'short', { bars: true, min: 0 }),
    table('Versi aktif', { x: 12, y: 19, w: 12, h: 7 }, [
      { expr: `homeport_app_info{${A}}` },
      { expr: `time() - homeport_app_last_deploy_timestamp_seconds{${A}}` },
    ], { app: 'App', branch: 'Branch', commit: 'Commit', 'Value #B': 'Deploy terakhir' }, ['Time', 'Value #A', '__name__', 'instance', 'job']),

    row('Traffic (Caddy)', 26),
    timeseries('Request/detik per domain', { x: 0, y: 27, w: 12, h: 8 }, [{ expr: 'sum by (host) (rate(caddy_http_requests_total[5m]))', legend: '{{host}}' }], 'reqps', { min: 0 }),
    timeseries('Status code', { x: 12, y: 27, w: 12, h: 8 }, [{ expr: 'sum by (code) (rate(caddy_http_requests_total[5m]))', legend: '{{code}}' }], 'reqps', { stack: true, min: 0 }),
    timeseries('Latensi p50 / p95 / p99', { x: 0, y: 35, w: 12, h: 8 }, [
      { expr: 'histogram_quantile(0.5, sum by (le) (rate(caddy_http_request_duration_seconds_bucket[5m])))', legend: 'p50' },
      { expr: 'histogram_quantile(0.95, sum by (le) (rate(caddy_http_request_duration_seconds_bucket[5m])))', legend: 'p95' },
      { expr: 'histogram_quantile(0.99, sum by (le) (rate(caddy_http_request_duration_seconds_bucket[5m])))', legend: 'p99' },
    ], 's', { min: 0 }),
    timeseries('Latensi p95 per domain', { x: 12, y: 35, w: 12, h: 8 }, [{ expr: 'histogram_quantile(0.95, sum by (le, host) (rate(caddy_http_request_duration_seconds_bucket[5m])))', legend: '{{host}}' }], 's', { min: 0 }),

    row('Cloudflare Tunnel', 43),
    timeseries('Koneksi edge aktif', { x: 0, y: 44, w: 8, h: 7 }, [{ expr: 'cloudflared_tunnel_ha_connections', legend: '{{tunnel}}' }], 'short', { min: 0, description: 'Normalnya 4 koneksi per tunnel' }),
    timeseries('Request lewat tunnel', { x: 8, y: 44, w: 8, h: 7 }, [{ expr: 'sum by (tunnel) (rate(cloudflared_tunnel_total_requests[5m]))', legend: '{{tunnel}}' }], 'reqps', { min: 0 }),
    timeseries('Error tunnel', { x: 16, y: 44, w: 8, h: 7 }, [{ expr: 'sum by (tunnel) (rate(cloudflared_tunnel_request_errors[5m]))', legend: '{{tunnel}}' }], 'reqps', { min: 0 }),

    row('Deploy', 51),
    timeseries('Deploy per jam', { x: 0, y: 52, w: 12, h: 7 }, [{ expr: 'sum by (status) (increase(homeport_deploys_total[1h]))', legend: '{{status}}' }], 'short', { bars: true, stack: true, min: 0 }),
    timeseries('Durasi deploy (p50)', { x: 12, y: 52, w: 12, h: 7 }, [{ expr: 'histogram_quantile(0.5, sum by (le, app) (rate(homeport_deploy_duration_seconds_bucket[6h])))', legend: '{{app}}' }], 's', { min: 0 }),
  ], [appVar], ['overview']);
}

export function hostDashboard() {
  nextId = 1;
  const fs = 'fstype!~"tmpfs|devfs|autofs|nullfs|overlay|squashfs"';
  return dashboard('homeport-host', 'Homeport — Mac mini', [
    gauge('CPU', { x: 0, y: 0, w: 6, h: 6 }, { expr: 'homeport_host_cpu_usage_ratio' }),
    gauge('Memori', { x: 6, y: 0, w: 6, h: 6 }, { expr: 'homeport_host_memory_used_bytes / homeport_host_memory_total_bytes' }),
    gauge('Disk', { x: 12, y: 0, w: 6, h: 6 }, { expr: '1 - homeport_host_disk_available_bytes / homeport_host_disk_total_bytes' }),
    stat('Uptime', { x: 18, y: 0, w: 6, h: 3 }, { expr: 'time() - node_boot_time_seconds' }, 'dtdurations', [[0, 'blue']]),
    stat('Load (1m)', { x: 18, y: 3, w: 6, h: 3 }, { expr: 'homeport_host_load{period="1m"}' }, 'short', [[0, 'green'], [4, 'orange'], [8, 'red']], { decimals: 2 }),

    row('CPU & memori', 6),
    timeseries('CPU', { x: 0, y: 7, w: 12, h: 8 }, [
      { expr: 'sum by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / scalar(count(count by (cpu) (node_cpu_seconds_total)))', legend: '{{mode}}' },
    ], 'percentunit', { stack: true, min: 0, max: 1 }),
    timeseries('Memori', { x: 12, y: 7, w: 12, h: 8 }, [
      { expr: 'homeport_host_memory_used_bytes', legend: 'dipakai' },
      { expr: 'homeport_host_memory_total_bytes', legend: 'total' },
      { expr: 'sum(homeport_process_memory_bytes)', legend: 'semua proses pm2' },
    ], 'bytes', { min: 0 }),
    timeseries('Load average', { x: 0, y: 15, w: 12, h: 7 }, [{ expr: 'homeport_host_load', legend: '{{period}}' }], 'short', { min: 0 }),
    timeseries('CPU per proses pm2', { x: 12, y: 15, w: 12, h: 7 }, [{ expr: 'topk(8, homeport_process_cpu_percent)', legend: '{{name}}' }], 'percent', { min: 0 }),

    row('Disk & jaringan', 22),
    timeseries('Ruang disk terpakai', { x: 0, y: 23, w: 8, h: 8 }, [{ expr: `1 - node_filesystem_avail_bytes{${fs}} / node_filesystem_size_bytes{${fs}}`, legend: '{{mountpoint}}' }], 'percentunit', { min: 0, max: 1 }),
    timeseries('Disk I/O', { x: 8, y: 23, w: 8, h: 8 }, [
      { expr: 'sum(rate(node_disk_read_bytes_total[5m]))', legend: 'baca' },
      { expr: 'sum(rate(node_disk_written_bytes_total[5m]))', legend: 'tulis' },
    ], 'Bps', { min: 0 }),
    timeseries('Jaringan', { x: 16, y: 23, w: 8, h: 8 }, [
      { expr: 'sum(rate(node_network_receive_bytes_total{device!~"lo.*|utun.*|awdl.*|llw.*|bridge.*|gif.*|stf.*|anpi.*|ap.*"}[5m]))', legend: 'masuk' },
      { expr: 'sum(rate(node_network_transmit_bytes_total{device!~"lo.*|utun.*|awdl.*|llw.*|bridge.*|gif.*|stf.*|anpi.*|ap.*"}[5m]))', legend: 'keluar' },
    ], 'Bps', { min: 0 }),
  ], [], ['host']);
}

export const allDashboards = () => [
  { file: 'homeport-overview.json', json: overviewDashboard() },
  { file: 'homeport-host.json', json: hostDashboard() },
];
