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
  portRangeStart: number;
  tunnelMetricsPorts: Record<string, number>;
  monitoring: MonitoringSettings;
  notify: NotifySettings;
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

export interface PublicAccessDTO {
  sites: { id: string; hostname: string; tunnel: string; enabled: boolean }[];
  defaultTunnel: string;
  dashboardPort: number;
}
