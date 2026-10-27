// Types shared between the server and the web UI.

export type DeployStatus = 'queued' | 'running' | 'success' | 'failed' | 'skipped' | 'interrupted';
export type DeployTrigger = 'manual' | 'webhook' | 'poll' | 'rollback';
export type AutoDeploy = 'webhook' | 'poll' | 'off';

export interface Site {
  id: string;
  hostname: string;
  upstreamHost: string;
  upstreamPort: number;
  scheme: 'http' | 'https';
  tlsInsecure: boolean;
  tunnel: string;
  pm2Name: string;
  enabled: boolean;
  compress: boolean;
  basicAuthUser: string;
  basicAuthHash: string;
  extra: string;
  notes: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CommitInfo {
  sha: string;
  msg: string;
  author: string;
  date?: string;
}

export interface App {
  id: string;
  name: string;
  repo: string;
  branch: string;
  port: number;
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  env: Record<string, string>;
  autoDeploy: AutoDeploy;
  pollInterval: number;
  autoRollback: boolean;
  healthTimeout: number;
  maxMemory: string;
  gitToken: string;
  webhookSecret: string;
  notes: string;
  createdAt: string;
  updatedAt?: string;
  lastGoodCommit?: string | null;
  currentCommit?: CommitInfo | null;
  lastRemoteSha?: string | null;
  lastDeploy?: { id: string; status: DeployStatus; at: string; rolledBackTo: string | null } | null;
  lastWebhookAt?: string | null;
}

export interface Deploy {
  id: string;
  appId: string;
  app: string;
  trigger: DeployTrigger;
  status: DeployStatus;
  target: string | null;
  pushedBy: string | null;
  pushMsg: string | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  duration?: number;
  commit?: string;
  msg?: string;
  author?: string;
  error?: string;
  rolledBackTo?: string;
  commands?: { install: string; build: string; start: string };
}

export interface NotifySettings {
  discordWebhook: string;
  telegramBotToken: string;
  telegramChatId: string;
  onDeploySuccess: boolean;
  onDeployFailed: boolean;
  onAlerts: boolean;
}

export interface MonitoringSettings {
  enabled: boolean;
  prometheusBin: string;
  grafanaBin: string;
  grafanaHome: string;
  nodeExporterBin: string;
  prometheusPort: number;
  grafanaPort: number;
  nodeExporterPort: number;
  metricsPort: number;
  retention: string;
  grafanaAdminPassword: string;
}

export interface Settings {
  caddyBin: string;
  cloudflaredBin: string;
  pm2Bin: string;
  caddyfilePath: string;
  caddyHttpPort: number;
  caddyAdmin: string;
  cloudflaredDir: string;
  caddyPm2Name: string;
  tunnelPm2Prefix: string;
  defaultTunnel: string;
  autoApply: boolean;
  cfApiToken: string;
  caddyGlobalExtra: string;
  caddyRawAppend: string;
  appsDir: string;
  webhookPort: number;
  webhookDomain: string;
  /** Like vercel.app: new apps default to <name>.<appDomain>. Empty for none. */
  appDomain: string;
  portRangeStart: number;
  tunnelMetricsPorts: Record<string, number>;
  monitoring: MonitoringSettings;
  notify: NotifySettings;
  analytics: AnalyticsSettings;
  uptime: UptimeSettings;
  statusPage: StatusPageSettings;
}

export interface DbShape {
  version: number;
  settings: Settings;
  sites: Site[];
  apps: App[];
  deploys: Deploy[];
}

// ---------------------------------------------------------------- API DTOs

export interface ActivityEntry {
  t: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
  detail: string;
}

export interface Pm2Proc {
  name: string;
  id: number;
  status: string;
  cpu: number;
  mem: number;
  uptime: number | null;
  restarts: number;
  port: number | null;
}

/** Settings as returned to the browser: secrets masked. */
export type PublicSettings = Settings & { cfApiTokenSet: boolean; telegramTokenSet: boolean };

export interface StateDTO {
  sites: Site[];
  settings: PublicSettings;
  platform: string;
  flavor: Flavor;
  flavorLabel: string;
  /** How to install or update each external tool here (brew, the Linux installer, the Docker image). */
  hints: Record<ToolKey, string>;
}

export type Flavor = 'mac' | 'linux' | 'synology' | 'docker' | 'windows';
export type ToolKey = 'caddy' | 'cloudflared' | 'prometheus' | 'grafana' | 'nodeExporter' | 'git';

export interface StatusDTO {
  caddy: { version: string | null; adminUp: boolean; proxyUp: boolean; pm2: Pm2Proc | null };
  cloudflared: { version: string | null; loggedIn: boolean };
  pm2: { version: string | null; error: string | null };
  caddyfileExists: boolean;
}

export interface TunnelView {
  id: string;
  name: string;
  created: string;
  connections: number;
  sites: string[];
  configFile: string | null;
  credentials: boolean;
  metricsPort: number | null;
  pm2: { status: string; restarts: number; uptime: number | null } | null;
}

export type PublicApp = Omit<App, 'webhookSecret'> & { dir: string; gitTokenSet: boolean; webhookUrl: string | null };

export interface AppView extends PublicApp {
  deploying: boolean;
  pm2: { status: string; cpu: number; mem: number; uptime: number | null; restarts: number } | null;
  up: boolean;
  domains: string[];
  /** Newest first, at most 20 — drives the deploy history strip. */
  recentDeploys: Pick<Deploy, 'id' | 'status' | 'createdAt' | 'commit' | 'msg' | 'trigger' | 'rolledBackTo'>[];
}

export interface AppsDTO {
  apps: AppView[];
  nextPort: number;
  webhookDomain: string;
  webhookPort: number;
}

export interface SystemDTO {
  hostname: string;
  platform: string;
  node: string;
  uptime: number;
  load: number[];
  cpus: number;
  cpuModel: string;
  mem: { total: number; free: number };
  disk: { total: number; used: number; avail: number } | null;
  pm2: { total: number; online: number; mem: number };
  counts: { apps: number; sites: number };
  recentDeploys: Deploy[];
}

export type ComponentKey = 'prometheus' | 'grafana' | 'nodeExporter';

export interface MonitoringComponent {
  key: ComponentKey;
  label: string;
  version: string | null;
  installed: boolean;
  running: boolean;
  port: number;
  url: string;
  pm2Name: string;
}

export interface MonitoringStatus {
  enabled: boolean;
  components: MonitoringComponent[];
  caddyMetrics: 'per_host' | 'servers' | 'none' | 'unknown';
  grafanaUrl: string;
  prometheusUrl: string;
  alerts: PromAlert[];
  targets: { job: string; instance: string; health: string; lastError: string }[];
}

export interface PromAlert {
  name: string;
  state: string;
  severity: string;
  summary: string;
  labels: Record<string, string>;
  activeAt: string;
}

export interface SeriesPoint {
  t: number;
  v: number;
}
export interface Series {
  label: string;
  points: SeriesPoint[];
}
export interface QueryRangeDTO {
  series: Series[];
  available: boolean;
  error?: string;
}

// ---------------------------------------------------------------- auth

export interface AuthStatusDTO {
  passwordSet: boolean;
  authenticated: boolean;
  /** The browser is on the Mac itself, not coming in through a public hostname. */
  local: boolean;
  /** The signed-in account, if any. */
  user: { id: string; username: string; role: 'admin' | 'viewer' } | null;
  /** Two-factor is on for the signed-in account. */
  totpEnabled: boolean;
  flavor: Flavor;
  /** Where to read the one-time setup code, while no password exists. */
  setupCodeWhere: string;
  publicUrls: string[];
}

export interface SessionView {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
  via: 'local' | 'remote';
  current: boolean;
}

export interface UserView {
  id: string;
  username: string;
  role: 'admin' | 'viewer';
  totpEnabled: boolean;
  recoveryCodesLeft: number;
  createdAt: string;
  lastSignInAt: string;
  /** Signed-in devices. */
  sessions: number;
  you: boolean;
}

export interface PublicAccessDTO {
  sites: { id: string; hostname: string; tunnel: string; enabled: boolean }[];
  defaultTunnel: string;
  dashboardPort: number;
}

export interface NetworkDTO {
  /** Address the dashboard is bound to right now. */
  bind: string;
  /** Reachable from other devices on the network. */
  lan: boolean;
  port: number;
  /** Addresses other devices can use (Bonjour name first, then IPs). */
  urls: string[];
  /** Homeport runs under pm2 and can restart itself to apply a change. */
  canChange: boolean;
  /** macOS application firewall state, or null when not applicable. */
  firewall: 'on' | 'off' | null;
  firewallFix: string;
}

// ---------------------------------------------------------------- analytics, uptime, network

export interface AnalyticsSettings {
  /** Caddy writes an access log for every public domain and Homeport aggregates it. */
  enabled: boolean;
  retentionDays: number;
}

export interface UptimeSettings {
  enabled: boolean;
  /** public: https://<domain>/ through Cloudflare (end to end). local: through Caddy only. */
  mode: 'public' | 'local';
  intervalSec: number;
}

export interface StatusPageSettings {
  enabled: boolean;
  title: string;
  /** Domains shown; empty means every checked domain. */
  hosts: string[];
}

export type AnalyticsRange = '1h' | '24h' | '7d' | '30d';
export interface CountItem {
  name: string;
  count: number;
}
export interface AnalyticsTotals {
  visitors: number;
  pageviews: number;
  requests: number;
  bytes: number;
  errors: number;
  errorRate: number;
  avgDuration: number;
  p95: number;
}
export interface AnalyticsDTO {
  range: AnalyticsRange;
  host: string;
  hosts: string[];
  enabled: boolean;
  /** Caddy's access log exists. */
  receiving: boolean;
  /** City-level headers from Cloudflare have been seen. */
  locationHeaders: boolean;
  totals: AnalyticsTotals;
  previous: AnalyticsTotals;
  series: { t: number; visitors: number; pageviews: number; requests: number; errors: number }[];
  countries: { code: string; visitors: number; pageviews: number }[];
  cities: { name: string; country: string; lat: number | null; lon: number | null; visitors: number }[];
  pages: CountItem[];
  referrers: CountItem[];
  browsers: CountItem[];
  os: CountItem[];
  devices: CountItem[];
  status: { '2xx': number; '3xx': number; '4xx': number; '5xx': number };
  bots: number;
  live: {
    activeNow: number;
    recent: {
      ts: number;
      host: string;
      path: string;
      country: string;
      city: string;
      device: string;
      browser: string;
      os: string;
      referrer: string;
    }[];
  };
}

export interface UptimeCheck {
  ts: number;
  ok: boolean;
  status: number | null;
  ms: number | null;
  error?: string;
}
export interface UptimeIncident {
  host: string;
  start: number;
  end: number | null;
  cause: string;
}
export interface UptimeHost {
  host: string;
  state: 'up' | 'down' | 'unknown';
  last: UptimeCheck | null;
  uptime24h: number | null;
  uptime7d: number | null;
  uptime30d: number | null;
  avgMs24h: number | null;
  /** 90 days, oldest first; null where there is no data. */
  days: { day: string; uptime: number | null }[];
  /** Last 60 checks, oldest first, for a latency sparkline. */
  recent: UptimeCheck[];
}
export interface UptimeDTO {
  enabled: boolean;
  mode: 'public' | 'local';
  hosts: UptimeHost[];
  incidents: UptimeIncident[];
  statusPage: StatusPageSettings;
}
export interface PublicStatusDTO {
  title: string;
  state: 'operational' | 'degraded' | 'down' | 'unknown';
  hosts: Pick<UptimeHost, 'host' | 'state' | 'uptime30d' | 'days'>[];
  incidents: UptimeIncident[];
  updatedAt: number;
}

export interface NetIface {
  name: string;
  rxRate: number;
  txRate: number;
  rxTotal: number;
  txTotal: number;
}
export interface NetworkStatsDTO {
  interfaces: NetIface[];
  /** Bytes per second, sampled every 15 s for the last hour. */
  throughput: { t: number; rx: number; tx: number }[];
  internet: {
    up: boolean | null;
    latencyMs: number | null;
    lossPct: number;
    dnsMs: number | null;
    series: { t: number; ms: number | null }[];
    publicIp: string | null;
    country: string | null;
    colo: string | null;
    checkedAt: number | null;
  };
  tunnels: { name: string; connections: number; edges: string[] }[];
}
