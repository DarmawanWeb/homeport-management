import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';
import { activity } from '../lib/activity.js';
import { badRequest, parse } from '../lib/errors.js';
import { events } from '../lib/events.js';
import { RE_PM2NAME, tunnelName } from '../lib/validators.js';
import { db, saveDb, settings } from '../store.js';
import * as caddy from '../services/caddy.js';
import * as cloudflared from '../services/cloudflared.js';
import * as pm2 from '../services/pm2.js';
import { applyAll, createSite, deleteSite, findSite, toggleSite, updateSite } from '../services/sites.js';
import { portOpen } from '../lib/net.js';
import { publicSettings } from './settings.js';
import type { StateDTO, StatusDTO, TunnelView } from '../../shared/types.js';

type IdParams = { Params: { id: string } };
type NameParams = { Params: { name: string } };

const pm2NameParam = (name: string) => { if (!RE_PM2NAME.test(name)) throw badRequest('Nama proses tidak valid'); return name; };

export async function infraRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- state & status
  app.get('/api/state', async (): Promise<StateDTO> => ({ sites: db.sites, settings: publicSettings(), authRequired: !!env.password, platform: process.platform }));

  app.get('/api/status', async (): Promise<StatusDTO> => {
    const st = settings();
    const [caddyVersion, cfVersion, pm2Version, adminUp, procs, proxyUp] = await Promise.all([
      caddy.version(), cloudflared.version(), pm2.version(), caddy.adminUp(), pm2.list(), portOpen('127.0.0.1', st.caddyHttpPort, 500),
    ]);
    return {
      caddy: { version: caddyVersion, adminUp, proxyUp, pm2: procs.list.find((p) => p.name === st.caddyPm2Name) ?? null },
      cloudflared: { version: cfVersion, loggedIn: cloudflared.loggedIn() },
      pm2: { version: pm2Version, error: procs.error },
      caddyfileExists: fs.existsSync(st.caddyfilePath),
    };
  });

  app.get('/api/logs', async () => ({ logs: activity.recent() }));

  // ---------------------------------------------------------------- sites (domains)
  app.get('/api/sites/health', async () => {
    const out: Record<string, boolean> = {};
    await Promise.all(db.sites.map(async (s) => { out[s.id] = await portOpen(s.upstreamHost, s.upstreamPort); }));
    return out;
  });
  app.post('/api/sites', async (req) => createSite(req.body));
  app.put<IdParams>('/api/sites/:id', async (req) => updateSite(req.params.id, req.body as Record<string, unknown>));
  app.post<IdParams>('/api/sites/:id/toggle', async (req) => toggleSite(req.params.id));
  app.post<IdParams>('/api/sites/:id/route-dns', async (req) => {
    const s = findSite(req.params.id);
    if (!s.tunnel) throw badRequest('Domain belum punya tunnel');
    await cloudflared.routeDns(s.tunnel, s.hostname, true);
    return { ok: true };
  });
  app.delete<IdParams & { Querystring: { dns?: string } }>('/api/sites/:id', async (req) => deleteSite(req.params.id, req.query.dns === '1'));

  // ---------------------------------------------------------------- tunnels
  app.get<{ Querystring: { refresh?: string } }>('/api/tunnels', async (req): Promise<{ tunnels: TunnelView[] }> => {
    const list = await cloudflared.list(req.query.refresh === '1');
    if (!settings().defaultTunnel && list.length === 1) { settings().defaultTunnel = list[0]!.name; await saveDb(); }
    const procs = (await pm2.list()).list;
    return {
      tunnels: list.map((t) => {
        const proc = procs.find((p) => p.name === cloudflared.pm2Name(t.name));
        return {
          ...t,
          sites: db.sites.filter((s) => s.tunnel === t.name).map((s) => s.hostname),
          configFile: fs.existsSync(cloudflared.configPath(t.name)) ? cloudflared.configPath(t.name) : null,
          credentials: cloudflared.hasCredentials(t.id),
          metricsPort: settings().tunnelMetricsPorts[t.name] ?? null,
          pm2: proc ? { status: proc.status, restarts: proc.restarts, uptime: proc.uptime } : null,
        };
      }),
    };
  });

  app.post('/api/tunnels', async (req) => {
    const body = parse(z.object({ name: tunnelName, start: z.boolean().default(true) }), req.body);
    const tunnel = await cloudflared.create(body.name);
    if (body.start && tunnel) {
      await cloudflared.start(body.name);
      events.emit('config:changed');
    }
    return { tunnel, started: body.start && !!tunnel };
  });

  app.post<NameParams & { Params: { action: string } }>('/api/tunnels/:name/:action', async (req) => {
    const name = parse(tunnelName, req.params.name);
    switch (req.params.action) {
      case 'start':
      case 'restart': await cloudflared.start(name); events.emit('config:changed'); break;
      case 'stop': await cloudflared.stop(name); break;
      case 'cleanup': await cloudflared.cleanup(name); break;
      case 'default': settings().defaultTunnel = name; await saveDb(); break;
      default: throw badRequest('Aksi tidak valid');
    }
    cloudflared.invalidate();
    return { ok: true };
  });

  app.get<NameParams>('/api/tunnels/:name/config', async (req) => cloudflared.ingressText(parse(tunnelName, req.params.name)));

  app.delete<NameParams & { Querystring: { dns?: string } }>('/api/tunnels/:name', async (req) => {
    const steps = await cloudflared.remove(parse(tunnelName, req.params.name), req.query.dns === '1');
    events.emit('config:changed');
    return { steps };
  });

  app.post('/api/cloudflared/login', async () => cloudflared.login());

  // ---------------------------------------------------------------- caddy
  app.get('/api/caddyfile', async () => {
    const file = settings().caddyfilePath;
    return { generated: await caddy.current(), current: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, file };
  });

  app.post<{ Params: { action: string } }>('/api/caddy/:action', async (req) => {
    switch (req.params.action) {
      case 'apply': return applyAll();
      case 'validate': return caddy.validate(await caddy.current());
      case 'start': return { ok: true, note: await caddy.start() };
      case 'stop': await caddy.stop(); return { ok: true };
      case 'reload': await caddy.writeCaddyfile(); return caddy.reload();
      default: throw badRequest('Aksi tidak valid');
    }
  });

  app.post('/api/caddy-hash', async (req) => {
    const { password } = parse(z.object({ password: z.string().min(1, 'password kosong') }), req.body);
    return { hash: await caddy.hashPassword(password) };
  });

  // ---------------------------------------------------------------- pm2
  app.get('/api/pm2', async () => pm2.list(true));
  app.post('/api/pm2/save', async () => { pm2.must(await pm2.pm2(['save']), 'pm2 save'); return { ok: true }; });
  app.post<{ Params: { name: string; action: string } }>('/api/pm2/:name/:action', async (req) => {
    const action = parse(z.enum(['restart', 'stop', 'start', 'reload']), req.params.action);
    await pm2.action(pm2NameParam(req.params.name), action);
    return { ok: true };
  });
  app.get<NameParams>('/api/pm2/:name/logs', async (req) => ({ text: await pm2.logs(pm2NameParam(req.params.name)) }));
}
