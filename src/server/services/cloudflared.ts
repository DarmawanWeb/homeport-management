import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { paths } from '../config.js';
import { activity } from '../lib/activity.js';
import { HttpError, badRequest, errMsg, notFound } from '../lib/errors.js';
import { run, tail, type RunOptions } from '../lib/exec.js';
import { db, saveDb, settings } from '../store.js';
import * as pm2 from './pm2.js';
import { deleteTunnelCname } from './cloudflareApi.js';

export interface Tunnel { id: string; name: string; created: string; connections: number }

const cfEnv = () => ({ TUNNEL_ORIGIN_CERT: path.join(settings().cloudflaredDir, 'cert.pem') });
const cloudflared = (args: string[], opts: RunOptions = {}) =>
  run(settings().cloudflaredBin, args, { ...opts, env: { ...cfEnv(), ...opts.env } });

export const pm2Name = (tunnel: string) => settings().tunnelPm2Prefix + tunnel;
export const configPath = (tunnel: string) => path.join(paths.tunnels, `${tunnel}.yml`);
const credentialsPath = (id: string) => path.join(settings().cloudflaredDir, `${id}.json`);
export const loggedIn = () => fs.existsSync(path.join(settings().cloudflaredDir, 'cert.pem'));

// ---------------------------------------------------------------- listing

let cache: { at: number; list: Tunnel[] } = { at: 0, list: [] };
export const invalidate = () => { cache.at = 0; };

export async function list(force = false): Promise<Tunnel[]> {
  if (!force && Date.now() - cache.at < 15_000) return cache.list;
  const r = await cloudflared(['tunnel', 'list', '--output', 'json'], { timeout: 30_000, quiet: true });
  if (r.notFound) throw new HttpError(500, 'cloudflared tidak ditemukan. Cek Settings.');
  if (!r.ok) throw new HttpError(500, `cloudflared tunnel list gagal: ${tail(r, 4)}`);
  let raw: { id: string; name: string; created_at: string; connections?: unknown[] }[];
  try { raw = JSON.parse(r.stdout || '[]') ?? []; } catch { throw new HttpError(500, 'Output cloudflared tidak bisa di-parse'); }
  cache = {
    at: Date.now(),
    list: raw.map((t) => ({ id: t.id, name: t.name, created: t.created_at, connections: t.connections?.length ?? 0 })),
  };
  return cache.list;
}

async function get(name: string): Promise<Tunnel> {
  const t = (await list()).find((x) => x.name === name);
  if (!t) throw notFound(`Tunnel ${name} tidak ditemukan`);
  return t;
}

// ---------------------------------------------------------------- config generation

/** Pure: tunnel + sites → cloudflared ingress YAML. Everything goes to Caddy, which routes by Host. */
export function generateIngress(t: { id: string; name: string }, hostnames: string[], caddyPort: number, credentialsFile: string): string {
  const lines = [
    '# Dibuat otomatis oleh Homeport',
    `tunnel: ${t.id}`,
    `credentials-file: ${JSON.stringify(credentialsFile)}`,
    'ingress:',
  ];
  for (const h of hostnames) lines.push(`  - hostname: ${JSON.stringify(h)}`, `    service: http://localhost:${caddyPort}`);
  lines.push('  - service: http_status:404', '');
  return lines.join('\n');
}

function ingressFor(t: Tunnel): string {
  const hosts = db.sites.filter((s) => s.enabled && s.tunnel === t.name).map((s) => s.hostname);
  return generateIngress(t, hosts, settings().caddyHttpPort, credentialsPath(t.id));
}

/** Each tunnel gets a stable local metrics port for Prometheus. */
export function metricsPort(name: string): number {
  const st = settings();
  const existing = st.tunnelMetricsPorts[name];
  if (existing) return existing;
  const used = new Set(Object.values(st.tunnelMetricsPorts));
  let p = 20241;
  while (used.has(p)) p++;
  st.tunnelMetricsPorts[name] = p;
  void saveDb();
  return p;
}

/**
 * Rewrite ingress files for every tunnel referenced by a site (plus `extra`),
 * restarting running tunnels whose config changed — cloudflared does not hot-reload.
 */
export async function syncConfigs(extra: string[] = []): Promise<{ name: string; changed?: boolean; restarted?: boolean; error?: string }[]> {
  const names = [...new Set([...db.sites.filter((s) => s.tunnel).map((s) => s.tunnel), ...extra])];
  if (!names.length) return [];
  let tunnels: Tunnel[];
  try { tunnels = await list(); } catch (e) { activity.warn(`Tidak bisa list tunnel: ${errMsg(e)}`); return []; }
  const results = [];
  for (const name of names) {
    const t = tunnels.find((x) => x.name === name);
    if (!t) { results.push({ name, error: 'tunnel tidak ditemukan di Cloudflare' }); continue; }
    const file = configPath(name);
    const content = ingressFor(t);
    const old = fs.existsSync(file) ? await fsp.readFile(file, 'utf8') : '';
    const changed = old !== content;
    if (changed) await fsp.writeFile(file, content);
    let restarted = false;
    if (changed && (await pm2.find(pm2Name(name)))?.status === 'online') {
      await pm2.action(pm2Name(name), 'restart');
      restarted = true;
    }
    results.push({ name, changed, restarted });
  }
  return results;
}

