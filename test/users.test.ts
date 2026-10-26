import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The server reads its data directory at import time, so point it at a temp folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-users-'));
process.env.TM_DATA_DIR = dir;
delete process.env.TM_PASSWORD;

const { hashPassword } = await import('../src/server/auth/secrets.js');
const OLD_PASSWORD = 'tide-lantern-gravel';
// An auth.json from before accounts existed: one password, one session.
fs.writeFileSync(
  path.join(dir, 'auth.json'),
  JSON.stringify({
    passwordHash: await hashPassword(OLD_PASSWORD),
    passwordChangedAt: '2026-01-01T00:00:00.000Z',
    totpSecret: '',
    totpLastStep: 0,
    recoveryCodes: [],
    sessions: [],
  }),
);

const { buildApp } = await import('../src/server/app.js');
const { auth, loadAuth, wasMigrated } = await import('../src/server/auth/store.js');
const { db } = await import('../src/server/store.js');

let app: FastifyInstance;
beforeAll(async () => {
  loadAuth();
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const LAN = { host: '192.168.1.20:7070' };
function call(method: InjectOptions['method'], url: string, opts: { body?: unknown; cookie?: string } = {}) {
  return app.inject({
    method,
    url,
    remoteAddress: '192.168.1.50',
    headers: {
      ...LAN,
      ...(method !== 'GET' ? { 'x-homeport': '1' } : {}),
      ...(opts.cookie ? { cookie: `hp_session=${opts.cookie}` } : {}),
    },
    payload: opts.body as InjectOptions['payload'],
  });
}
const cookieOf = (r: { cookies: { name: string; value: string }[] }) => r.cookies.find((c) => c.name === 'hp_session')?.value ?? '';
const login = async (username: string, password: string) => {
  const r = await call('POST', '/api/auth/login', { body: { username, password } });
  return { status: r.statusCode, cookie: cookieOf(r), error: r.json().error as string | undefined };
};

describe('accounts', () => {
  let admin = '';
  let viewer = '';
  let viewerId = '';

  it('turns an old single password into the account "admin"', async () => {
    expect(wasMigrated()).toBe(true);
    expect(auth.users.map((u) => [u.username, u.role])).toEqual([['admin', 'admin']]);
    const r = await login('admin', OLD_PASSWORD);
    expect(r.status).toBe(200);
    admin = r.cookie;
  });

  it('lets you rename yourself, and usernames are case-insensitive', async () => {
    const r = await call('PUT', '/api/auth/me', { cookie: admin, body: { username: 'Agus' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().username).toBe('agus');
    expect((await login('AGUS', OLD_PASSWORD)).status).toBe(200);
    expect((await call('PUT', '/api/auth/me', { cookie: admin, body: { username: 'a b' } })).statusCode).toBe(400);
  });

  it('gives the same answer for an unknown user and a wrong password', async () => {
    const unknown = await login('nobody', OLD_PASSWORD);
    const wrong = await login('agus', 'not-the-password');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.error).toBe(wrong.error);
  });

  it('lets an admin add a viewer', async () => {
    const r = await call('POST', '/api/auth/users', {
      cookie: admin,
      body: { username: 'tamu', password: 'harbour-signal-copper', role: 'viewer' },
    });
    expect(r.statusCode).toBe(200);
    viewerId = r.json().id;
    const dup = await call('POST', '/api/auth/users', {
      cookie: admin,
      body: { username: 'TAMU', password: 'harbour-signal-copper', role: 'viewer' },
    });
    expect(dup.statusCode).toBe(409);
    viewer = (await login('tamu', 'harbour-signal-copper')).cookie;
    const status = (await call('GET', '/api/auth/status', { cookie: viewer })).json();
    expect(status.user).toMatchObject({ username: 'tamu', role: 'viewer' });
  });

  it('lets a viewer look but not change anything or see secrets', async () => {
    db.apps.push({
      id: 'shop',
      name: 'shop',
      port: 39999,
      branch: 'main',
      repo: 'https://github.com/x/shop',
      env: { STRIPE_KEY: 'sk_live_123' },
      gitToken: 'ghp_secret',
      webhookSecret: 'whsec_abc',
    } as never);
    expect((await call('GET', '/api/state', { cookie: viewer })).statusCode).toBe(200);
    expect((await call('POST', '/api/sites', { cookie: viewer, body: { hostname: 'x.example.com', upstreamPort: 3001 } })).statusCode).toBe(
      403,
    );
    expect((await call('POST', '/api/apps/shop/restart', { cookie: viewer })).statusCode).toBe(403);
    expect((await call('GET', '/api/export', { cookie: viewer })).statusCode).toBe(403);
    expect((await call('GET', '/api/apps/shop/webhook', { cookie: viewer })).statusCode).toBe(403);
    expect((await call('GET', '/api/auth/users', { cookie: viewer })).statusCode).toBe(403);

    const asViewer = (await call('GET', '/api/apps', { cookie: viewer })).json();
    const asAdmin = (await call('GET', '/api/apps', { cookie: admin })).json();
    expect(asViewer.apps[0].env).toEqual({ STRIPE_KEY: '••••' });
    expect(asAdmin.apps[0].env).toEqual({ STRIPE_KEY: 'sk_live_123' });
    expect(JSON.stringify(asViewer)).not.toContain('ghp_secret');
    expect(JSON.stringify(asViewer)).not.toContain('whsec_abc');
    db.apps.length = 0;
  });

  it('still lets a viewer manage their own password', async () => {
    const r = await call('POST', '/api/auth/password', {
      cookie: viewer,
      body: { current: 'harbour-signal-copper', next: 'quiet-meadow-river' },
    });
    expect(r.statusCode).toBe(200);
    expect((await login('tamu', 'quiet-meadow-river')).status).toBe(200);
  });

  it('keeps at least one admin and never deletes yourself', async () => {
    const me = auth.users.find((u) => u.username === 'agus')!;
    expect((await call('PUT', `/api/auth/users/${me.id}`, { cookie: admin, body: { role: 'viewer' } })).statusCode).toBe(400);
    expect((await call('DELETE', `/api/auth/users/${me.id}`, { cookie: admin })).statusCode).toBe(400);
  });

  it('signs a deleted user out everywhere', async () => {
    expect((await call('DELETE', `/api/auth/users/${viewerId}`, { cookie: admin })).statusCode).toBe(200);
    expect((await call('GET', '/api/state', { cookie: viewer })).statusCode).toBe(401);
    expect((await login('tamu', 'quiet-meadow-river')).status).toBe(401);
    const users = (await call('GET', '/api/auth/users', { cookie: admin })).json();
    expect(users.map((u: { username: string }) => u.username)).toEqual(['agus']);
  });
});
