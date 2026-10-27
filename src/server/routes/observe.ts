import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { analytics } from '../analytics/index.js';
import { HttpError, parse } from '../lib/errors.js';
import { networkStats } from '../monitoring/netstat.js';
import { checkNow, publicStatus, uptime } from '../uptime/index.js';

/** Analytics, uptime and network: what visitors see and how the machine's connection holds up. */
export async function observeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/analytics', async (req) => {
    const q = parse(
      z.object({ range: z.enum(['1h', '24h', '7d', '30d']).default('24h'), host: z.string().max(253).default('all') }),
      req.query,
    );
    return analytics(q.range, q.host);
  });

  app.get('/api/uptime', async () => uptime());
  app.post('/api/uptime/check', async () => {
    await checkNow();
    return uptime();
  });

  app.get('/api/network/stats', async () => networkStats());

  // The only endpoint anyone may read without signing in, and only when the status page is turned on.
  app.get('/api/public/status', async () => {
    const s = publicStatus();
    if (!s) throw new HttpError(404, 'There is no public status page');
    return s;
  });
}
