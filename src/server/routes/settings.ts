import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PublicSettings, Settings } from '../../shared/types.js';
import { activity } from '../lib/activity.js';
import { badRequest, parse } from '../lib/errors.js';
import { bracesBalanced, hostname, port, RE_PM2NAME, RE_TUNNEL } from '../lib/validators.js';
import { startExporter } from '../monitoring/exporter.js';
import { reloadPrometheus } from '../monitoring/service.js';
import * as caddy from '../services/caddy.js';
import { listZones } from '../services/cloudflareApi.js';
import * as notify from '../services/notify.js';
import { startWebhookServer } from '../services/webhooks.js';
import { db, saveDb, settings } from '../store.js';

const MASK = '••••';
const mask = (v: string) => (v ? MASK + v.slice(-4) : '');
const isMasked = (v: unknown) => typeof v === 'string' && v.startsWith(MASK);

export function publicSettings(): PublicSettings {
  const s = settings();
  return {
    ...s,
    cfApiToken: mask(s.cfApiToken),
    cfApiTokenSet: !!s.cfApiToken,
    notify: {
      ...s.notify,
      telegramBotToken: mask(s.notify.telegramBotToken),
      discordWebhook: s.notify.discordWebhook ? mask(s.notify.discordWebhook) : '',
    },
    telegramTokenSet: !!s.notify.telegramBotToken,
  };
}

const str = z.string().trim();
const snippet = z
  .string()
  .transform((s) => s.replace(/\r/g, ''))
  .refine(bracesBalanced, 'Unbalanced curly braces');

const settingsPatch = z
  .object({
    caddyBin: str.min(1),
    cloudflaredBin: str.min(1),
    pm2Bin: str.min(1),
    caddyfilePath: str.min(1),
    cloudflaredDir: str.min(1),
    appsDir: str.min(1),
    caddyHttpPort: port,
    webhookPort: port,
    portRangeStart: port,
    caddyAdmin: str.regex(/^[A-Za-z0-9.-]+:\d+$/, 'Caddy admin address must look like host:port'),
    caddyPm2Name: str.regex(RE_PM2NAME),
    tunnelPm2Prefix: str.regex(/^[A-Za-z0-9_.-]{1,30}$/),
    defaultTunnel: str.refine((v) => v === '' || RE_TUNNEL.test(v)),
    autoApply: z.boolean(),
    cfApiToken: str,
    caddyGlobalExtra: snippet,
    caddyRawAppend: snippet,
    webhookDomain: z.union([z.literal(''), hostname]),
    appDomain: z.union([z.literal(''), hostname]),
    monitoring: z
      .object({
        prometheusBin: str.min(1),
        grafanaBin: str.min(1),
        grafanaHome: str,
        nodeExporterBin: str.min(1),
        prometheusPort: port,
        grafanaPort: port,
        nodeExporterPort: port,
        metricsPort: port,
        retention: str.regex(/^\d+[dhwy]$/, 'Retention looks like 30d'),
      })
      .partial(),
    analytics: z.object({ enabled: z.boolean(), retentionDays: z.number().int().min(1).max(730) }).partial(),
    uptime: z
      .object({ enabled: z.boolean(), mode: z.enum(['public', 'local']), intervalSec: z.number().int().min(30).max(3600) })
      .partial(),
    statusPage: z.object({ enabled: z.boolean(), title: str.max(80), hosts: z.array(hostname).max(50) }).partial(),
    notify: z
      .object({
        discordWebhook: str.refine(
          (v) => v === '' || isMasked(v) || /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(v),
          'That is not a Discord webhook URL',
        ),
        telegramBotToken: str.refine(
          (v) => v === '' || isMasked(v) || /^\d+:[A-Za-z0-9_-]{30,}$/.test(v),
          'That is not a Telegram bot token',
        ),
        telegramChatId: str.refine((v) => v === '' || /^-?\d+$|^@\w+$/.test(v), 'Invalid Telegram chat ID'),
        onDeploySuccess: z.boolean(),
        onDeployFailed: z.boolean(),
        onAlerts: z.boolean(),
      })
      .partial(),
  })
  .partial();

function applyPatch(st: Settings, p: z.infer<typeof settingsPatch>): void {
  const { monitoring, notify: n, cfApiToken, analytics, uptime, statusPage, ...rest } = p;
  Object.assign(st, rest);
  if (analytics) Object.assign(st.analytics, analytics);
  if (uptime) Object.assign(st.uptime, uptime);
  if (statusPage) Object.assign(st.statusPage, statusPage);
  if (cfApiToken !== undefined && !isMasked(cfApiToken)) st.cfApiToken = cfApiToken;
  if (monitoring) Object.assign(st.monitoring, monitoring);
  if (n) {
    const { discordWebhook, telegramBotToken, ...flags } = n;
    Object.assign(st.notify, flags);
    if (discordWebhook !== undefined && !isMasked(discordWebhook)) st.notify.discordWebhook = discordWebhook;
    if (telegramBotToken !== undefined && !isMasked(telegramBotToken)) st.notify.telegramBotToken = telegramBotToken;
  }
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.put('/api/settings', async (req) => {
    const patch = parse(settingsPatch, req.body);
    const st = settings();
    const before = {
      webhookPort: st.webhookPort,
      metricsPort: st.monitoring.metricsPort,
      monitoring: JSON.stringify(st.monitoring),
      analytics: st.analytics.enabled,
    };
    applyPatch(st, patch);
    const ports = [
      st.caddyHttpPort,
      st.webhookPort,
      st.monitoring.prometheusPort,
      st.monitoring.grafanaPort,
      st.monitoring.nodeExporterPort,
      st.monitoring.metricsPort,
    ];
    if (new Set(ports).size !== ports.length)
      throw badRequest('Two services share a port. Caddy, webhooks and monitoring each need their own.');
    await saveDb();
    activity.info('Settings saved');
    if (st.webhookPort !== before.webhookPort) startWebhookServer();
    if (st.monitoring.metricsPort !== before.metricsPort) startExporter();
    if (JSON.stringify(st.monitoring) !== before.monitoring) await reloadPrometheus();
    if (st.analytics.enabled !== before.analytics) {
      // Turns Caddy's access log on or off.
      await caddy
        .writeCaddyfile()
        .then(() => caddy.reload())
        .catch((e) => activity.warn(`Caddy: ${(e as Error).message}`));
    }
    return { settings: publicSettings() };
  });

  app.post('/api/settings/cf-token/test', async () => ({ zones: (await listZones()).map((z) => z.name) }));
  app.post('/api/settings/notify/test', async () => {
    await notify.sendTest();
    return { ok: true };
  });

  app.get('/api/export', async (_req, reply) => {
    const data = {
      ...db,
      settings: { ...db.settings, cfApiToken: '', notify: { ...db.settings.notify, telegramBotToken: '', discordWebhook: '' } },
      apps: db.apps.map((a) => ({ ...a, gitToken: '' })),
    };
    return reply
      .header('Content-Type', 'application/json')
      .header('Content-Disposition', `attachment; filename="homeport-backup-${new Date().toISOString().slice(0, 10)}.json"`)
      .send(JSON.stringify(data, null, 2));
  });
}
