import fs from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { authPlugin } from './auth/index.js';
import { paths } from './config.js';
import { activity } from './lib/activity.js';
import { HttpError } from './lib/errors.js';
import { monitoringProxy, PROXIED } from './monitoring/proxy.js';
import { appRoutes } from './routes/apps.js';
import { infraRoutes } from './routes/infra.js';
import { settingsRoutes } from './routes/settings.js';

// React sets inline style attributes, so styles allow 'unsafe-inline'; scripts do not.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

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

  await authPlugin(app);
  await monitoringProxy(app);

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

  app.addHook('onSend', async (req, reply, payload) => {
    // Grafana and Prometheus bring their own headers; Homeport's strict CSP would break their pages.
    if (PROXIED.test(req.url)) return payload;
    reply
      .header('X-Frame-Options', 'DENY')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin')
      .header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
      .header('Content-Security-Policy', CSP);
    if (req.client?.https) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  return app;
}
