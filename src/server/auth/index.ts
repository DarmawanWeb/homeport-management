import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AuthStatusDTO, PublicAccessDTO, SessionView, UserView } from '../../shared/types.js';
import { env } from '../config.js';
import { activity } from '../lib/activity.js';
import { badRequest, HttpError, notFound, parse } from '../lib/errors.js';
import { hostname } from '../lib/validators.js';
import { PROXIED } from '../monitoring/proxy.js';
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
import {
  admins,
  auth,
  checkSetupCode,
  clearSetupCode,
  findUser,
  findUserByName,
  passwordSet,
  type Role,
  SETUP_CODE_FILE,
  type SessionRecord,
  saveAuth,
  type UserRecord,
} from './store.js';

const SETUP_CODE_WHERE = {
  docker: 'Container Manager → Container → homeport → Log (or docker logs homeport). It is also in the file setup-code in the data folder.',
  native: `Run pm2 logs homeport on the machine, or cat ${SETUP_CODE_FILE}`,
};

export const SESSION_COOKIE = 'hp_session';
const IDLE_MS = 30 * 24 * 60 * 60_000;
const MAX_AGE_MS = 90 * 24 * 60 * 60_000;
const TOUCH_EVERY_MS = 5 * 60_000;
const MAX_SESSIONS = 100;

/** Paths reachable without a session. Everything else under /api needs one once an account exists. */
const OPEN = new Set(['/api/auth/status', '/api/auth/login', '/api/auth/setup', '/api/public/status']);

/** What a viewer may still change: their own sign-in, password and second factor. */
const VIEWER_WRITES = [/^\/api\/auth\/(logout|password|me)$/, /^\/api\/auth\/totp\//, /^\/api\/auth\/sessions(\/|$)/];
/** Reads that hand out secrets, closed to viewers. */
const VIEWER_SECRET_READS = [/^\/api\/export$/, /^\/api\/monitoring\/credentials$/, /^\/api\/apps\/[^/]+\/webhook$/];

const limiter = new LoginLimiter();
/** TOTP secrets waiting for their first code, by session id. */
const pendingTotp = new Map<string, string>();
/** Compared against when a username does not exist, so timing does not reveal which names do. */
let dummyHash = '';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionRecord;
    user?: UserRecord;
    client: ClientInfo;
  }
}

// ------------------------------------------------------------------ helpers

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,31}$/, 'Usernames are 2 to 32 letters, digits, dots, dashes or underscores');

const newPassword = z.string().superRefine((v, ctx) => {
  const p = passwordProblem(v);
  if (p) ctx.addIssue({ code: 'custom', message: p });
});

const slow = () => new Promise((r) => setTimeout(r, 400 + Math.random() * 300));

