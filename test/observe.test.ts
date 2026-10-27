import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgent, parseLine } from '../src/server/analytics/parse.js';
import { AnalyticsStore } from '../src/server/analytics/store.js';
import { parseNetstat, parseProcNetDev } from '../src/server/monitoring/netstat.js';
import { generateCaddyfile } from '../src/server/services/caddy.js';
import type { Site } from '../src/shared/types.js';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/** A line as Caddy writes it, with the headers Cloudflare adds. */
function caddyLine(o: {
  uri?: string;
  status?: number;
  ua?: string;
  ip?: string;
  country?: string;
  city?: string;
  accept?: string;
  ref?: string;
  ts?: number;
}) {
  const headers: Record<string, string[]> = { 'User-Agent': [o.ua ?? MAC_CHROME], Accept: [o.accept ?? 'text/html,application/xhtml+xml'] };
  if (o.ip) headers['Cf-Connecting-Ip'] = [o.ip];
  if (o.country) headers['Cf-Ipcountry'] = [o.country];
  if (o.city) {
    headers['Cf-Ipcity'] = [o.city];
    headers['Cf-Iplatitude'] = ['-6.2'];
    headers['Cf-Iplongitude'] = ['106.8'];
  }
  if (o.ref) headers.Referer = [o.ref];
  return JSON.stringify({
    level: 'info',
    ts: (o.ts ?? Date.now()) / 1000,
    logger: 'http.log.access',
    msg: 'handled request',
    request: { remote_ip: '127.0.0.1', client_ip: '127.0.0.1', host: 'shop.example.com', method: 'GET', uri: o.uri ?? '/', headers },
    duration: 0.042,
    size: 5120,
    status: o.status ?? 200,
  });
}

describe('access log parsing', () => {
  it('reads visitor, location and device from a Caddy line', () => {
    const h = parseLine(
      caddyLine({
        uri: '/products?page=2',
        ip: '36.68.1.2',
        country: 'id',
        city: 'Jakarta',
        ua: IPHONE,
        ref: 'https://www.google.com/search?q=x',
      }),
    )!;
    expect(h).toMatchObject({
      host: 'shop.example.com',
      path: '/products',
      ip: '36.68.1.2',
      country: 'ID',
      city: 'Jakarta',
      lat: -6.2,
      device: 'mobile',
      browser: 'Safari',
      os: 'iOS',
      referrer: 'google.com',
      pageview: true,
    });
  });

  it('tells pages from assets, API calls, errors and bots', () => {
    expect(parseLine(caddyLine({ uri: '/assets/app.js', accept: '*/*' }))!.pageview).toBe(false);
    expect(parseLine(caddyLine({ uri: '/api/cart', accept: 'application/json' }))!.pageview).toBe(false);
    expect(parseLine(caddyLine({ status: 404 }))!.pageview).toBe(false);
    expect(parseLine(caddyLine({ ua: 'Googlebot/2.1' }))!.device).toBe('bot');
    expect(parseLine(caddyLine({ ua: 'Homeport-Uptime/1.0' }))).toBeNull();
    expect(parseLine('not json')).toBeNull();
  });

  it('marks private addresses as LAN when Cloudflare is not in front', () => {
    expect(parseLine(caddyLine({ ip: '192.168.1.40' }))!.country).toBe('LAN');
  });

  it('recognises common browsers and systems', () => {
    expect(parseAgent(MAC_CHROME)).toEqual({ browser: 'Chrome', os: 'macOS', device: 'desktop' });
    expect(
      parseAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 Edg/141.0'),
    ).toMatchObject({
      browser: 'Edge',
      os: 'Windows',
    });
    expect(
      parseAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'),
    ).toMatchObject({
      os: 'Android',
      device: 'mobile',
    });
  });
});

