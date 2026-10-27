/**
 * Turns one line of Caddy's JSON access log into a Hit. Pure: no I/O, easy to test.
 *
 * Location comes from Cloudflare, which adds CF-IPCountry to every request through the tunnel and,
 * with the free "Add visitor location headers" managed transform, city, region and coordinates.
 */

export type Device = 'desktop' | 'mobile' | 'tablet' | 'bot';

export interface Hit {
  ts: number;
  host: string;
  method: string;
  path: string;
  status: number;
  bytes: number;
  /** Seconds. */
  duration: number;
  ip: string;
  ua: string;
  /** Referring site (hostname), '' for direct visits or the site itself. */
  referrer: string;
  /** ISO 3166-1 alpha-2, 'LAN' for private networks, '' when unknown. */
  country: string;
  city: string;
  region: string;
  lat: number | null;
  lon: number | null;
  browser: string;
  os: string;
  device: Device;
  /** A real page load, not an asset, API call or bot. */
  pageview: boolean;
}

type Headers = Record<string, string[] | undefined>;

interface CaddyLine {
  ts?: number;
  logger?: string;
  msg?: string;
  status?: number;
  size?: number;
  duration?: number;
  request?: { remote_ip?: string; client_ip?: string; host?: string; method?: string; uri?: string; headers?: Headers };
}

/** Header lookup that ignores case, as Caddy keeps the client's spelling. */
function header(h: Headers | undefined, name: string): string {
  if (!h) return '';
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === want) return v?.[0] ?? '';
  return '';
}

const BOT =
  /bot|crawl|spider|slurp|curl|wget|python-requests|httpclient|go-http|axios|node-fetch|monitor|uptime|headless|lighthouse|preview|facebookexternalhit|whatsapp|telegram|discord/i;
const ASSET = /\.(js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|json|xml|txt|webmanifest|pdf|zip)$/i;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1$|fc|fd|fe80)/i;

export function parseAgent(ua: string): { browser: string; os: string; device: Device } {
  if (!ua || BOT.test(ua)) return { browser: 'Bot', os: 'Bot', device: 'bot' };
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /SamsungBrowser/.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS/.test(ua)
          ? 'Firefox'
          : /CriOS|Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Other';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Other';
  const device: Device =
    /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'tablet' : /Mobi|iPhone|Android/.test(ua) ? 'mobile' : 'desktop';
  return { browser, os, device };
}

function referrerHost(ref: string, host: string): string {
  if (!ref) return '';
  try {
    const h = new URL(ref).hostname.replace(/^www\./, '');
    return h === host.replace(/^www\./, '') ? '' : h;
  } catch {
    return '';
  }
}

const num = (s: string) => {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

/** Cloudflare sends some location headers percent-encoded (non-ASCII city names). */
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseLine(line: string): Hit | null {
  let j: CaddyLine;
  try {
    j = JSON.parse(line) as CaddyLine;
  } catch {
    return null;
  }
  const r = j.request;
  if (!r?.host || !r.uri || typeof j.status !== 'number') return null;
  const h = r.headers;
  const ua = header(h, 'User-Agent');
  // Homeport's own uptime checks are not visitors.
  if (ua.startsWith('Homeport-Uptime')) return null;

  const ip = header(h, 'Cf-Connecting-Ip') || r.client_ip || r.remote_ip || '';
  const cfCountry = header(h, 'Cf-Ipcountry').toUpperCase();
  const country = cfCountry && cfCountry !== 'XX' && cfCountry !== 'T1' ? cfCountry : PRIVATE_IP.test(ip) ? 'LAN' : '';
  const host = r.host.replace(/:\d+$/, '').toLowerCase();
  const path = (r.uri.split('?')[0] || '/').slice(0, 300);
  const method = r.method ?? 'GET';
  const agent = parseAgent(ua);
  const accept = header(h, 'Accept');
  const pageview =
    method === 'GET' &&
    j.status < 400 &&
    agent.device !== 'bot' &&
    !ASSET.test(path) &&
    !/^\/(api|_next\/data|socket\.io)\//.test(path) &&
    (accept.includes('text/html') || !accept);

  return {
    ts: Math.round((j.ts ?? Date.now() / 1000) * 1000),
    host,
    method,
    path,
    status: j.status,
    bytes: j.size ?? 0,
    duration: j.duration ?? 0,
    ip,
    ua,
    referrer: referrerHost(header(h, 'Referer'), host),
    country,
    city: decode(header(h, 'Cf-Ipcity')),
    region: decode(header(h, 'Cf-Region')),
    lat: num(header(h, 'Cf-Iplatitude')),
    lon: num(header(h, 'Cf-Iplongitude')),
    ...agent,
    pageview,
  };
}
