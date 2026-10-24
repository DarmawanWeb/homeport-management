/**
 * The webhook listener is the only Homeport endpoint exposed to the internet (via Caddy + the tunnel).
 * It runs on its own port so the dashboard can stay bound to localhost.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { activity } from '../lib/activity.js';
import { events } from '../lib/events.js';
import { RE_SHA } from '../lib/validators.js';
import { db, saveDb, settings } from '../store.js';
import { queueDeploy } from './deploy.js';

const MAX_BODY = 25 * 1024 * 1024;

export function verifySignature(secret: string, raw: Buffer, header: string): boolean {
  const sig = header.replace(/^sha256=/, '');
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

interface PushPayload {
  ref?: string;
  after?: string;
  deleted?: boolean;
  pusher?: { name?: string };
  sender?: { login?: string };
  head_commit?: { message?: string };
}

function reply(res: http.ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, raw: Buffer, appId: string): void {
  const a = db.apps.find((x) => x.id === appId);
  if (!a) {
    reply(res, 404, { error: 'unknown app' });
    return;
  }

  const header = String(req.headers['x-hub-signature-256'] ?? req.headers['x-gitea-signature'] ?? req.headers['x-gogs-signature'] ?? '');
  if (!header || !verifySignature(a.webhookSecret, raw, header)) {
    activity.warn(
      `Webhook ${a.name}: bad signature (from ${req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress})`,
    );
    events.emit('webhook:received', a.name, 'bad_signature');
    reply(res, 401, { error: 'bad signature' });
    return;
  }

  const event = String(req.headers['x-github-event'] ?? req.headers['x-gitea-event'] ?? req.headers['x-gogs-event'] ?? '');
  let body: PushPayload;
  try {
    const text = raw.toString('utf8');
    body = String(req.headers['content-type']).includes('x-www-form-urlencoded')
      ? JSON.parse(new URLSearchParams(text).get('payload') ?? '{}')
      : JSON.parse(text || '{}');
  } catch {
    reply(res, 400, { error: 'bad json' });
    return;
  }

  a.lastWebhookAt = new Date().toISOString();
  void saveDb();
  const ignore = (why: string) => {
    events.emit('webhook:received', a.name, 'ignored');
    reply(res, 202, { ignored: why });
  };

  if (event === 'ping') {
    activity.info(`Webhook ${a.name}: ping OK`);
    events.emit('webhook:received', a.name, 'ping');
    reply(res, 200, { ok: true, pong: true });
    return;
  }
  if (event !== 'push') {
    ignore(`event ${event}`);
    return;
  }
  if (body.ref !== `refs/heads/${a.branch}`) {
    ignore(`ref ${body.ref} is not ${a.branch}`);
    return;
  }
  if (body.deleted) {
    ignore('branch deleted');
    return;
  }
  if (a.autoDeploy === 'off') {
    ignore('auto deploy off');
    return;
  }

  const rec = queueDeploy(a, 'webhook', {
    pushedBy: body.pusher?.name ?? body.sender?.login ?? null,
    pushMsg: body.head_commit?.message?.split('\n')[0] ?? null,
  });
  if (body.after && RE_SHA.test(body.after)) a.lastRemoteSha = body.after;
  activity.info(`Webhook ${a.name}: push by ${rec.pushedBy ?? 'unknown'}, deploying`);
  events.emit('webhook:received', a.name, 'deployed');
  reply(res, 202, { queued: rec.id });
}

let server: http.Server | null = null;

export function startWebhookServer(): void {
  server?.close();
  const st = settings();
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      reply(res, 200, { ok: true, service: 'homeport-hooks' });
      return;
    }
    const m = url.pathname.match(/^\/hooks\/([0-9a-f-]{36})\/?$/);
    if (req.method !== 'POST' || !m) {
      reply(res, 404, { error: 'not found' });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => handle(req, res, Buffer.concat(chunks), m[1]!));
  });
  server.on('error', (e) => activity.error(`Webhook server could not listen on port ${st.webhookPort}: ${e.message}`));
  server.listen(st.webhookPort, '127.0.0.1', () => activity.info(`Webhook server listening on 127.0.0.1:${st.webhookPort}`));
}
