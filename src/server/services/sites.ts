import crypto from 'node:crypto';
import { z } from 'zod';
import { activity } from '../lib/activity.js';
import { badRequest, errMsg, notFound, parse } from '../lib/errors.js';
import { events } from '../lib/events.js';
import { RE_BCRYPT, RE_PM2NAME, RE_UPHOST, caddySnippet, hostname, optionalTunnel, port } from '../lib/validators.js';
import { db, saveDb, settings } from '../store.js';
import * as caddy from './caddy.js';
import * as cloudflared from './cloudflared.js';
import { deleteTunnelCname } from './cloudflareApi.js';
import type { Site } from '../../shared/types.js';

export const siteInput = z.object({
  hostname,
  upstreamHost: z.string().trim().default('localhost').refine((v) => RE_UPHOST.test(v), 'host upstream tidak valid'),
  upstreamPort: port,
  scheme: z.enum(['http', 'https']).default('http'),
  tlsInsecure: z.boolean().default(false),
  tunnel: optionalTunnel.default(''),
  pm2Name: z.string().trim().default('').refine((v) => v === '' || RE_PM2NAME.test(v), 'nama proses pm2 tidak valid'),
  enabled: z.boolean().default(true),
  compress: z.boolean().default(false),
  basicAuthUser: z.string().trim().default('').refine((v) => v === '' || /^[A-Za-z0-9_.@-]{1,64}$/.test(v), 'username basic auth tidak valid'),
  basicAuthHash: z.string().trim().default('').refine((v) => v === '' || RE_BCRYPT.test(v), 'hash basic auth harus bcrypt (caddy hash-password)'),
  extra: caddySnippet,
  notes: z.string().max(500).default(''),
});
export type SiteInput = z.input<typeof siteInput>;

export const siteOptions = z.object({
  routeDns: z.boolean().default(false),
  overwriteDns: z.boolean().default(false),
  deleteOldDns: z.boolean().default(false),
});

export interface ApplyResult {
  caddy: { validated: boolean; reloaded: boolean; reason?: string };
  tunnels: Awaited<ReturnType<typeof cloudflared.syncConfigs>>;
}
export interface MutationResult { steps: string[]; warning?: string; apply?: ApplyResult | { skipped: true } }

export function findSite(id: string): Site {
  const s = db.sites.find((x) => x.id === id);
  if (!s) throw notFound('Domain tidak ditemukan');
  return s;
}

function assertUniqueHost(host: string, exceptId?: string): void {
  if (db.sites.some((x) => x.hostname === host && x.id !== exceptId)) throw badRequest('Hostname sudah dipakai domain lain');
}

/**
 * Apply a mutation to `db.sites`, validate the resulting Caddyfile, and roll back if Caddy rejects it.
 * This keeps a broken directive from ever reaching the running server.
 */
export async function mutateSites<T>(fn: () => T): Promise<T> {
  const snapshot = structuredClone(db.sites);
  const result = fn();
  const v = await caddy.validate(await caddy.current());
  if (!v.notFound && !v.ok) {
    db.sites = snapshot;
    activity.error('Config ditolak Caddy, perubahan dibatalkan', v.output);
    throw badRequest(`Config ditolak Caddy, perubahan dibatalkan:\n${v.output}`);
  }
  await saveDb();
  return result;
}

export async function applyAll(extraTunnels: string[] = []): Promise<ApplyResult> {
  const c = await caddy.writeCaddyfile();
  const r = await caddy.reload();
  const tunnels = await cloudflared.syncConfigs(extraTunnels);
  events.emit('config:changed');
  activity.info(`Apply: Caddyfile ${c.validated ? 'valid' : 'ditulis'}, ${r.reloaded ? 'caddy di-reload' : r.reason}`);
  return { caddy: { ...c, ...r }, tunnels };
}

