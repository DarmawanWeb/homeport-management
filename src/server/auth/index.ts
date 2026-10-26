import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AuthStatusDTO, PublicAccessDTO, SessionView } from '../../shared/types.js';
import { env } from '../config.js';
import { activity } from '../lib/activity.js';
import { badRequest, HttpError, notFound, parse } from '../lib/errors.js';
import { hostname } from '../lib/validators.js';
import { FLAVOR } from '../platform.js';
import { networkInfo, setLanAccess } from '../services/network.js';
import { createSite, deleteSite } from '../services/sites.js';
import { db, settings } from '../store.js';
import { type ClientInfo, LoginLimiter, requestClient, sameOrigin } from './guard.js';
import {
  hashPassword,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  passwordProblem,
  randomToken,
  sha256,
  verifyPassword,
  verifyTotp,
} from './secrets.js';
import { auth, checkSetupCode, clearSetupCode, passwordSet, SETUP_CODE_FILE, type SessionRecord, saveAuth, totpEnabled } from './store.js';

const SETUP_CODE_WHERE = {
  docker: 'Container Manager → Container → homeport → Log (or docker logs homeport). It is also in the file setup-code in the data folder.',
  native: `Run pm2 logs homeport on the machine, or cat ${SETUP_CODE_FILE}`,
};

export const SESSION_COOKIE = 'hp_session';
const IDLE_MS = 30 * 24 * 60 * 60_000;
const MAX_AGE_MS = 90 * 24 * 60 * 60_000;
const TOUCH_EVERY_MS = 5 * 60_000;
const MAX_SESSIONS = 50;

/** Paths reachable without a session. Everything else under /api needs one once a password exists. */
const OPEN = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/setup']);

const limiter = new LoginLimiter();
/** TOTP secrets waiting for their first code, by session id. */
const pendingTotp = new Map<string, string>();

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionRecord;
    client: ClientInfo;
  }
}

// ------------------------------------------------------------------ sessions

function findSession(token: string | undefined): SessionRecord | undefined {
  if (!token) return undefined;
  const hash = sha256(token);
  const s = auth.sessions.find((x) => x.tokenHash === hash);
  if (!s) return undefined;
  const now = Date.now();
  if (now - Date.parse(s.lastSeenAt) > IDLE_MS || now - Date.parse(s.createdAt) > MAX_AGE_MS) {
    auth.sessions = auth.sessions.filter((x) => x !== s);
    void saveAuth();
    return undefined;
  }
  return s;
}

async function startSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = randomToken();
  const now = new Date().toISOString();
  auth.sessions.push({
    id: randomToken(9),
    tokenHash: sha256(token),
    createdAt: now,
    lastSeenAt: now,
    ip: req.client.ip,
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    via: req.client.local ? 'local' : 'remote',
  });
  // Oldest sessions go first when there are too many.
  auth.sessions = auth.sessions.slice(-MAX_SESSIONS);
  await saveAuth();
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.client.https,
    path: '/',
    maxAge: MAX_AGE_MS / 1000,
  });
}

function endSessions(keep?: SessionRecord): void {
  auth.sessions = keep ? [keep] : [];
  pendingTotp.clear();
}

// ------------------------------------------------------------------ checks

const slow = () => new Promise((r) => setTimeout(r, 400 + Math.random() * 300));

/** Verify the password (and second factor if enabled) with lockout. Throws on failure. */
async function checkCredentials(c: ClientInfo, password: string, code: string | undefined, reply?: FastifyReply): Promise<boolean> {
  const wait = limiter.retryAfter(c);
  if (wait > 0) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60_000)} min.`);
  if (!(await verifyPassword(password, auth.passwordHash))) {
    limiter.fail(c);
    activity.warn(`Failed sign-in from ${c.ip}`);
    await slow();
    throw new HttpError(401, 'Wrong password');
  }
  if (!totpEnabled()) return true;
  if (!code) {
    // Password was right; ask for the second factor without counting a failure.
    if (reply) void reply.status(401).send({ error: 'Enter the code from your authenticator app', totpRequired: true });
    return false;
  }
  if (!consumeSecondFactor(code)) {
    limiter.fail(c);
    activity.warn(`Wrong two-factor code from ${c.ip}`);
    await slow();
    throw new HttpError(401, 'That code is not valid');
  }
  return true;
}

function consumeSecondFactor(code: string): boolean {
  const step = verifyTotp(auth.totpSecret, code);
  if (step !== null) {
    if (step <= auth.totpLastStep) return false;
    auth.totpLastStep = step;
    return true;
  }
  const hash = sha256(code.trim().toLowerCase());
  const i = auth.recoveryCodes.indexOf(hash);
  if (i < 0) return false;
  auth.recoveryCodes.splice(i, 1);
  activity.warn(`Recovery code used; ${auth.recoveryCodes.length} left`);
  return true;
}

async function requirePassword(req: FastifyRequest, password: string): Promise<void> {
  const wait = limiter.retryAfter(req.client);
  if (wait > 0) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60_000)} min.`);
  if (!(await verifyPassword(password, auth.passwordHash))) {
    limiter.fail(req.client);
    await slow();
    throw new HttpError(401, 'Current password is wrong');
  }
}

