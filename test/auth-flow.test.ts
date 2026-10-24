import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The server reads its data directory at import time, so point it at a temp folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-auth-'));
process.env.TM_DATA_DIR = dir;
delete process.env.TM_PASSWORD;

const { buildApp } = await import('../src/server/app.js');
const { loadAuth } = await import('../src/server/auth/store.js');
const { base32Decode, hotp, totpStep } = await import('../src/server/auth/secrets.js');

let app: FastifyInstance;
beforeAll(async () => {
  loadAuth();
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const LOCAL = { host: '127.0.0.1:7070' };
const REMOTE = {
  host: 'deploy.example.com',
  'x-forwarded-for': '127.0.0.1',
  'cf-connecting-ip': '203.0.113.9',
  'cf-visitor': '{"scheme":"https"}',
};
const PASSWORD = 'tide-lantern-gravel';

function call(
  method: InjectOptions['method'],
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown; cookie?: string } = {},
) {
  return app.inject({
    method,
    url,
    headers: {
      ...LOCAL,
      ...(method !== 'GET' ? { 'x-homeport': '1' } : {}),
      ...(opts.cookie ? { cookie: `hp_session=${opts.cookie}` } : {}),
      ...opts.headers,
    },
    payload: opts.body as InjectOptions['payload'],
  });
}
const cookieOf = (r: { cookies: { name: string; value: string }[] }) => r.cookies.find((c) => c.name === 'hp_session')?.value;

describe('auth flow', () => {
  let session = '';
  let secret = '';
  let recovery: string[] = [];

  it('before a password: the Mac can use the dashboard, the internet cannot', async () => {
    expect((await call('GET', '/api/state')).statusCode).toBe(200);
    const remote = await call('GET', '/api/state', { headers: REMOTE });
    expect(remote.statusCode).toBe(403);
    const status = (await call('GET', '/api/auth/status', { headers: REMOTE })).json();
    expect(status).toMatchObject({ passwordSet: false, local: false, authenticated: false });
  });

  it('refuses to publish the dashboard without a password', async () => {
    const r = await call('POST', '/api/sites', { body: { hostname: 'deploy.example.com', upstreamPort: 7070 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/password/);
  });

  it('only lets the Mac set the first password, and rejects weak ones', async () => {
    expect((await call('POST', '/api/auth/setup', { headers: REMOTE, body: { password: PASSWORD } })).statusCode).toBe(403);
    expect((await call('POST', '/api/auth/setup', { body: { password: 'short' } })).statusCode).toBe(400);
    const r = await call('POST', '/api/auth/setup', { body: { password: PASSWORD } });
    expect(r.statusCode).toBe(200);
    session = cookieOf(r) ?? '';
    expect(session).not.toBe('');
    expect((await call('POST', '/api/auth/setup', { body: { password: 'another-password-1' } })).statusCode).toBe(409);
    // The password file is private and holds no plaintext.
    const file = path.join(dir, 'auth.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(PASSWORD);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(session);
  });

  it('then requires a session everywhere, even on the Mac', async () => {
    expect((await call('GET', '/api/state')).statusCode).toBe(401);
    expect((await call('GET', '/api/state', { cookie: session })).statusCode).toBe(200);
    expect((await call('GET', '/api/state', { cookie: 'forged' })).statusCode).toBe(401);
  });

  it('refuses mutations without the CSRF header or from another origin', async () => {
    const noHeader = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...LOCAL, cookie: `hp_session=${session}` } });
    expect(noHeader.statusCode).toBe(403);
    const foreign = await call('POST', '/api/auth/logout', { cookie: session, headers: { origin: 'https://evil.example' } });
    expect(foreign.statusCode).toBe(403);
  });

  it('signs in remotely with a secure cookie', async () => {
    const bad = await call('POST', '/api/auth/login', { headers: REMOTE, body: { password: 'wrong-password' } });
    expect(bad.statusCode).toBe(401);
    const ok = await call('POST', '/api/auth/login', { headers: REMOTE, body: { password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    const c = ok.cookies.find((x) => x.name === 'hp_session');
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
    expect(ok.headers['strict-transport-security']).toBeTruthy();
  });

  it('turns on two-factor and then asks for a code', async () => {
    const begin = (await call('POST', '/api/auth/totp/begin', { cookie: session })).json();
    expect(begin.qrSvg).toContain('<svg');
    expect(begin.uri).toMatch(/^otpauth:\/\/totp\//);
    secret = begin.secret;
    const wrong = await call('POST', '/api/auth/totp/enable', { cookie: session, body: { code: '000000' } });
    expect(wrong.statusCode).toBe(400);
    const code = hotp(base32Decode(secret), totpStep());
    const en = await call('POST', '/api/auth/totp/enable', { cookie: session, body: { code } });
    expect(en.statusCode).toBe(200);
    recovery = en.json().recoveryCodes;
    expect(recovery).toHaveLength(8);

    const need = await call('POST', '/api/auth/login', { body: { password: PASSWORD } });
    expect(need.statusCode).toBe(401);
    expect(need.json().totpRequired).toBe(true);
    expect(cookieOf(need)).toBeUndefined();
  });

  it('does not accept the same code twice', async () => {
    // The enable step already used the current step's code.
    const code = hotp(base32Decode(secret), totpStep());
    const r = await call('POST', '/api/auth/login', { body: { password: PASSWORD, code } });
    expect(r.statusCode).toBe(401);
  });

  it('accepts a recovery code exactly once', async () => {
    const first = await call('POST', '/api/auth/login', { body: { password: PASSWORD, code: recovery[0] } });
    expect(first.statusCode).toBe(200);
    const again = await call('POST', '/api/auth/login', { body: { password: PASSWORD, code: recovery[0] } });
    expect(again.statusCode).toBe(401);
  });

  it('lists sessions without token hashes and signs out the others on password change', async () => {
    const list = (await call('GET', '/api/auth/sessions', { cookie: session })).json();
    expect(list.length).toBeGreaterThan(1);
    expect(list[0].current).toBe(true);
    expect(JSON.stringify(list)).not.toContain('tokenHash');

    const r = await call('POST', '/api/auth/password', { cookie: session, body: { current: PASSWORD, next: 'harbour-signal-copper' } });
    expect(r.statusCode).toBe(200);
    expect((await call('GET', '/api/auth/sessions', { cookie: session })).json()).toHaveLength(1);
  });

  it('sets security headers on pages', async () => {
    const r = await call('GET', '/api/auth/status');
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['x-frame-options']).toBe('DENY');
  });
});
