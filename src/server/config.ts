import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Settings } from '../shared/types.js';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';

/** Project root (works from src/server via tsx and from dist/server after build). */
export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DATA_DIR = path.resolve(process.env.TM_DATA_DIR || path.join(ROOT, 'data'));

export const env = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 7070),
  password: process.env.TM_PASSWORD || '',
};

export const paths = {
  db: path.join(DATA_DIR, 'db.json'),
  tunnels: path.join(DATA_DIR, 'tunnels'),
  backups: path.join(DATA_DIR, 'backups'),
  ecosystem: path.join(DATA_DIR, 'ecosystem'),
  deployLogs: path.join(DATA_DIR, 'deploy-logs'),
  caddyValidate: path.join(DATA_DIR, 'Caddyfile.validate'),
  monitoring: path.join(DATA_DIR, 'monitoring'),
  web: path.join(ROOT, 'dist', 'web'),
};

/** pm2/launchd often start with a minimal PATH — make Homebrew binaries visible. */
export function extendPath(): void {
  if (IS_WIN) return;
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(os.homedir(), '.local/bin')];
  const cur = (process.env.PATH || '').split(':').filter(Boolean);
  process.env.PATH = [...cur, ...extra.filter((p) => !cur.includes(p))].join(':');
}

export const RESERVED_PORTS = (s: Settings): number[] => [
  env.port, s.caddyHttpPort, s.webhookPort, 2019,
  s.monitoring.prometheusPort, s.monitoring.grafanaPort, s.monitoring.nodeExporterPort, s.monitoring.metricsPort,
  ...Object.values(s.tunnelMetricsPorts),
];

export function defaultSettings(): Settings {
  return {
    caddyBin: 'caddy',
    cloudflaredBin: 'cloudflared',
    pm2Bin: IS_WIN ? 'pm2.cmd' : 'pm2',
    caddyfilePath: path.join(DATA_DIR, 'Caddyfile'),
    caddyHttpPort: 8080,
    caddyAdmin: 'localhost:2019',
    cloudflaredDir: path.join(os.homedir(), '.cloudflared'),
    caddyPm2Name: 'hp-caddy',
    tunnelPm2Prefix: 'hp-cf-',
    defaultTunnel: '',
    autoApply: true,
    cfApiToken: '',
    caddyGlobalExtra: '',
    caddyRawAppend: '',
    appsDir: path.join(os.homedir(), 'apps'),
    webhookPort: 9000,
    webhookDomain: '',
    portRangeStart: 3001,
    tunnelMetricsPorts: {},
    monitoring: {
      enabled: false,
      prometheusBin: 'prometheus',
      grafanaBin: 'grafana',
      grafanaHome: '',
      nodeExporterBin: 'node_exporter',
      prometheusPort: 9090,
      grafanaPort: 3300,
      nodeExporterPort: 9100,
      metricsPort: 9101,
      retention: '30d',
      grafanaAdminPassword: '',
    },
    notify: {
      discordWebhook: '',
      telegramBotToken: '',
      telegramChatId: '',
      onDeploySuccess: true,
      onDeployFailed: true,
      onAlerts: true,
    },
  };
}