const newPassword = z.string().superRefine((v, ctx) => {
  const p = passwordProblem(v);
  if (p) ctx.addIssue({ code: 'custom', message: p });
});

/** Domains that route to the dashboard itself. */
export const dashboardSites = () =>
  db.sites.filter((s) => s.upstreamPort === env.port && /^(localhost|127\.0\.0\.1|::1)$/.test(s.upstreamHost));

// ------------------------------------------------------------------ plugin

export async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest('session', undefined);
  app.decorateRequest('client', null as unknown as ClientInfo);

  app.addHook('onRequest', async (req) => {
    req.client = requestClient(req);
    if (!req.url.startsWith('/api/')) return;
    // CSRF: a custom header cannot be sent cross-site without CORS, and a foreign Origin is refused outright.
    if (req.method !== 'GET' && req.headers['x-homeport'] !== '1') throw new HttpError(403, 'Forbidden');
    if (!sameOrigin(req.headers)) throw new HttpError(403, 'Cross-origin request refused');

    const s = findSession(req.cookies[SESSION_COOKIE]);
    if (s) {
      req.session = s;
      if (Date.now() - Date.parse(s.lastSeenAt) > TOUCH_EVERY_MS) {
        s.lastSeenAt = new Date().toISOString();
        s.ip = req.client.ip;
        void saveAuth();
      }
    }
    const path = req.url.split('?')[0];
    if (OPEN.has(path)) return;
    if (!passwordSet()) {
      // Before a password exists only this machine may use the dashboard.
      if (req.client.local) return;
      throw new HttpError(403, 'Set a dashboard password first. Open the dashboard and enter the setup code from the log.');
    }
    if (!s) throw new HttpError(401, 'Sign in first');
  });

  app.get('/api/auth/status', async (req): Promise<AuthStatusDTO> => {
    return {
      passwordSet: passwordSet(),
      authenticated: passwordSet() ? !!req.session : req.client.local,
      local: req.client.local,
      totpEnabled: totpEnabled(),
      flavor: FLAVOR,
      setupCodeWhere: passwordSet() ? '' : SETUP_CODE_WHERE[FLAVOR === 'docker' ? 'docker' : 'native'],
      publicUrls: dashboardSites().map((s) => `https://${s.hostname}`),
    };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (passwordSet()) throw new HttpError(409, 'A password is already set');
    const { password, setupCode } = parse(z.object({ password: newPassword, setupCode: z.string().max(40).optional() }), req.body);
    if (!req.client.local) {
      // From another computer the setup code proves access to the machine's logs or files.
      const wait = limiter.retryAfter(req.client);
      if (wait > 0) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60_000)} min.`);
      if (!setupCode || !checkSetupCode(setupCode)) {
        limiter.fail(req.client);
        activity.warn(`Wrong setup code from ${req.client.ip}`);
        await slow();
        throw new HttpError(403, 'That setup code is not right');
      }
    }
    auth.passwordHash = await hashPassword(password);
    auth.passwordChangedAt = new Date().toISOString();
    endSessions();
    clearSetupCode();
    await startSession(req, reply);
    activity.info(`Dashboard password set from ${req.client.local ? 'this machine' : req.client.ip}`);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (!passwordSet()) throw new HttpError(409, 'No password is set yet');
    const { password, code } = parse(z.object({ password: z.string().max(256), code: z.string().max(20).optional() }), req.body);
    if (!(await checkCredentials(req.client, password, code, reply))) return reply;
    limiter.succeed(req.client);
    await startSession(req, reply);
    activity.info(`Signed in from ${req.client.local ? 'this machine' : req.client.ip}`);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.session) {
      auth.sessions = auth.sessions.filter((s) => s !== req.session);
      await saveAuth();
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', async (req) => {
    const body = parse(z.object({ current: z.string().max(256), next: newPassword }), req.body);
    await requirePassword(req, body.current);
    auth.passwordHash = await hashPassword(body.next);
    auth.passwordChangedAt = new Date().toISOString();
    endSessions(req.session);
    await saveAuth();
    activity.info('Dashboard password changed; other sessions signed out');
    return { ok: true };
  });

  // ---------------------------------------------------------------- two-factor

  app.post('/api/auth/totp/begin', async (req) => {
    if (!req.session) throw badRequest('Set a password first');
    if (totpEnabled()) throw new HttpError(409, 'Two-factor sign-in is already on');
    const secret = newTotpSecret();
    pendingTotp.set(req.session.id, secret);
    const account = req.headers.host?.split(':')[0] ?? 'homeport';
    const uri = otpauthUri(secret, account);
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret, uri, qrSvg };
  });

  app.post('/api/auth/totp/enable', async (req) => {
    const secret = req.session && pendingTotp.get(req.session.id);
    if (!req.session || !secret) throw badRequest('Start two-factor setup again');
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const step = verifyTotp(secret, code);
    if (step === null) throw badRequest('That code does not match. Check the time on your phone and try the next code.');
    const codes = newRecoveryCodes();
    Object.assign(auth, { totpSecret: secret, totpLastStep: step, recoveryCodes: codes.map(sha256) });
    pendingTotp.delete(req.session.id);
    await saveAuth();
    activity.info('Two-factor sign-in turned on');
    return { recoveryCodes: codes };
  });

  app.post('/api/auth/totp/disable', async (req) => {
    const { password } = parse(z.object({ password: z.string().max(256) }), req.body);
    await requirePassword(req, password);
    Object.assign(auth, { totpSecret: '', totpLastStep: 0, recoveryCodes: [] });
    await saveAuth();
    activity.warn('Two-factor sign-in turned off');
    return { ok: true };
  });

  app.post('/api/auth/totp/recovery', async (req) => {
    const { password } = parse(z.object({ password: z.string().max(256) }), req.body);
    await requirePassword(req, password);
    if (!totpEnabled()) throw badRequest('Two-factor sign-in is off');
    const codes = newRecoveryCodes();
    auth.recoveryCodes = codes.map(sha256);
    await saveAuth();
    return { recoveryCodes: codes };
  });

  app.get('/api/auth/recovery-count', async () => ({ left: auth.recoveryCodes.length }));

  // ---------------------------------------------------------------- sessions

  app.get(
    '/api/auth/sessions',
    async (req): Promise<SessionView[]> =>
      [...auth.sessions]
        .reverse()
        .map(({ tokenHash: _t, ...s }) => ({ ...s, current: s.id === req.session?.id }))
        .sort((a, b) => Number(b.current) - Number(a.current)),
  );

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req) => {
    const before = auth.sessions.length;
    auth.sessions = auth.sessions.filter((s) => s.id !== req.params.id);
    if (auth.sessions.length === before) throw notFound('No such session');
    await saveAuth();
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', async (req) => {
    const n = auth.sessions.length - (req.session ? 1 : 0);
    endSessions(req.session);
    await saveAuth();
    activity.info(`Signed out ${n} other session(s)`);
    return { revoked: n };
  });

  // ---------------------------------------------------------------- local network

  app.get('/api/auth/network', async () => networkInfo());
  app.post('/api/auth/network', async (req) => {
    const { lan } = parse(z.object({ lan: z.boolean() }), req.body);
    if (lan && !passwordSet()) throw badRequest('Set a dashboard password first');
    setLanAccess(lan);
    activity.info(lan ? 'Dashboard opened to the local network; restarting' : 'Dashboard limited to this machine; restarting');
    return { ok: true, restarting: true };
  });

  // ---------------------------------------------------------------- public access

  app.get(
    '/api/auth/public',
    async (): Promise<PublicAccessDTO> => ({
      sites: dashboardSites().map((s) => ({ id: s.id, hostname: s.hostname, tunnel: s.tunnel, enabled: s.enabled })),
      defaultTunnel: settings().defaultTunnel,
      dashboardPort: env.port,
    }),
  );

  app.post('/api/auth/public', async (req) => {
    if (!passwordSet()) throw badRequest('Set a dashboard password first');
    const body = parse(z.object({ hostname, tunnel: z.string().default('') }), req.body);
    const tunnel = body.tunnel || settings().defaultTunnel;
    if (!tunnel) throw badRequest('Create a tunnel first, on the Tunnels page');
    const r = await createSite({
      hostname: body.hostname,
      upstreamPort: env.port,
      upstreamHost: 'localhost',
      tunnel,
      routeDns: true,
      overwriteDns: true,
      notes: 'Homeport dashboard',
    });
    activity.info(`Dashboard published at https://${body.hostname}`);
    return r;
  });

  app.delete<{ Params: { id: string }; Querystring: { dns?: string } }>('/api/auth/public/:id', async (req) => {
    if (!dashboardSites().some((s) => s.id === req.params.id)) throw notFound('That domain does not serve the dashboard');
    return deleteSite(req.params.id, req.query.dns === '1');
  });
}

/** Startup: migrate TM_PASSWORD into a stored hash so existing installs keep working. */
export async function adoptEnvPassword(): Promise<void> {
  if (!env.password || passwordSet()) return;
  auth.passwordHash = await hashPassword(env.password);
  auth.passwordChangedAt = new Date().toISOString();
  await saveAuth();
  clearSetupCode();
  activity.info('Imported TM_PASSWORD as the dashboard password. You can remove it from the pm2 config now.');
}
