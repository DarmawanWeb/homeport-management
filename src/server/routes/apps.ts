import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound, parse } from '../lib/errors.js';
import { db, settings } from '../store.js';
import * as apps from '../services/apps.js';
import { readLog } from '../services/deploy.js';
import { systemInfo } from '../services/system.js';
import * as monitoring from '../monitoring/service.js';
import type { ComponentKey } from '../../shared/types.js';

type IdParams = { Params: { id: string } };

export async function appRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- apps
  app.get('/api/apps', async () => apps.listApps());
  app.post('/api/apps', async (req) => apps.createApp(req.body as Record<string, unknown>));
  app.put<IdParams>('/api/apps/:id', async (req) => apps.updateApp(req.params.id, req.body as Record<string, unknown>));
  app.delete<IdParams & { Querystring: { files?: string; site?: string } }>('/api/apps/:id', async (req) =>
    apps.deleteApp(req.params.id, { files: req.query.files === '1', sites: req.query.site === '1' }));

  app.post<IdParams>('/api/apps/:id/deploy', async (req) => {
    const { commit } = parse(z.object({ commit: z.string().optional() }), req.body ?? {});
    return { deploy: apps.deployApp(req.params.id, commit) };
  });
  app.post<IdParams>('/api/apps/:id/secret', async (req) => ({ secret: await apps.regenerateSecret(req.params.id) }));
  app.get<IdParams>('/api/apps/:id/webhook', async (req) => {
    const a = apps.findApp(req.params.id);
    return { url: apps.toPublic(a).webhookUrl, secret: a.webhookSecret, lastWebhookAt: a.lastWebhookAt ?? null, webhookDomain: settings().webhookDomain };
  });
  app.get<IdParams>('/api/apps/:id/commits', async (req) => apps.commits(req.params.id));
  app.post<IdParams & { Params: { action: string } }>('/api/apps/:id/:action', async (req) => {
    await apps.appAction(req.params.id, parse(z.enum(['restart', 'stop', 'start']), req.params.action));
    return { ok: true };
  });

  // ---------------------------------------------------------------- deploys
  app.get<{ Querystring: { app?: string } }>('/api/deploys', async (req) => ({
    deploys: db.deploys.filter((d) => !req.query.app || d.appId === req.query.app).slice(0, 60),
  }));
  app.get<IdParams & { Querystring: { offset?: string } }>('/api/deploys/:id/log', async (req) => {
    const rec = db.deploys.find((d) => d.id === req.params.id);
    if (!rec) throw notFound('Deploy tidak ditemukan');
    const log = await readLog(rec.id, Math.max(0, Number(req.query.offset) || 0));
    return { ...log, status: rec.status, rec };
  });

  // ---------------------------------------------------------------- system & monitoring
  app.get('/api/system', async () => systemInfo());

  app.get('/api/monitoring', async () => monitoring.status());
  app.post('/api/monitoring/start', async () => ({ notes: await monitoring.start() }));
  app.post('/api/monitoring/stop', async () => { await monitoring.stop(); return { ok: true }; });
  app.post<{ Params: { key: string } }>('/api/monitoring/:key/restart', async (req) => {
    await monitoring.restartComponent(parse(z.enum(['prometheus', 'grafana', 'nodeExporter']), req.params.key) as ComponentKey);
    return { ok: true };
  });
  app.get('/api/monitoring/credentials', async () => ({ user: 'admin', password: settings().monitoring.grafanaAdminPassword }));
  app.get<{ Querystring: { preset?: string; range?: string; app?: string } }>('/api/monitoring/query', async (req) => {
    const range = Math.min(7 * 86400, Math.max(300, Number(req.query.range) || 3600));
    return monitoring.queryRange(req.query.preset ?? '', range, req.query.app || undefined);
  });
}
