import { afterEach, describe, expect, it, vi } from 'vitest';
import { upsertTunnelCname } from '../src/server/services/cloudflareApi.js';
import { db } from '../src/server/store.js';

type Rec = { id: string; type: string; name: string; content: string };

/** A tiny Cloudflare API: one zone and whatever records the test starts with. */
function fakeCloudflare(records: Rec[]) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { method: string; body?: string }) => {
    const u = new URL(url);
    calls.push(`${init.method} ${u.pathname}`);
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result, result_info: { total_pages: 1 } }));
    if (u.pathname.endsWith('/zones')) return ok([{ id: 'z1', name: 'agus-darmawan.com' }]);
    if (init.method === 'GET') return ok(records.filter((r) => r.name === u.searchParams.get('name')));
    if (init.method === 'DELETE') return ok({ id: u.pathname.split('/').pop() });
    if (init.method === 'POST') return ok({ id: 'new', ...JSON.parse(init.body ?? '{}') });
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'unexpected' }] }));
  });
  return calls;
}

describe('DNS records over the Cloudflare API', () => {
  db.settings.cfApiToken = 'test-token';
  afterEach(() => vi.unstubAllGlobals());

  it('creates a proxied CNAME for a root domain or any subdomain', async () => {
    const calls = fakeCloudflare([]);
    expect(await upsertTunnelCname('edu.agus-darmawan.com', 'tid', false)).toBe('created');
    expect(await upsertTunnelCname('agus-darmawan.com', 'tid', false)).toBe('created');
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(2);
  });

  it('refuses to replace another record unless asked, then replaces it', async () => {
    const old = [{ id: 'r1', type: 'CNAME', name: 'edu.agus-darmawan.com', content: 'cname.vercel-dns.com' }];
    fakeCloudflare(old);
    await expect(upsertTunnelCname('edu.agus-darmawan.com', 'tid', false)).rejects.toThrow(
      /already has a DNS record \(CNAME → cname\.vercel-dns\.com\)/,
    );
    const calls = fakeCloudflare(old);
    expect(await upsertTunnelCname('edu.agus-darmawan.com', 'tid', true)).toBe('created');
    expect(calls).toContain('DELETE /client/v4/zones/z1/dns_records/r1');
  });

  it('leaves a record that already points at the tunnel alone', async () => {
    const calls = fakeCloudflare([{ id: 'r1', type: 'CNAME', name: 'edu.agus-darmawan.com', content: 'tid.cfargotunnel.com' }]);
    expect(await upsertTunnelCname('edu.agus-darmawan.com', 'tid', false)).toBe('unchanged');
    expect(calls.some((c) => c.startsWith('POST') || c.startsWith('DELETE'))).toBe(false);
  });

  it('says so when the domain is not on Cloudflare yet', async () => {
    fakeCloudflare([]);
    await expect(upsertTunnelCname('dctedu.id', 'tid', false)).rejects.toThrow(/No zone for dctedu\.id/);
  });
});
