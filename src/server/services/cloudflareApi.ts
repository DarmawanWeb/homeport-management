import { activity } from '../lib/activity.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { settings } from '../store.js';

interface CfResponse<T> {
  success: boolean;
  errors?: { message: string }[];
  result: T;
  result_info?: { total_pages?: number };
}
interface Zone {
  id: string;
  name: string;
}
interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

export const hasToken = () => !!settings().cfApiToken;

async function cf<T>(method: string, path: string, body?: unknown): Promise<CfResponse<T>> {
  const token = settings().cfApiToken;
  if (!token) throw badRequest('Add a Cloudflare API token in Settings first');
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = (await res.json().catch(() => ({}))) as CfResponse<T>;
  if (!j.success) throw new HttpError(502, `Cloudflare API: ${j.errors?.map((e) => e.message).join('; ') || res.status}`);
  return j;
}

export async function listZones(): Promise<Zone[]> {
  const zones: Zone[] = [];
  for (let page = 1; ; page++) {
    const j = await cf<Zone[]>('GET', `/zones?per_page=50&page=${page}`);
    zones.push(...j.result);
    if (page >= (j.result_info?.total_pages ?? 1)) break;
  }
  return zones;
}

/** Pure: the zone a hostname belongs to (the longest match, so a.b.example.com picks b.example.com if both exist). */
export function pickZone<Z extends { name: string }>(zones: Z[], hostname: string): Z | undefined {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return zones
    .filter((z) => host === z.name.toLowerCase() || host.endsWith(`.${z.name.toLowerCase()}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

async function zoneFor(hostname: string): Promise<Zone> {
  const zone = pickZone(await listZones(), hostname);
  if (!zone)
    throw notFound(
      `No zone for ${hostname} is visible to the Cloudflare API token. Add the domain to Cloudflare, or give the token access to it.`,
    );
  return zone;
}

/**
 * Point `hostname` at a tunnel with a proxied CNAME, in whichever zone it belongs to. Works for a
 * root domain (example.com, flattened by Cloudflare) as well as any subdomain, and for every zone
 * the token can see, unlike `cloudflared tunnel route dns`, which only knows the zone of cert.pem.
 */
export async function upsertTunnelCname(hostname: string, tunnelId: string, overwrite: boolean): Promise<'created' | 'unchanged'> {
  const zone = await zoneFor(hostname);
  const target = `${tunnelId}.cfargotunnel.com`;
  const recs = (await cf<DnsRecord[]>('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`)).result;
  const clashing = recs.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
  if (clashing.length === 1 && clashing[0]?.type === 'CNAME' && clashing[0].content === target) return 'unchanged';
  if (clashing.length && !overwrite) {
    const r = clashing[0]!;
    throw badRequest(
      `${hostname} already has a DNS record (${r.type} → ${r.content}). Turn on "Replace an existing DNS record" to point it at the tunnel.`,
    );
  }
  for (const r of clashing) await cf('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
  await cf('POST', `/zones/${zone.id}/dns_records`, {
    type: 'CNAME',
    name: hostname,
    content: target,
    proxied: true,
    ttl: 1,
    comment: 'Homeport',
  });
  activity.info(`DNS ${hostname}: CNAME to tunnel ${tunnelId} in zone ${zone.name}${clashing.length ? ' (replaced the old record)' : ''}`);
  return 'created';
}

/** Delete CNAME records for `hostname` that point at a Cloudflare Tunnel. Returns how many were removed. */
export async function deleteTunnelCname(hostname: string): Promise<number> {
  const zone = await zoneFor(hostname);
  const recs = await cf<DnsRecord[]>('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
  const targets = recs.result.filter((r) => r.type === 'CNAME' && r.content.endsWith('.cfargotunnel.com'));
  for (const r of targets) await cf('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
  activity.info(`DNS ${hostname}: deleted ${targets.length} tunnel CNAME record(s)`);
  return targets.length;
}
