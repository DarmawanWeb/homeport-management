import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config.js';
import { activity } from '../lib/activity.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { run, tail, type RunOptions } from '../lib/exec.js';
import { portOpen } from '../lib/net.js';
import { db, settings } from '../store.js';
import * as pm2 from './pm2.js';
import type { Settings, Site } from '../../shared/types.js';

export type MetricsMode = 'per_host' | 'servers' | 'none';

const caddy = (args: string[], opts?: RunOptions) => run(settings().caddyBin, args, opts);

// ---------------------------------------------------------------- generation

export interface CaddyfileInput {
  settings: Pick<Settings, 'caddyAdmin' | 'caddyHttpPort' | 'caddyGlobalExtra' | 'caddyRawAppend'>;
  sites: Site[];
  metrics: MetricsMode;
  now?: Date;
}

/** Pure function: sites + settings → Caddyfile text. */
export function generateCaddyfile({ settings: st, sites, metrics, now = new Date() }: CaddyfileInput): string {
  const out: string[] = [];
  out.push('# ==== Dibuat otomatis oleh Homeport — jangan edit manual ====', `# ${now.toISOString()}`, '{');
  out.push(`\tadmin ${st.caddyAdmin}`, '\tauto_https off', `\thttp_port ${st.caddyHttpPort}`);
  if (metrics === 'per_host') out.push('\tmetrics {', '\t\tper_host', '\t}');
  if (metrics === 'servers') out.push('\tservers {', '\t\tmetrics', '\t}');
  for (const l of st.caddyGlobalExtra.trim().split('\n').filter(Boolean)) out.push(`\t${l}`);
  out.push('}', '');

  for (const s of sites.filter((x) => x.enabled)) {
    const label = s.notes ? s.notes.replace(/\n/g, ' ') : s.hostname;
    out.push(`# ${label}${s.pm2Name ? ` [pm2: ${s.pm2Name}]` : ''}`, `http://${s.hostname} {`);
    if (s.compress) out.push('\tencode zstd gzip');
    if (s.basicAuthUser && s.basicAuthHash) out.push('\tbasic_auth {', `\t\t${s.basicAuthUser} ${s.basicAuthHash}`, '\t}');
    for (const l of s.extra.trim().split('\n').filter(Boolean)) out.push(`\t${l}`);
    const upstream = `${s.scheme}://${s.upstreamHost}:${s.upstreamPort}`;
    if (s.scheme === 'https' && s.tlsInsecure) {
      out.push(`\treverse_proxy ${upstream} {`, '\t\ttransport http {', '\t\t\ttls_insecure_skip_verify', '\t\t}', '\t}');
    } else {
      out.push(`\treverse_proxy ${upstream}`);
    }
    out.push('}', '');
  }
  if (st.caddyRawAppend.trim()) out.push('# ---- raw append ----', st.caddyRawAppend.trim(), '');
  out.push('# fallback', `:${st.caddyHttpPort} {`, '\trespond "Homeport: host tidak dikenal" 404', '}', '');
  return out.join('\n');
}

// ---------------------------------------------------------------- metrics capability

let metricsMode: MetricsMode | null = null;
let metricsModeFor = '';

/** Caddy ≥2.9 supports `metrics { per_host }`; older versions only `servers { metrics }`. Probe once per binary. */
export async function detectMetricsMode(): Promise<MetricsMode> {
  const bin = settings().caddyBin;
  if (metricsMode && metricsModeFor === bin) return metricsMode;
  const probe = async (global: string) => {
    const file = path.join(paths.monitoring, 'caddy-probe.Caddyfile');
    await fsp.writeFile(file, `{\n\tadmin off\n${global}\n}\n:1 {\n\trespond "ok"\n}\n`);
    const r = await caddy(['validate', '--config', file, '--adapter', 'caddyfile'], { quiet: true, timeout: 20_000 });
    return r;
  };
  let mode: MetricsMode = 'none';
  const a = await probe('\tmetrics {\n\t\tper_host\n\t}');
  if (a.notFound) return 'none';
  if (a.ok) mode = 'per_host';
  else if ((await probe('\tservers {\n\t\tmetrics\n\t}')).ok) mode = 'servers';
  metricsMode = mode;
  metricsModeFor = bin;
  return mode;
}
export const cachedMetricsMode = () => metricsMode;

