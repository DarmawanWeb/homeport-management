export const fmtBytes = (b: number | null | undefined): string => {
  if (b == null || !Number.isFinite(b)) return '—';
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(0)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${Math.round(b)} B`;
};

export const fmtDuration = (ms: number | null | undefined): string => {
  if (ms == null) return '';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const s = Math.round((ms % 60_000) / 1000);
    return `${Math.floor(ms / 60_000)}m${s ? ` ${s}s` : ''}`;
  }
  if (ms < 86_400_000) {
    const m = Math.round((ms % 3_600_000) / 60_000);
    return `${Math.floor(ms / 3_600_000)}h${m ? ` ${m}m` : ''}`;
  }
  const h = Math.round((ms % 86_400_000) / 3_600_000);
  return `${Math.floor(ms / 86_400_000)}d${h ? ` ${h}h` : ''}`;
};

export const fmtUptime = (sec: number): string => {
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} h`;
  const d = Math.round(sec / 86_400);
  return `${d} day${d === 1 ? '' : 's'}`;
};

export const ago = (t: string | number | null | undefined): string => {
  if (!t) return 'never';
  const s = (Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};

export const repoShort = (repo: string): string =>
  repo
    .replace(/^https:\/\/(www\.)?github\.com\//, '')
    .replace(/^git@github\.com:/, '')
    .replace(/^file:\/\/.*\//, '')
    .replace(/\.git$/, '');

export const shortSha = (sha?: string | null) => (sha ?? '').slice(0, 7);

export const fmtPct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;
export const fmtRate = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(2));
export const fmtSeconds = (v: number) => (v >= 1 ? `${v.toFixed(1)}s` : `${(v * 1000).toFixed(0)}ms`);

/** 1234 → 1.2k, 1_500_000 → 1.5M */
export const fmtCount = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n));

export const fmtBytesRate = (b: number) => `${fmtBytes(b)}/s`;

/** Change against the previous period, or null when there is nothing to compare with. */
export const delta = (now: number, before: number): number | null => (before > 0 ? (now - before) / before : null);

/** ISO 3166 alpha-2 → flag emoji. 'LAN' and unknown codes get a neutral marker. */
export const flag = (code: string): string =>
  /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : code === 'LAN' ? '🏠' : '🏳️';

let regionNames: Intl.DisplayNames | null = null;
export const countryName = (code: string): string => {
  if (code === 'LAN') return 'Local network';
  if (!code) return 'Unknown';
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
};

export const dayLabel = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