export async function maybeApply(extraTunnels: string[] = []): Promise<ApplyResult | { skipped: true }> {
  return settings().autoApply ? applyAll(extraTunnels) : { skipped: true };
}

/** Side effects (DNS, apply) are best-effort: the site is saved even if Cloudflare is unreachable. */
async function sideEffects(out: MutationResult, fn: () => Promise<void>): Promise<MutationResult> {
  try { await fn(); } catch (e) { out.warning = errMsg(e); }
  return out;
}

export async function createSite(body: unknown): Promise<MutationResult & { site: Site }> {
  const input = parse(siteInput, body);
  const opts = parse(siteOptions, body);
  assertUniqueHost(input.hostname);
  const site: Site = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await mutateSites(() => db.sites.push(site));
  activity.info(`Domain dibuat: ${site.hostname} → ${site.upstreamHost}:${site.upstreamPort}`);
  const out: MutationResult & { site: Site } = { site, steps: [] };
  return sideEffects(out, async () => {
    if (opts.routeDns && site.tunnel) {
      await cloudflared.routeDns(site.tunnel, site.hostname, opts.overwriteDns);
      out.steps.push(`DNS di-route ke tunnel ${site.tunnel}`);
    }
    out.apply = await maybeApply();
  }) as Promise<MutationResult & { site: Site }>;
}

export async function updateSite(id: string, body: Record<string, unknown>): Promise<MutationResult & { site: Site }> {
  const cur = findSite(id);
  const next = parse(siteInput, { ...cur, ...body });
  const opts = parse(siteOptions, body);
  assertUniqueHost(next.hostname, id);
  const old = { hostname: cur.hostname, tunnel: cur.tunnel };
  await mutateSites(() => Object.assign(cur, next, { updatedAt: new Date().toISOString() }));
  activity.info(`Domain diubah: ${cur.hostname}`);
  const out: MutationResult & { site: Site } = { site: cur, steps: [] };
  return sideEffects(out, async () => {
    if (opts.routeDns && cur.tunnel && (old.hostname !== cur.hostname || old.tunnel !== cur.tunnel)) {
      await cloudflared.routeDns(cur.tunnel, cur.hostname, opts.overwriteDns);
      out.steps.push('DNS di-route');
    }
    if (opts.deleteOldDns && old.hostname !== cur.hostname) {
      await deleteTunnelCname(old.hostname);
      out.steps.push('DNS lama dihapus');
    }
    out.apply = await maybeApply(old.tunnel && old.tunnel !== cur.tunnel ? [old.tunnel] : []);
  }) as Promise<MutationResult & { site: Site }>;
}

export async function toggleSite(id: string): Promise<MutationResult & { site: Site }> {
  const s = findSite(id);
  await mutateSites(() => { s.enabled = !s.enabled; });
  activity.info(`Domain ${s.hostname} ${s.enabled ? 'diaktifkan' : 'dinonaktifkan'}`);
  const out: MutationResult & { site: Site } = { site: s, steps: [] };
  return sideEffects(out, async () => { out.apply = await maybeApply(); }) as Promise<MutationResult & { site: Site }>;
}

export async function deleteSite(id: string, deleteDns: boolean): Promise<MutationResult> {
  const s = findSite(id);
  db.sites = db.sites.filter((x) => x.id !== s.id);
  await saveDb();
  activity.info(`Domain dihapus: ${s.hostname}`);
  const out: MutationResult = { steps: [] };
  return sideEffects(out, async () => {
    if (deleteDns) out.steps.push(`${await deleteTunnelCname(s.hostname)} record DNS dihapus`);
    out.apply = await maybeApply(s.tunnel ? [s.tunnel] : []);
  });
}

/** Sites that route to a given app (by pm2 label, or by local port). */
export function sitesForApp(name: string, appPort: number): Site[] {
  return db.sites.filter((s) => s.pm2Name === name || (s.upstreamPort === appPort && /^(localhost|127\.0\.0\.1)$/.test(s.upstreamHost)));
}
