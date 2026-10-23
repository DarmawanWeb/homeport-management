import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { activity } from '../lib/activity.js';
import { settings } from '../store.js';

interface CfResponse<T> { success: boolean; errors?: { message: string }[]; result: T; result_info?: { total_pages?: number } }
interface Zone { id: string; name: string }
interface DnsRecord { id: string; type: string; name: string; content: string }

async function cf<T>(method: string, path: string): Promise<CfResponse<T>> {
  const token = settings().cfApiToken;
  if (!token) throw badRequest('Cloudflare API token belum diisi di Settings');
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

/** Delete CNAME records for `hostname` that point at a Cloudflare Tunnel. Returns how many were removed. */
export async function deleteTunnelCname(hostname: string): Promise<number> {
  const zone = (await listZones())
    .filter((z) => hostname === z.name || hostname.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!zone) throw notFound(`Zone untuk ${hostname} tidak ditemukan pada token ini`);
  const recs = await cf<DnsRecord[]>('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
  const targets = recs.result.filter((r) => r.type === 'CNAME' && r.content.endsWith('.cfargotunnel.com'));
  for (const r of targets) await cf('DELETE', `/zones/${zone.id}/dns_records/${r.id}`);
  activity.info(`DNS ${hostname}: ${targets.length} record CNAME tunnel dihapus`);
  return targets.length;
}
