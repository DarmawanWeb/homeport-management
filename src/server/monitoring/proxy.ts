import httpProxy from '@fastify/http-proxy';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { settings } from '../store.js';

/**
 * Grafana and Prometheus behind Homeport's sign-in, at /grafana/ and /prometheus/.
 *
 * Both keep listening on 127.0.0.1 only. Whoever reaches Homeport (on the Mac, on the LAN or through
 * the public hostname) reaches them through here, after the same session check as the dashboard.
 * Grafana trusts the user Homeport names in X-WEBAUTH-USER (auth proxy, loopback only), so there is
 * no second login: Homeport admins are Grafana admins, viewers are Grafana viewers.
 */
export const PROXIED = /^\/(grafana|prometheus)(\/|$|\?)/;

/** Prometheus endpoints that change or stop it. Homeport calls them directly, never through the proxy. */
const PROMETHEUS_BLOCKED = /^\/prometheus\/(-\/(reload|quit)|api\/v1\/admin\/)/;

function requireSignedIn(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!req.user) {
    // A browser opening /grafana/ directly: sign in on the dashboard, then come back here.
    if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
      void reply.redirect(`/?next=${encodeURIComponent(req.url)}`);
      return;
    }
    void reply.status(401).send({ error: 'Sign in to Homeport first' });
    return;
  }
  if (PROMETHEUS_BLOCKED.test(req.url)) {
    void reply.status(403).send({ error: 'Not available through Homeport' });
    return;
  }
  done();
}

/** Drop Homeport's own session cookie and any identity headers a client tried to send. */
function forwardHeaders(req: FastifyRequest, headers: Record<string, string | string[] | undefined>, asUser: boolean) {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^x-webauth-/i.test(k)) continue;
    out[k] = v;
  }
  if (typeof out.cookie === 'string') {
    const rest = out.cookie
      .split(/;\s*/)
      .filter((c) => !c.startsWith('hp_session='))
      .join('; ');
    if (rest) out.cookie = rest;
    else delete out.cookie;
  }
  if (asUser && req.user) {
    out['x-webauth-user'] = req.user.username;
    out['x-webauth-role'] = req.user.role === 'admin' ? 'Admin' : 'Viewer';
  }
  return out;
}

export async function monitoringProxy(root: FastifyInstance): Promise<void> {
  // The proxy streams bodies with its own parsers; keep Homeport's JSON parser out of its way.
  await root.register(async (app) => {
    app.removeAllContentTypeParsers();
    await registerProxies(app);
  });
}

async function registerProxies(app: FastifyInstance): Promise<void> {
  const m = () => settings().monitoring;

  await app.register(httpProxy, {
    upstream: `http://127.0.0.1:${m().grafanaPort}`,
    prefix: '/grafana',
    // Grafana serves from the /grafana sub-path itself (serve_from_sub_path), so keep the prefix.
    rewritePrefix: '/grafana',
    preHandler: requireSignedIn,
    replyOptions: {
      getUpstream: () => `http://127.0.0.1:${m().grafanaPort}`,
      rewriteRequestHeaders: (req, headers) => forwardHeaders(req as FastifyRequest, headers, true),
    },
  });

  await app.register(httpProxy, {
    upstream: `http://127.0.0.1:${m().prometheusPort}`,
    prefix: '/prometheus',
    // Prometheus serves at / and only builds its links with the /prometheus prefix (web.external-url).
    rewritePrefix: '',
    preHandler: requireSignedIn,
    replyOptions: {
      getUpstream: () => `http://127.0.0.1:${m().prometheusPort}`,
      rewriteRequestHeaders: (req, headers) => forwardHeaders(req as FastifyRequest, headers, false),
    },
  });
}
