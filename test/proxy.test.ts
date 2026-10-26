import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-proxy-'));
process.env.TM_DATA_DIR = dir;
delete process.env.TM_PASSWORD;

const { buildApp } = await import('../src/server/app.js');
const { loadAuth } = await import('../src/server/auth/store.js');
const { settings } = await import('../src/server/store.js');

/** Stand-in for Grafana and Prometheus: answers with what it received. */
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const upstream = http.createServer((req, res) => {
  seen.push({ url: req.url ?? '', headers: req.headers });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ url: req.url, user: req.headers['x-webauth-user'] ?? null, role: req.headers['x-webauth-role'] ?? null }));
});

let app: FastifyInstance;
let admin = '';
beforeAll(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const port = (upstream.address() as AddressInfo).port;
  settings().monitoring.grafanaPort = port;
  settings().monitoring.prometheusPort = port;
  loadAuth();
  app = await buildApp();
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/setup',
    headers: { host: '127.0.0.1:7070', 'x-homeport': '1' },
    payload: { username: 'agus', password: 'tide-lantern-gravel' },
  });
  admin = r.cookies.find((c) => c.name === 'hp_session')?.value ?? '';
});
afterAll(async () => {
  await app.close();
  upstream.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}, method: InjectOptions['method'] = 'GET') =>
  app.inject({ method, url, remoteAddress: '192.168.1.50', headers: { host: 'deploy.example.com', ...headers } });

describe('Grafana and Prometheus through Homeport', () => {
  it('sends browsers without a session to sign in, and comes back after', async () => {
    const page = await get('/grafana/d/homeport-overview', { accept: 'text/html' });
    expect(page.statusCode).toBe(302);
    expect(page.headers.location).toBe('/?next=%2Fgrafana%2Fd%2Fhomeport-overview');
    expect((await get('/prometheus/api/v1/query?query=up')).statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('signs the Homeport user into Grafana and ignores spoofed identity headers', async () => {
    const r = await get('/grafana/api/user', { cookie: `hp_session=${admin}; grafana_session=abc`, 'x-webauth-user': 'admin2' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ url: '/grafana/api/user', user: 'agus', role: 'Admin' });
    const last = seen.at(-1)!;
    // Homeport's own session never reaches Grafana; Grafana's cookie does.
    expect(last.headers.cookie).toBe('grafana_session=abc');
  });

  it('strips the /prometheus prefix and blocks reload, quit and admin endpoints', async () => {
    const r = await get('/prometheus/api/v1/query?query=up', { cookie: `hp_session=${admin}` });
    expect(r.json().url).toBe('/api/v1/query?query=up');
    expect(r.json().user).toBeNull();
    for (const p of ['/prometheus/-/reload', '/prometheus/-/quit', '/prometheus/api/v1/admin/tsdb/delete_series']) {
      expect((await get(p, { cookie: `hp_session=${admin}` }, 'POST')).statusCode).toBe(403);
    }
  });

  it('refuses requests from other sites', async () => {
    const r = await get('/grafana/api/dashboards/db', { cookie: `hp_session=${admin}`, origin: 'https://evil.example' }, 'POST');
    expect(r.statusCode).toBe(403);
  });
});