describe('analytics store', () => {
  const now = Date.UTC(2026, 9, 26, 15, 30);
  const mk = () => new AnalyticsStore(fs.mkdtempSync(path.join(os.tmpdir(), 'hp-an-')), 90, () => now);
  const add = (s: AnalyticsStore, o: Parameters<typeof caddyLine>[0]) => s.add(parseLine(caddyLine({ ts: now - 60_000, ...o }))!);

  it('counts unique visitors, page views and countries', () => {
    const s = mk();
    add(s, { ip: '1.1.1.1', country: 'ID', city: 'Jakarta' });
    add(s, { ip: '1.1.1.1', country: 'ID', city: 'Jakarta', uri: '/about' });
    add(s, { ip: '2.2.2.2', country: 'SG', ua: IPHONE });
    add(s, { ip: '2.2.2.2', uri: '/app.js', accept: '*/*', country: 'SG', ua: IPHONE });
    add(s, { ip: '3.3.3.3', ua: 'Googlebot/2.1', country: 'US' });
    const q = s.query('24h');
    expect(q.totals).toMatchObject({ visitors: 2, pageviews: 3, requests: 5 });
    expect(q.countries.map((c) => [c.code, c.visitors])).toEqual([
      ['ID', 1],
      ['SG', 1],
    ]);
    expect(q.cities[0]).toMatchObject({ name: 'Jakarta', country: 'ID', visitors: 1 });
    expect(q.pages[0]).toEqual({ name: '/', count: 2 });
    expect(q.devices.map((d) => d.name).sort()).toEqual(['desktop', 'mobile']);
    expect(q.bots).toBe(1);
    expect(q.live.activeNow).toBe(2);
    expect(JSON.stringify(q)).not.toContain('1.1.1.1');
  });

  it('computes error rate and p95 latency', () => {
    const s = mk();
    for (let i = 0; i < 19; i++) add(s, { ip: `9.9.9.${i}` });
    add(s, { ip: '9.9.9.99', status: 502 });
    const q = s.query('24h');
    expect(q.totals.errors).toBe(1);
    expect(q.totals.errorRate).toBeCloseTo(0.05);
    expect(q.totals.p95).toBe(0.05);
    expect(q.status['5xx']).toBe(1);
  });

  it('keeps counts but never raw addresses on disk, and reloads them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-an-'));
    const s = new AnalyticsStore(dir, 90, () => now);
    s.add(parseLine(caddyLine({ ts: now - 60_000, ip: '203.0.113.9', country: 'JP' }))!);
    s.flush();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'salt.json');
    expect(files).toEqual(['2026-10-26.json']);
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).not.toContain('203.0.113.9');
    const again = new AnalyticsStore(dir, 90, () => now);
    again.load();
    expect(again.query('24h').totals.visitors).toBe(1);
  });
});

describe('network counters', () => {
  it('parses /proc/net/dev', () => {
    const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
  eth0: 52428800  40000    0    0    0     0          0         0 10485760   20000    0    0    0     0       0          0`;
    expect(parseProcNetDev(text).get('eth0')).toEqual({ rx: 52428800, tx: 10485760 });
  });

  it('parses macOS netstat -ibn', () => {
    const text = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                         1000     0     200000     1000     0     200000     0
en0        1500  <Link#6>    3c:22:fb:00:00:01  900000     0  734003200   500000     0  104857600     0
en0        1500  192.168.1     192.168.1.20      900000     -  734003200   500000     -  104857600     -`;
    const c = parseNetstat(text);
    expect(c.get('en0')).toEqual({ rx: 734003200, tx: 104857600 });
    expect(c.get('lo0')).toEqual({ rx: 200000, tx: 200000 });
  });
});