function guardRate(c: ClientInfo): void {
  const wait = limiter.retryAfter(c);
  if (wait > 0) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil(wait / 60_000)} min.`);
}

const requireUser = (req: FastifyRequest): UserRecord => {
  if (!req.user) throw new HttpError(401, 'Sign in first');
  return req.user;
};

const requireAdmin = (req: FastifyRequest): UserRecord => {
  const u = requireUser(req);
  if (u.role !== 'admin') throw new HttpError(403, 'Only admins can do that');
  return u;
};

const who = (req: FastifyRequest) => (req.client.local ? 'this machine' : req.client.ip);

/** Domains that route to the dashboard itself. */
export const dashboardSites = () =>
  db.sites.filter((s) => s.upstreamPort === env.port && /^(localhost|127\.0\.0\.1|::1)$/.test(s.upstreamHost));

function toView(u: UserRecord, me?: UserRecord): UserView {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    totpEnabled: !!u.totpSecret,
    recoveryCodesLeft: u.recoveryCodes.length,
    createdAt: u.createdAt,
    lastSignInAt: u.lastSignInAt,
    sessions: auth.sessions.filter((s) => s.userId === u.id).length,
    you: u.id === me?.id,
  };
}

/** Replace values that look secret before a viewer sees them. */
function redactForViewer(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForViewer);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'env' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.keys(v).map((name) => [name, '••••']));
    } else if (/secret|token|password|webhook$/i.test(k) && typeof v === 'string') {
      out[k] = v ? '••••' : '';
    } else out[k] = redactForViewer(v);
  }
  return out;
}

// ------------------------------------------------------------------ sessions

function findSession(token: string | undefined): SessionRecord | undefined {
  if (!token) return undefined;
  const hash = sha256(token);
  const s = auth.sessions.find((x) => x.tokenHash === hash);
  if (!s) return undefined;
  const now = Date.now();
  if (!findUser(s.userId) || now - Date.parse(s.lastSeenAt) > IDLE_MS || now - Date.parse(s.createdAt) > MAX_AGE_MS) {
    auth.sessions = auth.sessions.filter((x) => x !== s);
    void saveAuth();
    return undefined;
  }
  return s;
}

async function startSession(req: FastifyRequest, reply: FastifyReply, user: UserRecord): Promise<void> {
  const token = randomToken();
  const now = new Date().toISOString();
  auth.sessions.push({
    id: randomToken(9),
    userId: user.id,
    tokenHash: sha256(token),
    createdAt: now,
    lastSeenAt: now,
    ip: req.client.ip,
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    via: req.client.local ? 'local' : 'remote',
  });
  user.lastSignInAt = now;
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

/** Sign out every session of a user, optionally keeping one. */
function endSessionsOf(userId: string, keep?: SessionRecord): number {
  const before = auth.sessions.length;
  auth.sessions = auth.sessions.filter((s) => s.userId !== userId || s === keep);
  for (const s of [...pendingTotp.keys()]) if (!auth.sessions.some((x) => x.id === s)) pendingTotp.delete(s);
  return before - auth.sessions.length;
}

// ------------------------------------------------------------------ credentials

/**
 * Verify username, password and (if enabled) the second factor, with lockout. Returns the user,
 * or null after replying "code needed". The same error covers an unknown name and a wrong password.
 */
async function checkCredentials(req: FastifyRequest, reply: FastifyReply, username: string, password: string, code?: string) {
  const c = req.client;
  guardRate(c);
  const user = findUserByName(username);
  const ok = await verifyPassword(password, user?.passwordHash || dummyHash);
  if (!user || !ok) {
    limiter.fail(c);
    activity.warn(`Failed sign-in${username ? ` as ${username.slice(0, 32)}` : ''} from ${c.ip}`);
    await slow();
    throw new HttpError(401, 'Wrong username or password');
  }
  if (!user.totpSecret) return user;
  if (!code) {
    // Password was right; ask for the second factor without counting a failure.
    void reply.status(401).send({ error: 'Enter the code from your authenticator app', totpRequired: true });
    return null;
  }
  if (!consumeSecondFactor(user, code)) {
    limiter.fail(c);
    activity.warn(`Wrong two-factor code for ${user.username} from ${c.ip}`);
    await slow();
    throw new HttpError(401, 'That code is not valid');
  }
  return user;
}

function consumeSecondFactor(user: UserRecord, code: string): boolean {
  const step = verifyTotp(user.totpSecret, code);
  if (step !== null) {
    if (step <= user.totpLastStep) return false;
    user.totpLastStep = step;
    return true;
  }
  const hash = sha256(code.trim().toLowerCase());
  const i = user.recoveryCodes.indexOf(hash);
  if (i < 0) return false;
  user.recoveryCodes.splice(i, 1);
  activity.warn(`${user.username} used a recovery code; ${user.recoveryCodes.length} left`);
  return true;
}

async function requirePassword(req: FastifyRequest, password: string): Promise<UserRecord> {
  const user = requireUser(req);
  guardRate(req.client);
  if (!(await verifyPassword(password, user.passwordHash))) {
    limiter.fail(req.client);
    await slow();
    throw new HttpError(401, 'Current password is wrong');
  }
  return user;
}

async function newUser(username: string, password: string, role: Role): Promise<UserRecord> {
  if (findUserByName(username)) throw new HttpError(409, `${username} already exists`);
  const now = new Date().toISOString();
  const u: UserRecord = {
    id: crypto.randomUUID(),
    username,
    role,
    passwordHash: await hashPassword(password),
    passwordChangedAt: now,
    totpSecret: '',
    totpLastStep: 0,
    recoveryCodes: [],
    createdAt: now,
    lastSignInAt: '',
  };
  auth.users.push(u);
  return u;
}

// ------------------------------------------------------------------ plugin

export async function authPlugin(app: FastifyInstance): Promise<void> {
  dummyHash = await hashPassword(randomToken());
  app.decorateRequest('session', undefined);
  app.decorateRequest('user', undefined);
  app.decorateRequest('client', null as unknown as ClientInfo);

  app.addHook('onRequest', async (req) => {
    req.client = requestClient(req);
    const proxied = PROXIED.test(req.url);
    if (!req.url.startsWith('/api/') && !proxied) return;
    if (proxied) {
      // Grafana and Prometheus: identify the user here; the proxy decides (redirect to sign-in or forward).
      if (!sameOrigin(req.headers)) throw new HttpError(403, 'Cross-origin request refused');
      const ps = findSession(req.cookies[SESSION_COOKIE]);
      if (ps) {
        req.session = ps;
        req.user = findUser(ps.userId);
      }
      return;
    }
    // CSRF: a custom header cannot be sent cross-site without CORS, and a foreign Origin is refused outright.
    if (req.method !== 'GET' && req.headers['x-homeport'] !== '1') throw new HttpError(403, 'Forbidden');
    if (!sameOrigin(req.headers)) throw new HttpError(403, 'Cross-origin request refused');

    const s = findSession(req.cookies[SESSION_COOKIE]);
    if (s) {
      req.session = s;
      req.user = findUser(s.userId);
      if (Date.now() - Date.parse(s.lastSeenAt) > TOUCH_EVERY_MS) {
        s.lastSeenAt = new Date().toISOString();
        s.ip = req.client.ip;
        void saveAuth();
      }
    }
    const path = req.url.split('?')[0];
    if (OPEN.has(path)) return;
    if (!passwordSet()) {
      // Before an account exists only this machine may use the dashboard.
      if (req.client.local) return;
      throw new HttpError(403, 'Create an account first. Open the dashboard and enter the setup code from the log.');
    }
    if (!s || !req.user) throw new HttpError(401, 'Sign in first');
    if (req.user.role === 'viewer') {
      if (req.method !== 'GET' && !VIEWER_WRITES.some((r) => r.test(path)))
        throw new HttpError(403, 'Viewers can look but not change anything');
      if (req.method === 'GET' && VIEWER_SECRET_READS.some((r) => r.test(path))) throw new HttpError(403, 'Viewers cannot see secrets');
    }
  });

  // Viewers get app environment variables and other secrets masked in every response.
  app.addHook('preSerialization', async (req, _reply, payload) => {
    if (req.user?.role !== 'viewer' || !req.url.startsWith('/api/') || req.url.startsWith('/api/auth/')) return payload;
    return redactForViewer(payload);
  });

  app.get('/api/auth/status', async (req): Promise<AuthStatusDTO> => {
    const u = req.user;
    return {
      passwordSet: passwordSet(),
      authenticated: passwordSet() ? !!u : req.client.local,
      local: req.client.local,
      user: u ? { id: u.id, username: u.username, role: u.role } : null,
      totpEnabled: !!u?.totpSecret,
      flavor: FLAVOR,
      setupCodeWhere: passwordSet() ? '' : SETUP_CODE_WHERE[FLAVOR === 'docker' ? 'docker' : 'native'],
      publicUrls: dashboardSites().map((s) => `https://${s.hostname}`),
    };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    if (passwordSet()) throw new HttpError(409, 'An account already exists');
    const body = parse(
      z.object({ username: usernameSchema.default('admin'), password: newPassword, setupCode: z.string().max(40).optional() }),
      req.body,
    );
    if (!req.client.local) {
      // From another computer the setup code proves access to the machine's logs or files.
      guardRate(req.client);
      if (!body.setupCode || !checkSetupCode(body.setupCode)) {
        limiter.fail(req.client);
        activity.warn(`Wrong setup code from ${req.client.ip}`);
        await slow();
        throw new HttpError(403, 'That setup code is not right');
      }
    }
    const user = await newUser(body.username, body.password, 'admin');
    auth.sessions = [];
    clearSetupCode();
    await startSession(req, reply, user);
    activity.info(`Account ${user.username} created from ${who(req)}`);
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    if (!passwordSet()) throw new HttpError(409, 'No account exists yet');
    const body = parse(
      z.object({ username: z.string().max(64).default('admin'), password: z.string().max(256), code: z.string().max(20).optional() }),
      req.body,
    );
    const user = await checkCredentials(req, reply, body.username, body.password, body.code);
    if (!user) return reply;
    limiter.succeed(req.client);
    await startSession(req, reply, user);
    activity.info(`${user.username} signed in from ${who(req)}`);
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

  // ---------------------------------------------------------------- your account

  app.put('/api/auth/me', async (req) => {
    const user = requireUser(req);
    const { username } = parse(z.object({ username: usernameSchema }), req.body);
    const taken = findUserByName(username);
    if (taken && taken !== user) throw new HttpError(409, `${username} is taken`);
    const old = user.username;
    user.username = username;
    await saveAuth();
    activity.info(`${old} is now called ${username}`);
    return toView(user, user);
  });

  app.post('/api/auth/password', async (req) => {
    const body = parse(z.object({ current: z.string().max(256), next: newPassword }), req.body);
    const user = await requirePassword(req, body.current);
    user.passwordHash = await hashPassword(body.next);
    user.passwordChangedAt = new Date().toISOString();
    endSessionsOf(user.id, req.session);
    await saveAuth();
    activity.info(`${user.username} changed their password; their other sessions were signed out`);
    return { ok: true };
  });

  // ---------------------------------------------------------------- two-factor (for yourself)

  app.post('/api/auth/totp/begin', async (req) => {
    const user = requireUser(req);
    if (user.totpSecret) throw new HttpError(409, 'Two-factor sign-in is already on');
    const secret = newTotpSecret();
    pendingTotp.set(req.session!.id, secret);
    const host = req.headers.host?.split(':')[0] ?? 'homeport';
    const uri = otpauthUri(secret, `${user.username}@${host}`);
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return { secret, uri, qrSvg };
  });

  app.post('/api/auth/totp/enable', async (req) => {
    const user = requireUser(req);
    const secret = pendingTotp.get(req.session!.id);
    if (!secret) throw badRequest('Start two-factor setup again');
    const { code } = parse(z.object({ code: z.string() }), req.body);
    const step = verifyTotp(secret, code);
    if (step === null) throw badRequest('That code does not match. Check the time on your phone and try the next code.');
    const codes = newRecoveryCodes();
    Object.assign(user, { totpSecret: secret, totpLastStep: step, recoveryCodes: codes.map(sha256) });
    pendingTotp.delete(req.session!.id);
    await saveAuth();
    activity.info(`${user.username} turned on two-factor sign-in`);
    return { recoveryCodes: codes };
  });

  app.post('/api/auth/totp/disable', async (req) => {
    const { password } = parse(z.object({ password: z.string().max(256) }), req.body);
    const user = await requirePassword(req, password);
    Object.assign(user, { totpSecret: '', totpLastStep: 0, recoveryCodes: [] });
    await saveAuth();
    activity.warn(`${user.username} turned off two-factor sign-in`);
    return { ok: true };
  });

  app.post('/api/auth/totp/recovery', async (req) => {
    const { password } = parse(z.object({ password: z.string().max(256) }), req.body);
    const user = await requirePassword(req, password);
    if (!user.totpSecret) throw badRequest('Two-factor sign-in is off');
    const codes = newRecoveryCodes();
    user.recoveryCodes = codes.map(sha256);
    await saveAuth();
    return { recoveryCodes: codes };
  });

  // ---------------------------------------------------------------- your sessions

  app.get('/api/auth/sessions', async (req): Promise<SessionView[]> => {
    const user = requireUser(req);
    return auth.sessions
      .filter((s) => s.userId === user.id)
      .reverse()
      .map(({ tokenHash: _t, userId: _u, ...s }) => ({ ...s, current: s.id === req.session?.id }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  });

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (req) => {
    const user = requireUser(req);
    const before = auth.sessions.length;
    auth.sessions = auth.sessions.filter((s) => !(s.id === req.params.id && s.userId === user.id));
    if (auth.sessions.length === before) throw notFound('No such session');
    await saveAuth();
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', async (req) => {
    const user = requireUser(req);
    const n = endSessionsOf(user.id, req.session);
    await saveAuth();
    activity.info(`${user.username} signed out ${n} other session(s)`);
    return { revoked: n };
  });

  // ---------------------------------------------------------------- users (admins)

  app.get('/api/auth/users', async (req): Promise<UserView[]> => {
    const me = requireAdmin(req);
    return auth.users.map((u) => toView(u, me));
  });

  app.post('/api/auth/users', async (req) => {
    requireAdmin(req);
    const body = parse(z.object({ username: usernameSchema, password: newPassword, role: z.enum(['admin', 'viewer']) }), req.body);
    const u = await newUser(body.username, body.password, body.role);
    await saveAuth();
    activity.info(`${req.user!.username} added ${u.username} (${u.role})`);
    return toView(u, req.user);
  });

  app.put<{ Params: { id: string } }>('/api/auth/users/:id', async (req) => {
    requireAdmin(req);
    const u = findUser(req.params.id);
    if (!u) throw notFound('No such user');
    const { role } = parse(z.object({ role: z.enum(['admin', 'viewer']) }), req.body);
    if (u.role === 'admin' && role !== 'admin' && admins().length === 1) throw badRequest('There must be at least one admin');
    u.role = role;
    await saveAuth();
    activity.info(`${req.user!.username} made ${u.username} ${role === 'admin' ? 'an admin' : 'a viewer'}`);
    return toView(u, req.user);
  });

  app.post<{ Params: { id: string } }>('/api/auth/users/:id/password', async (req) => {
    requireAdmin(req);
    const u = findUser(req.params.id);
    if (!u) throw notFound('No such user');
    const { password } = parse(z.object({ password: newPassword }), req.body);
    u.passwordHash = await hashPassword(password);
    u.passwordChangedAt = new Date().toISOString();
    endSessionsOf(u.id, u.id === req.user!.id ? req.session : undefined);
    await saveAuth();
    activity.warn(`${req.user!.username} set a new password for ${u.username}`);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/auth/users/:id/reset-2fa', async (req) => {
    requireAdmin(req);
    const u = findUser(req.params.id);
    if (!u) throw notFound('No such user');
    Object.assign(u, { totpSecret: '', totpLastStep: 0, recoveryCodes: [] });
    await saveAuth();
    activity.warn(`${req.user!.username} turned off two-factor for ${u.username}`);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/auth/users/:id', async (req) => {
    requireAdmin(req);
    const u = findUser(req.params.id);
    if (!u) throw notFound('No such user');
    if (u.id === req.user!.id) throw badRequest('You cannot delete your own account');
    if (u.role === 'admin' && admins().length === 1) throw badRequest('There must be at least one admin');
    auth.users = auth.users.filter((x) => x !== u);
    endSessionsOf(u.id);
    await saveAuth();
    activity.warn(`${req.user!.username} deleted ${u.username}`);
    return { ok: true };
  });

  // ---------------------------------------------------------------- local network

  app.get('/api/auth/network', async () => networkInfo());
  app.post('/api/auth/network', async (req) => {
    if (passwordSet()) requireAdmin(req);
    const { lan } = parse(z.object({ lan: z.boolean() }), req.body);
    if (lan && !passwordSet()) throw badRequest('Create an account first');
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
    if (!passwordSet()) throw badRequest('Create an account first');
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

/** Startup: turn a legacy TM_PASSWORD into the account "admin" so existing installs keep working. */
export async function adoptEnvPassword(): Promise<void> {
  if (!env.password || passwordSet()) return;
  await newUser('admin', env.password, 'admin');
  await saveAuth();
  clearSetupCode();
  activity.info('Imported TM_PASSWORD as the account "admin". You can remove it from the pm2 config now.');
}
