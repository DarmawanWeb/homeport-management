import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AnalyticsDTO, AnalyticsRange, AnalyticsTotals, CountItem } from '../../shared/types.js';
import type { Device, Hit } from './parse.js';

/**
 * Aggregated traffic, privacy-first (the approach Plausible and Fathom use):
 * - raw IP addresses are never stored; a visitor is sha256(daily salt + IP + user agent), and the salt
 *   is replaced every day, so the same person cannot be followed from one day to the next;
 * - only hourly counts per host are kept on disk, for the retention period.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MINUTE = 60_000;
/** Upper bounds (seconds) of the latency histogram used for p95. */
export const LAT_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, Number.POSITIVE_INFINITY];

type Counts = Record<string, number>;

interface Bucket {
  hour: number;
  host: string;
  requests: number;
  pageviews: number;
  bots: number;
  bytes: number;
  s2: number;
  s3: number;
  s4: number;
  s5: number;
  durSum: number;
  lat: number[];
  visitors: Set<string>;
  /** country → visitor ids */
  countryVisitors: Record<string, Set<string>>;
  countryViews: Counts;
  /** "city|country" → { visitors, lat, lon } */
  cities: Record<string, { v: Set<string>; lat: number | null; lon: number | null }>;
  paths: Counts;
  referrers: Counts;
  browsers: Counts;
  os: Counts;
  devices: Counts;
}

interface MinutePoint {
  requests: number;
  pageviews: number;
  errors: number;
  visitors: Set<string>;
}

export interface LiveHit {
  ts: number;
  host: string;
  path: string;
  country: string;
  city: string;
  device: Device;
  browser: string;
  os: string;
  referrer: string;
  vid: string;
}

const emptyBucket = (hour: number, host: string): Bucket => ({
  hour,
  host,
  requests: 0,
  pageviews: 0,
  bots: 0,
  bytes: 0,
  s2: 0,
  s3: 0,
  s4: 0,
  s5: 0,
  durSum: 0,
  lat: LAT_BUCKETS.map(() => 0),
  visitors: new Set(),
  countryVisitors: {},
  countryViews: {},
  cities: {},
  paths: {},
  referrers: {},
  browsers: {},
  os: {},
  devices: {},
});

const inc = (c: Counts, k: string, n = 1) => {
  if (k) c[k] = (c[k] ?? 0) + n;
};
const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const top = (c: Counts, n = 10): CountItem[] =>
  Object.entries(c)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));

export class AnalyticsStore {
  private buckets = new Map<string, Bucket>();
  private minutes = new Map<string, MinutePoint>();
  private recent: LiveHit[] = [];
  private dirtyDays = new Set<string>();
  private salt = { day: '', value: '' };
  lastHitAt = 0;
  sawLocationHeaders = false;

  constructor(
    private readonly dir: string,
    private readonly retentionDays = 90,
    private readonly now = () => Date.now(),
  ) {}

  // ---------------------------------------------------------------- visitors

  private visitorId(ip: string, ua: string, ts: number): string {
    const day = dayKey(ts);
    if (this.salt.day !== day) {
      if (day > this.salt.day) {
        // A new day: forget the old salt for good, so yesterday's visitors cannot be linked to today's.
        this.salt = { day, value: crypto.randomBytes(16).toString('hex') };
        this.saveSalt();
      } else {
        // A late line from an earlier day: hash it with a throwaway salt rather than disturbing today's.
        return crypto.createHash('sha256').update(`${day}|${ip}|${ua}`).update(crypto.randomBytes(8)).digest('base64url').slice(0, 16);
      }
    }
    return crypto.createHash('sha256').update(`${this.salt.value}|${ip}|${ua}`).digest('base64url').slice(0, 16);
  }

  // ---------------------------------------------------------------- ingest