// ---------------------------------------------------------------- file / process ops

export async function current(): Promise<string> {
  return generateCaddyfile({ settings: settings(), sites: db.sites, metrics: await detectMetricsMode() });
}

export async function validate(content: string): Promise<{ ok: boolean; notFound: boolean; output: string }> {
  await fsp.writeFile(paths.caddyValidate, content);
  const r = await caddy(['validate', '--config', paths.caddyValidate, '--adapter', 'caddyfile'], { timeout: 30_000, quiet: true });
  const output = `${r.stdout}\n${r.stderr}`.split('\n').filter((l) => l && !l.startsWith('{"level":"info"')).slice(-6).join('\n');
  return { ok: r.ok, notFound: r.notFound, output };
}

export async function writeCaddyfile(): Promise<{ validated: boolean }> {
  const file = settings().caddyfilePath;
  const content = await current();
  const v = await validate(content);
  if (v.notFound) activity.warn('caddy tidak ditemukan — Caddyfile ditulis tanpa validasi');
  else if (!v.ok) throw badRequest(`Caddyfile tidak valid, perubahan dibatalkan:\n${v.output}`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    await fsp.copyFile(file, path.join(paths.backups, `Caddyfile.${Date.now()}`));
    await pruneBackups();
  }
  await fsp.writeFile(file, content);
  return { validated: v.ok };
}

async function pruneBackups(keep = 30): Promise<void> {
  const files = (await fsp.readdir(paths.backups)).filter((f) => f.startsWith('Caddyfile.')).sort();
  await Promise.all(files.slice(0, Math.max(0, files.length - keep)).map((f) => fsp.unlink(path.join(paths.backups, f)).catch(() => {})));
}

export function adminUp(): Promise<boolean> {
  const [h, p] = settings().caddyAdmin.split(':');
  return portOpen(h || 'localhost', Number(p || 2019), 600);
}

export async function reload(): Promise<{ reloaded: boolean; reason?: string }> {
  if (!(await adminUp())) return { reloaded: false, reason: 'Caddy belum jalan (admin API tidak merespon)' };
  const st = settings();
  const r = await caddy(['reload', '--config', st.caddyfilePath, '--adapter', 'caddyfile', '--address', st.caddyAdmin], { timeout: 30_000 });
  if (!r.ok) throw new HttpError(500, `caddy reload gagal: ${tail(r, 4)}`);
  return { reloaded: true };
}

export async function start(): Promise<string> {
  const st = settings();
  await writeCaddyfile();
  if (await adminUp()) { await reload(); return 'Caddy sudah jalan, di-reload'; }
  await pm2.startBinary(st.caddyPm2Name, st.caddyBin, ['run', '--config', st.caddyfilePath, '--adapter', 'caddyfile']);
  return 'Caddy dijalankan via pm2';
}

export async function stop(): Promise<void> {
  const st = settings();
  if (await pm2.remove(st.caddyPm2Name)) return;
  const r = await caddy(['stop', '--address', st.caddyAdmin]);
  if (!r.ok) throw new HttpError(500, `caddy stop gagal: ${tail(r)}`);
}

export async function hashPassword(plain: string): Promise<string> {
  const r = await caddy(['hash-password', '--plaintext', plain], { quiet: true });
  if (!r.ok) throw new HttpError(500, `caddy hash-password gagal: ${tail(r)}`);
  return r.stdout.trim();
}

export async function version(): Promise<string | null> {
  const r = await caddy(['version'], { quiet: true, timeout: 8000 });
  return r.ok ? r.stdout.trim().split(' ')[0] ?? null : null;
}
