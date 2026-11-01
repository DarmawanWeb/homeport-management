import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/server/config.js';
import { generateCaddyfile } from '../src/server/services/caddy.js';
import { pickZone } from '../src/server/services/cloudflareApi.js';
import { generateIngress, readRouteDns } from '../src/server/services/cloudflared.js';
import { isRootDomain } from '../web/src/lib/format.js';

describe('hostnames of any shape', () => {
  it('picks the zone a hostname belongs to, root domains included', () => {
    const zones = [{ name: 'agus-darmawan.com' }, { name: 'dctedu.id' }, { name: 'shop.co.id' }];
    expect(pickZone(zones, 'agus-darmawan.com')?.name).toBe('agus-darmawan.com');
    expect(pickZone(zones, 'edu.agus-darmawan.com')?.name).toBe('agus-darmawan.com');
    expect(pickZone(zones, 'edu-sim.agus-darmawan.com')?.name).toBe('agus-darmawan.com');
    expect(pickZone(zones, 'DCTEdu.id.')?.name).toBe('dctedu.id');
    expect(pickZone(zones, 'www.shop.co.id')?.name).toBe('shop.co.id');
    // A lookalike is not a subdomain.
    expect(pickZone(zones, 'notagus-darmawan.com')).toBeUndefined();
  });

  it('notices when cloudflared put the record in the zone it is signed in to', () => {
    const ok = readRouteDns('edu.agus-darmawan.com', 'INF Added CNAME edu.agus-darmawan.com which will route to this tunnel tunnelID=abc');
    expect(ok).toEqual({ added: 'edu.agus-darmawan.com', wrongZone: false, exists: false });

    const root = readRouteDns('dctedu.id', 'INF Added CNAME dctedu.id which will route to this tunnel tunnelID=abc');
    expect(root.wrongZone).toBe(false);

    const wrong = readRouteDns('dctedu.id', 'INF Added CNAME dctedu.id.agus-darmawan.com which will route to this tunnel tunnelID=abc');
    expect(wrong).toMatchObject({ added: 'dctedu.id.agus-darmawan.com', wrongZone: true });

    const exists = readRouteDns(
      'edu.agus-darmawan.com',
      'Failed to add route: code: 1003, reason: Failed to create record edu.agus-darmawan.com with err An A, AAAA, or CNAME record with that host already exists.',
    );
    expect(exists).toMatchObject({ added: null, wrongZone: false, exists: true });
  });

  it('routes root domains and single-word subdomains like any other host', () => {
    const sites = ['dctedu.id', 'www.dctedu.id', 'edu.agus-darmawan.com', 'edu-sim.agus-darmawan.com'].map((hostname, i) => ({
      id: String(i),
      hostname,
      upstreamHost: 'localhost',
      upstreamPort: 3001 + i,
      scheme: 'http' as const,
      tlsInsecure: false,
      tunnel: 't',
      pm2Name: '',
      enabled: true,
      compress: false,
      basicAuthUser: '',
      basicAuthHash: '',
      extra: '',
      notes: '',
      createdAt: '',
    }));
    const caddy = generateCaddyfile({ settings: defaultSettings(), sites, metrics: 'per_host' });
    for (const s of sites) expect(caddy).toContain(`http://${s.hostname} {`);
    const ingress = generateIngress(
      { id: 'abc', name: 't' },
      sites.map((s) => s.hostname),
      8080,
      '/x.json',
    );
    for (const s of sites) expect(ingress).toContain(`hostname: "${s.hostname}"`);
  });

  it('tells root domains from subdomains for the www option', () => {
    expect(isRootDomain('dctedu.id')).toBe(true);
    expect(isRootDomain('agus-darmawan.com')).toBe(true);
    expect(isRootDomain('dctedu.co.id')).toBe(true);
    expect(isRootDomain('edu.agus-darmawan.com')).toBe(false);
    expect(isRootDomain('edu-sim.agus-darmawan.com')).toBe(false);
    expect(isRootDomain('shop.dctedu.co.id')).toBe(false);
  });
});