  add(hit: Hit): void {
    const hour = Math.floor(hit.ts / HOUR) * HOUR;
    const key = `${hour}|${hit.host}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = emptyBucket(hour, hit.host);
      this.buckets.set(key, b);
    }
    this.dirtyDays.add(dayKey(hour));
    this.lastHitAt = Math.max(this.lastHitAt, hit.ts);

    b.requests++;
    b.bytes += hit.bytes;
    b.durSum += hit.duration;
    b.lat[LAT_BUCKETS.findIndex((u) => hit.duration <= u)]++;
    const cls = Math.floor(hit.status / 100);
    if (cls === 2) b.s2++;
    else if (cls === 3) b.s3++;
    else if (cls === 4) b.s4++;
    else if (cls >= 5) b.s5++;

    const minuteKey = `${Math.floor(hit.ts / MINUTE) * MINUTE}|${hit.host}`;
    let mp = this.minutes.get(minuteKey);
    if (!mp) {
      mp = { requests: 0, pageviews: 0, errors: 0, visitors: new Set() };
      this.minutes.set(minuteKey, mp);
    }
    mp.requests++;
    if (hit.status >= 500) mp.errors++;

    if (hit.device === 'bot') {
      b.bots++;
      return;
    }
    const vid = this.visitorId(hit.ip, hit.ua, hit.ts);
    b.visitors.add(vid);
    mp.visitors.add(vid);
    if (hit.city) this.sawLocationHeaders = true;
    if (!hit.pageview) return;

    b.pageviews++;
    mp.pageviews++;
    if (hit.country) {
      b.countryVisitors[hit.country] ??= new Set();
      b.countryVisitors[hit.country].add(vid);
      inc(b.countryViews, hit.country);
    }
    if (hit.city) {
      const ck = `${hit.city}|${hit.country}`;
      b.cities[ck] ??= { v: new Set(), lat: hit.lat, lon: hit.lon };
      b.cities[ck].v.add(vid);
    }
    inc(b.paths, hit.path);
    inc(b.referrers, hit.referrer || '(direct)');
    inc(b.browsers, hit.browser);
    inc(b.os, hit.os);
    inc(b.devices, hit.device);

    this.recent.unshift({
      ts: hit.ts,
      host: hit.host,
      path: hit.path,
      country: hit.country,
      city: hit.city,
      device: hit.device,
      browser: hit.browser,
      os: hit.os,
      referrer: hit.referrer,
      vid,
    });
    if (this.recent.length > 200) this.recent.length = 200;
  }

  // ---------------------------------------------------------------- query

  hosts(): string[] {
    return [...new Set([...this.buckets.values()].map((b) => b.host))].sort();
  }

  private bucketsIn(from: number, to: number, host: string): Bucket[] {
    const out: Bucket[] = [];
    for (const b of this.buckets.values()) {
      if (b.hour + HOUR <= from || b.hour >= to) continue;
      if (host !== 'all' && b.host !== host) continue;
      out.push(b);
    }
    return out;
  }

  private totals(bs: Bucket[]): AnalyticsTotals {
    const t = { requests: 0, pageviews: 0, bytes: 0, errors: 0, durSum: 0, lat: LAT_BUCKETS.map(() => 0) };
    // Visitor ids change daily, so unique visitors over a range is the sum of each day's uniques.
    const perDay = new Map<string, Set<string>>();
    for (const b of bs) {
      t.requests += b.requests;
      t.pageviews += b.pageviews;
      t.bytes += b.bytes;
      t.errors += b.s5;
      t.durSum += b.durSum;
      b.lat.forEach((n, i) => {
        t.lat[i] += n;
      });
      const d = dayKey(b.hour);
      const set = perDay.get(d) ?? new Set<string>();
      for (const v of b.visitors) set.add(v);
      perDay.set(d, set);
    }
    let visitors = 0;
    for (const s of perDay.values()) visitors += s.size;
    return {
      visitors,
      pageviews: t.pageviews,
      requests: t.requests,
      bytes: t.bytes,
      errors: t.errors,
      errorRate: t.requests ? t.errors / t.requests : 0,
      avgDuration: t.requests ? t.durSum / t.requests : 0,
      p95: percentile(t.lat, 0.95),
    };
  }

  query(range: AnalyticsRange, host = 'all'): Omit<AnalyticsDTO, 'enabled' | 'receiving'> {
    const now = this.now();
    const span = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }[range];
    const from = now - span;
    const bs = this.bucketsIn(from, now + 1, host);
    const prev = this.bucketsIn(from - span, from, host);

    // Series
    const series: AnalyticsDTO['series'] = [];
    if (range === '1h') {
      for (let t = Math.floor(from / MINUTE) * MINUTE + MINUTE; t <= now; t += MINUTE) {
        const pts = [...this.minutes.entries()].filter(
          ([k]) => Number(k.split('|')[0]) === t && (host === 'all' || k.endsWith(`|${host}`)),
        );
        const vis = new Set<string>();
        let requests = 0;
        let pageviews = 0;
        let errors = 0;
        for (const [, p] of pts) {
          requests += p.requests;
          pageviews += p.pageviews;
          errors += p.errors;
          for (const v of p.visitors) vis.add(v);
        }
        series.push({ t, visitors: vis.size, pageviews, requests, errors });
      }
    } else {
      const step = range === '30d' ? DAY : HOUR;
      const start = Math.floor(from / step) * step + step;
      for (let t = start; t <= now; t += step) {
        const slice = bs.filter((b) => b.hour >= t && b.hour < t + step);
        const tot = this.totals(slice);
        series.push({ t, visitors: tot.visitors, pageviews: tot.pageviews, requests: tot.requests, errors: tot.errors });
      }
    }

    // Breakdowns
    const merge = (pick: (b: Bucket) => Counts) => {
      const c: Counts = {};
      for (const b of bs) for (const [k, v] of Object.entries(pick(b))) inc(c, k, v);
      return c;
    };
    const countryV = new Map<string, Set<string>>();
    const cityV = new Map<string, { v: Set<string>; lat: number | null; lon: number | null }>();
    for (const b of bs) {
      for (const [c, set] of Object.entries(b.countryVisitors)) {
        const s = countryV.get(c) ?? new Set<string>();
        for (const v of set) s.add(v);
        countryV.set(c, s);
      }
      for (const [k, x] of Object.entries(b.cities)) {
        const cur = cityV.get(k) ?? { v: new Set<string>(), lat: x.lat, lon: x.lon };
        for (const v of x.v) cur.v.add(v);
        cityV.set(k, cur);
      }
    }
    const countryViews = merge((b) => b.countryViews);
    const countries = [...countryV.entries()]
      .map(([code, s]) => ({ code, visitors: s.size, pageviews: countryViews[code] ?? 0 }))
      .sort((a, b) => b.visitors - a.visitors || b.pageviews - a.pageviews);
    const cities = [...cityV.entries()]
      .map(([k, x]) => {
        const [name, country] = k.split('|');
        return { name, country, lat: x.lat, lon: x.lon, visitors: x.v.size };
      })
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, 50);

    const status = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    let bots = 0;
    for (const b of bs) {
      status['2xx'] += b.s2;
      status['3xx'] += b.s3;
      status['4xx'] += b.s4;
      status['5xx'] += b.s5;
      bots += b.bots;
    }

    const live = this.recent.filter((r) => host === 'all' || r.host === host);
    const active = new Set(live.filter((r) => now - r.ts < 5 * MINUTE).map((r) => r.vid));
    for (const [k, p] of this.minutes) {
      const t = Number(k.split('|')[0]);
      if (now - t < 5 * MINUTE && (host === 'all' || k.endsWith(`|${host}`))) for (const v of p.visitors) active.add(v);
    }

    return {
      range,
      host,
      hosts: this.hosts(),
      locationHeaders: this.sawLocationHeaders,
      totals: this.totals(bs),
      previous: this.totals(prev),
      series,
      countries,
      cities,
      pages: top(
        merge((b) => b.paths),
        12,
      ),
      referrers: top(
        merge((b) => b.referrers),
        10,
      ),
      browsers: top(
        merge((b) => b.browsers),
        8,
      ),
      os: top(
        merge((b) => b.os),
        8,
      ),
      devices: top(
        merge((b) => b.devices),
        4,
      ),
      status,
      bots,
      live: {
        activeNow: active.size,
        recent: live.slice(0, 30).map(({ vid: _v, ...r }) => r),
      },
    };
  }

  // ---------------------------------------------------------------- persistence

  private file = (day: string) => path.join(this.dir, `${day}.json`);

  private saveSalt(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'salt.json'), JSON.stringify(this.salt), { mode: 0o600 });
  }

  load(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.dir, 'salt.json'), 'utf8')) as { day: string; value: string };
      if (s.day === dayKey(this.now())) this.salt = s;
    } catch {
      /* new salt on first hit */
    }
    const oldest = dayKey(this.now() - this.retentionDays * DAY);
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (!m) continue;
      if (m[1] < oldest) {
        fs.rmSync(path.join(this.dir, f), { force: true });
        continue;
      }
      try {
        const rows = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as SerialBucket[];
        for (const r of rows) this.buckets.set(`${r.hour}|${r.host}`, revive(r));
        this.lastHitAt = Math.max(this.lastHitAt, ...rows.map((r) => r.hour));
      } catch {
        /* skip a damaged day rather than refusing to start */
      }
    }
    for (const b of this.buckets.values()) if (Object.keys(b.cities).length) this.sawLocationHeaders = true;
  }

  /** Write changed days and drop data past retention. Cheap enough to run every minute. */
  flush(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const day of this.dirtyDays) {
      const rows = [...this.buckets.values()].filter((b) => dayKey(b.hour) === day).map(serialize);
      const tmp = `${this.file(day)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows));
      fs.renameSync(tmp, this.file(day));
    }
    this.dirtyDays.clear();
    const cutoff = this.now() - this.retentionDays * DAY;
    for (const [k, b] of this.buckets) if (b.hour < cutoff) this.buckets.delete(k);
    for (const k of this.minutes.keys()) if (Number(k.split('|')[0]) < this.now() - 2 * HOUR) this.minutes.delete(k);
    const oldest = dayKey(cutoff);
    for (const f of fs.readdirSync(this.dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (m && m[1] < oldest) fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}

function percentile(hist: number[], q: number): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen / total >= q) return Number.isFinite(LAT_BUCKETS[i]) ? LAT_BUCKETS[i] : LAT_BUCKETS[i - 1];
  }
  return LAT_BUCKETS[LAT_BUCKETS.length - 2];
}

type SerialBucket = Omit<Bucket, 'visitors' | 'countryVisitors' | 'cities'> & {
  visitors: string[];
  countryVisitors: Record<string, string[]>;
  cities: Record<string, { v: string[]; lat: number | null; lon: number | null }>;
};

const serialize = (b: Bucket): SerialBucket => ({
  ...b,
  visitors: [...b.visitors],
  countryVisitors: Object.fromEntries(Object.entries(b.countryVisitors).map(([k, s]) => [k, [...s]])),
  cities: Object.fromEntries(Object.entries(b.cities).map(([k, c]) => [k, { ...c, v: [...c.v] }])),
});

const revive = (r: SerialBucket): Bucket => ({
  ...emptyBucket(r.hour, r.host),
  ...r,
  visitors: new Set(r.visitors),
  countryVisitors: Object.fromEntries(Object.entries(r.countryVisitors ?? {}).map(([k, a]) => [k, new Set(a)])),
  cities: Object.fromEntries(Object.entries(r.cities ?? {}).map(([k, c]) => [k, { ...c, v: new Set(c.v) }])),
});
