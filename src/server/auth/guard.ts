import type { FastifyRequest } from 'fastify';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const PROXY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'cf-ray'];

export interface ClientInfo {
  /** Connected straight to the dashboard from this machine: no tunnel, no Caddy in between. */
  local: boolean;
  ip: string;
  https: boolean;
}

type HeaderBag = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Who is asking. Anything that came through Caddy or cloudflared carries forwarding headers,
 * which a remote client cannot remove, so "local" means loopback socket and no such headers.
 */
export function clientInfo(remoteAddress: string | undefined, headers: HeaderBag): ClientInfo {
  const forwarded = PROXY_HEADERS.some((h) => headers[h] !== undefined);
  // The Host check stops DNS rebinding: a page on evil.example resolved to 127.0.0.1 is not "local".
  const local = LOOPBACK.has(remoteAddress ?? '') && !forwarded && LOCAL_HOST.test(first(headers.host) ?? '');
  const ip =
    first(headers['cf-connecting-ip'])?.trim() || first(headers['x-forwarded-for'])?.split(',')[0]?.trim() || remoteAddress || 'unknown';
  const proto = first(headers['x-forwarded-proto']) ?? '';
  const visitor = first(headers['cf-visitor']) ?? '';
  return { local, ip, https: proto === 'https' || visitor.includes('"https"') };
}

export const requestClient = (req: FastifyRequest) => clientInfo(req.socket.remoteAddress, req.headers);

// ------------------------------------------------------------------ brute-force protection

interface Entry {
  fails: number;
  until: number;
  last: number;
}

/**
 * Failed sign-ins lock the source IP with exponential backoff after a few attempts.
 * A global budget also stops slow guessing spread across many IPs; while that is exhausted
 * only sign-ins made on the machine itself are accepted.
 */
export class LoginLimiter {
  private perIp = new Map<string, Entry>();
  private globalFails: number[] = [];

  constructor(
    private readonly opts = { freeAttempts: 5, baseLockMs: 30_000, maxLockMs: 60 * 60_000, globalMax: 30, globalWindowMs: 10 * 60_000 },
  ) {}

  /** Milliseconds until this client may try again, or 0. */
  retryAfter(c: ClientInfo, now = Date.now()): number {
    const e = this.perIp.get(c.ip);
    const own = e && e.until > now ? e.until - now : 0;
    if (c.local) return own;
    this.globalFails = this.globalFails.filter((t) => now - t < this.opts.globalWindowMs);
    const global = this.globalFails.length >= this.opts.globalMax ? this.globalFails[0] + this.opts.globalWindowMs - now : 0;
    return Math.max(own, global);
  }

  fail(c: ClientInfo, now = Date.now()): void {
    const e = this.perIp.get(c.ip) ?? { fails: 0, until: 0, last: 0 };
    // Forget old failures after a quiet day.
    if (now - e.last > 24 * 60 * 60_000) e.fails = 0;
    e.fails++;
    e.last = now;
    const over = e.fails - this.opts.freeAttempts;
    if (over >= 0) e.until = now + Math.min(this.opts.baseLockMs * 2 ** over, this.opts.maxLockMs);
    this.perIp.set(c.ip, e);
    if (!c.local) this.globalFails.push(now);
    if (this.perIp.size > 10_000) this.perIp.delete(this.perIp.keys().next().value as string);
  }

  succeed(c: ClientInfo): void {
    this.perIp.delete(c.ip);
  }
}

/** Requests from another site would carry its Origin; refuse them even with valid cookies. */
export function sameOrigin(headers: HeaderBag): boolean {
  const origin = first(headers.origin);
  if (!origin) return true;
  try {
    return new URL(origin).host === first(headers.host);
  } catch {
    return false;
  }
}