describe('Caddy access log', () => {
  const site = (over: Partial<Site>): Site =>
    ({
      id: 'x',
      hostname: 'shop.example.com',
      upstreamHost: 'localhost',
      upstreamPort: 3001,
      scheme: 'http',
      tunnel: '',
      pm2Name: '',
      enabled: true,
      compress: false,
      tlsInsecure: false,
      basicAuthUser: '',
      basicAuthHash: '',
      extra: '',
      notes: '',
      createdAt: '',
      ...over,
    }) as Site;
  const st = { caddyAdmin: 'localhost:2019', caddyHttpPort: 8080, caddyGlobalExtra: '', caddyRawAppend: '' };

  it('logs visitor traffic but not the dashboard or webhooks', () => {
    const out = generateCaddyfile({
      settings: st,
      sites: [site({}), site({ hostname: 'deploy.example.com', upstreamPort: 7070 })],
      metrics: 'per_host',
      accessLog: { file: '/data/analytics/access.log', skip: (s) => s.upstreamPort === 7070 },
    });
    const shop = out.slice(out.indexOf('http://shop.example.com'), out.indexOf('http://deploy.example.com'));
    const dash = out.slice(out.indexOf('http://deploy.example.com'));
    expect(shop).toContain('output file /data/analytics/access.log');
    expect(shop).toContain('format json');
    expect(dash).not.toContain('access.log');
  });
});

describe('uptime incidents', async () => {
  const { record, resetUptime, uptime } = await import('../src/server/uptime/index.js');
  const { db } = await import('../src/server/store.js');

  it('opens an incident after two failures and closes it on the next success', () => {
    resetUptime();
    db.sites.push({ id: 'u', hostname: 'shop.example.com', upstreamPort: 3001, upstreamHost: 'localhost', enabled: true } as Site);
    const t0 = Date.now() - 10 * 60_000;
    record('shop.example.com', { ts: t0, ok: true, status: 200, ms: 120 }, false);
    record('shop.example.com', { ts: t0 + 60_000, ok: false, status: null, ms: null, error: 'Timed out after 10 s' }, false);
    expect(uptime().incidents).toHaveLength(0);
    record('shop.example.com', { ts: t0 + 120_000, ok: false, status: 502, ms: 30, error: 'HTTP 502' }, false);
    const open = uptime();
    expect(open.hosts[0].state).toBe('down');
    expect(open.incidents[0]).toMatchObject({ host: 'shop.example.com', start: t0 + 60_000, end: null, cause: 'HTTP 502' });
    record('shop.example.com', { ts: t0 + 180_000, ok: true, status: 200, ms: 110 }, false);
    const closed = uptime();
    expect(closed.hosts[0].state).toBe('up');
    expect(closed.incidents[0].end).toBe(t0 + 180_000);
    expect(closed.hosts[0].uptime24h).toBeCloseTo(0.5);
    expect(closed.hosts[0].avgMs24h).toBe(115);
    db.sites.length = 0;
  });
});

describe('uptime check in local mode', async () => {
  const http = await import('node:http');
  const { checkOnce } = await import('../src/server/uptime/index.js');
  const { settings, db } = await import('../src/server/store.js');

  it('asks Caddy with the right Host header, and a 5xx is down', async () => {
    const seen: string[] = [];
    const srv = http.createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.headers['user-agent']}`);
      res.statusCode = req.headers.host === 'shop.example.com' ? 200 : 502;
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    settings().caddyHttpPort = (srv.address() as { port: number }).port;
    db.sites.push(
      { id: 'a', hostname: 'shop.example.com', enabled: true } as Site,
      { id: 'b', hostname: 'wiki.example.com', enabled: true } as Site,
    );
    const ok = await checkOnce('shop.example.com', 'local');
    const bad = await checkOnce('wiki.example.com', 'local');
    srv.close();
    db.sites.length = 0;
    expect(seen).toEqual(['shop.example.com Homeport-Uptime/1.0', 'wiki.example.com Homeport-Uptime/1.0']);
    expect(ok).toMatchObject({ ok: true, status: 200 });
    expect(bad).toMatchObject({ ok: false, status: 502, error: 'HTTP 502' });
  });
});
