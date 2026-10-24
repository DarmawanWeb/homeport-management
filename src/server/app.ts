import crypto from 'node:crypto';
import fs from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { env, paths } from './config.js';
import { activity } from './lib/activity.js';
import { HttpError } from './lib/errors.js';
import { appRoutes } from './routes/apps.js';
import { infraRoutes } from './routes/infra.js';
import { settingsRoutes } from './routes/settings.js';

const SESSION_COOKIE = 'hp_session';
const sessions = new Set<string>();

/** Build the dashboard HTTP server (API + built web UI). */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);

  // Action endpoints (POST /api/x/restart) are often called without a body.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body).trim();
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new HttpError(400, 'Invalid JSON body'), undefined);
    }
  });

  // Set before registering route plugins: encapsulated plugins copy the handler when they load.
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) activity.error(err.message);
    void reply.status(status).header('Cache-Control', 'no-store').send({ error: err.message });
  });

  // Every mutating API call must carry a custom header: browsers cannot add it cross-site without CORS,
  // which blocks CSRF from other pages open in the same browser.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.headers['x-homeport'] !== '1') throw new HttpError(403, 'Forbidden');
    if (!env.password || req.url === '/api/login') return;
    const sid = req.cookies[SESSION_COOKIE];
    if (!sid || !sessions.has(sid)) throw new HttpError(401, 'Sign in first');
  });

  app.post('/api/login', async (req, reply) => {
    if (!env.password) return { ok: true };
    const given = Buffer.from(String((req.body as { password?: string } | null)?.password ?? ''));
    const expected = Buffer.from(env.password);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new HttpError(401, 'Wrong password');
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    reply.setCookie(SESSION_COOKIE, sid, { httpOnly: true, sameSite: 'strict', path: '/' });
    return { ok: true };
  });

  await app.register(infraRoutes);
  await app.register(appRoutes);
  await app.register(settingsRoutes);

  if (fs.existsSync(paths.web)) {
    // wildcard: serve files that appear after a rebuild without restarting; misses fall through to the SPA handler.
    await app.register(fastifyStatic, { root: paths.web, wildcard: true });
    // Single-page app: unknown non-API routes serve index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'No such endpoint' });
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.get('/', async () => 'The web UI is not built yet. Run: npm run build');
  }

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Frame-Options', 'DENY').header('X-Content-Type-Options', 'nosniff');
    if (_req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  return app;
}