// ---------------------------------------------------------------- lifecycle

export async function create(name: string): Promise<Tunnel | undefined> {
  const r = await cloudflared(['tunnel', 'create', name], { timeout: 60_000 });
  if (!r.ok) throw new HttpError(500, `tunnel create gagal: ${tail(r)}`);
  invalidate();
  const t = (await list(true)).find((x) => x.name === name);
  if (t) await fsp.writeFile(configPath(name), ingressFor(t));
  if (!settings().defaultTunnel) { settings().defaultTunnel = name; await saveDb(); }
  return t;
}

export async function start(name: string): Promise<void> {
  const t = await get(name);
  if (!fs.existsSync(credentialsPath(t.id))) {
    throw badRequest(`File kredensial ${credentialsPath(t.id)} tidak ada. Tunnel ini dibuat di mesin lain? Buat tunnel baru di Mac ini.`);
  }
  await fsp.writeFile(configPath(name), ingressFor(t));
  // Delete + start (not restart) so a changed metrics port or binary path is picked up.
  await pm2.remove(pm2Name(name));
  await pm2.startBinary(pm2Name(name), settings().cloudflaredBin, [
    'tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${metricsPort(name)}`, '--config', configPath(name), 'run',
  ]);
}

export async function stop(name: string): Promise<void> {
  await pm2.remove(pm2Name(name));
}

export async function remove(name: string, deleteDns: boolean): Promise<string[]> {
  const steps: string[] = [];
  const affected = db.sites.filter((s) => s.tunnel === name);
  if (deleteDns) {
    for (const s of affected) {
      try { await deleteTunnelCname(s.hostname); steps.push(`DNS ${s.hostname} dihapus`); }
      catch (e) { steps.push(`DNS ${s.hostname}: ${errMsg(e)}`); }
    }
  }
  await pm2.remove(pm2Name(name));
  const r = await cloudflared(['tunnel', 'delete', '-f', name], { timeout: 60_000 });
  if (!r.ok) throw new HttpError(500, `tunnel delete gagal: ${tail(r)}`);
  for (const s of affected) s.tunnel = '';
  const st = settings();
  if (st.defaultTunnel === name) st.defaultTunnel = '';
  delete st.tunnelMetricsPorts[name];
  await saveDb();
  await fsp.unlink(configPath(name)).catch(() => {});
  invalidate();
  steps.push(`Tunnel ${name} dihapus, ${affected.length} domain dilepas dari tunnel`);
  return steps;
}

export async function cleanup(name: string): Promise<void> {
  const r = await cloudflared(['tunnel', 'cleanup', name]);
  if (!r.ok) throw new HttpError(500, `tunnel cleanup gagal: ${tail(r)}`);
}

export async function routeDns(tunnel: string, hostname: string, overwrite: boolean): Promise<void> {
  const args = ['tunnel', 'route', 'dns', ...(overwrite ? ['--overwrite-dns'] : []), tunnel, hostname];
  const r = await cloudflared(args, { timeout: 45_000 });
  if (!r.ok) throw new HttpError(500, `route dns gagal: ${tail(r)}`);
}

export async function ingressText(name: string): Promise<{ text: string; file: string }> {
  return { text: ingressFor(await get(name)), file: configPath(name) };
}

export const hasCredentials = (id: string) => fs.existsSync(credentialsPath(id));

export async function version(): Promise<string | null> {
  const r = await cloudflared(['--version'], { quiet: true, timeout: 8000 });
  return r.ok ? (r.stdout || r.stderr).trim().split('\n')[0] ?? null : null;
}

// ---------------------------------------------------------------- login

let loginProc: ChildProcess | null = null;

/** Start `cloudflared tunnel login` and return the authorization URL it prints. */
export function login(): Promise<{ url?: string; already?: boolean; error?: string; output?: string }> {
  if (loggedIn()) return Promise.resolve({ already: true });
  loginProc?.kill();
  return new Promise((resolve) => {
    let buf = '';
    const proc = spawn(settings().cloudflaredBin, ['tunnel', 'login'], { windowsHide: true });
    loginProc = proc;
    const timer = setTimeout(() => finish({ error: 'URL login tidak muncul', output: buf.slice(-1000) }), 15_000);
    const finish = (v: { url?: string; error?: string; output?: string }) => { clearTimeout(timer); resolve(v); };
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/https:\/\/dash\.cloudflare\.com\/argotunnel\S+/);
      if (m) finish({ url: m[0] });
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e: NodeJS.ErrnoException) => finish({ error: e.code === 'ENOENT' ? 'cloudflared tidak ditemukan' : e.message }));
    proc.on('exit', () => { loginProc = null; activity.info('cloudflared login selesai'); });
  });
}
