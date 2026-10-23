/**
 * Deploy pipeline (one at a time per app; pushes that arrive mid-deploy coalesce into one follow-up):
 *
 *   fetch/clone → reset to target → install → build → pm2 start/reload → wait for the port
 *   on failure: optionally roll back to the last commit that deployed successfully.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../config.js';
import { activity } from '../lib/activity.js';
import { errMsg } from '../lib/errors.js';
import { events } from '../lib/events.js';
import { childEnv, run, splitCommand, step } from '../lib/exec.js';
import { portOpen, sleep } from '../lib/net.js';
import { RE_SHA } from '../lib/validators.js';
import { db, saveDb, settings } from '../store.js';
import * as pm2 from './pm2.js';
import type { App, CommitInfo, Deploy, DeployTrigger } from '../../shared/types.js';

type Log = (text: string) => void;

export const appDir = (a: Pick<App, 'name'>) => path.join(settings().appsDir, a.name);
export const ecosystemFile = (a: Pick<App, 'name'>) => path.join(paths.ecosystem, `${a.name}.config.cjs`);
export const deployLogFile = (id: string) => path.join(paths.deployLogs, `${id}.log`);

// ---------------------------------------------------------------- git

export function gitAuthArgs(a: Pick<App, 'gitToken' | 'repo'>): string[] {
  if (!a.gitToken || !a.repo.startsWith('https://')) return [];
  const origin = new URL(a.repo).origin;
  const b64 = Buffer.from(`x-access-token:${a.gitToken}`).toString('base64');
  // Passed per-invocation so the token never lands in .git/config.
  return ['-c', `http.${origin}/.extraheader=AUTHORIZATION: basic ${b64}`];
}

export const git = (a: App, args: string[], cwd = appDir(a)) =>
  run('git', [...gitAuthArgs(a), ...args], { cwd, quiet: true, timeout: 120_000 });

export async function headInfo(a: App): Promise<CommitInfo | null> {
  const r = await git(a, ['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%cI']);
  if (!r.ok) return null;
  const [sha = '', msg = '', author = '', date = ''] = r.stdout.trim().split('\x1f');
  return { sha, msg, author, date };
}

export async function remoteHead(a: App): Promise<{ sha: string | null; error?: string }> {
  const r = await run('git', [...gitAuthArgs(a), 'ls-remote', a.repo, `refs/heads/${a.branch}`], { quiet: true, timeout: 30_000 });
  if (!r.ok) return { sha: null, error: r.stderr.trim().split('\n').pop() };
  const sha = r.stdout.split(/\s/)[0] ?? '';
  return { sha: RE_SHA.test(sha) ? sha : null };
}

// ---------------------------------------------------------------- project detection

export interface Detected { pm: 'npm' | 'pnpm' | 'yarn' | 'bun'; install: string; build: string; start: string }

/** Infer install/build/start commands from package.json and the lockfile. */
export function detectProject(dir: string): Detected {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  let pkg: { scripts?: Record<string, string>; main?: string } | null = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* not a node project */ }
  const pm: Detected['pm'] = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
  const install = !pkg ? ''
    : pm === 'npm' ? (has('package-lock.json') || has('npm-shrinkwrap.json') ? 'npm ci' : 'npm install')
    : pm === 'pnpm' ? 'pnpm install --frozen-lockfile'
    : pm === 'yarn' ? 'yarn install --frozen-lockfile'
    : 'bun install';
  const build = pkg?.scripts?.build ? `${pm} run build` : '';
  const start = pkg?.scripts?.start ? `${pm} start`
    : pkg?.main ? `node ${pkg.main}`
    : has('index.js') ? 'node index.js'
    : has('server.js') ? 'node server.js' : '';
  return { pm, install, build, start };
}

/** Pure: app + start command → pm2 ecosystem file contents. */
export function generateEcosystem(a: App, dir: string, startCmd: string, pathEnv = process.env.PATH ?? ''): string {
  const parts = splitCommand(startCmd);
  if (!parts.length) throw new Error('Start command kosong');
  let [script, ...args] = parts as [string, ...string[]];
  let interpreter = 'none';
  if (script === 'node' && args[0]) { script = args.shift()!; interpreter = 'node'; }
  else if (/\.(c|m)?js$/.test(script)) interpreter = 'node';
  const app: Record<string, unknown> = {
    name: a.name, cwd: dir, script, args, interpreter,
    env: { PATH: pathEnv, NODE_ENV: 'production', ...a.env, PORT: String(a.port) },
    autorestart: true, max_restarts: 15, min_uptime: '10s', restart_delay: 3000, exp_backoff_restart_delay: 200,
    kill_timeout: 8000, time: true, merge_logs: true,
  };
  if (a.maxMemory) app.max_memory_restart = a.maxMemory;
  return `// Dibuat otomatis oleh Homeport — jangan edit manual\nmodule.exports = ${JSON.stringify({ apps: [app] }, null, 2)};\n`;
}

// ---------------------------------------------------------------- pipeline steps

async function checkout(a: App, target: string | null, log: Log): Promise<void> {
  const dir = appDir(a);
  await fsp.mkdir(settings().appsDir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    if (fs.existsSync(dir) && (await fsp.readdir(dir)).length) throw new Error(`Folder ${dir} sudah ada dan bukan repo git. Hapus/pindahkan dulu.`);
    await step(log, 'git clone', 'git', [...gitAuthArgs(a), 'clone', '--branch', a.branch, '--', a.repo, dir],
      { cwd: settings().appsDir, display: `git clone --branch ${a.branch} ${a.repo} ${dir}`, timeout: 10 * 60_000 });
  } else {
    await run('git', ['remote', 'set-url', 'origin', a.repo], { cwd: dir, quiet: true });
    await step(log, 'git fetch', 'git', [...gitAuthArgs(a), 'fetch', '--prune', 'origin', `+refs/heads/${a.branch}:refs/remotes/origin/${a.branch}`],
      { cwd: dir, display: `git fetch origin ${a.branch}`, timeout: 5 * 60_000 });
  }
  const ref = target ?? `origin/${a.branch}`;
  await step(log, 'git checkout', 'git', ['checkout', '-q', '-B', a.branch, ref], { cwd: dir });
  await step(log, 'git reset', 'git', ['reset', '--hard', ref], { cwd: dir });
}

async function startOrReload(a: App, log: Log): Promise<void> {
  const exists = !!(await pm2.find(a.name));
  const args = exists ? ['reload', ecosystemFile(a), '--update-env'] : ['start', ecosystemFile(a)];
  log(`\n▸ pm2 ${exists ? 'reload' : 'start'}\n$ pm2 ${args.join(' ')}\n`);
  const r = await pm2.pm2(args, { timeout: 90_000, quiet: true });
  pm2.invalidate();
  log(`${`${r.stdout}${r.stderr}`.split('\n').filter((l) => /\[PM2\]|rror/.test(l)).join('\n')}\n`);
  if (!r.ok) throw new Error(`pm2 gagal: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
}

async function waitHealthy(a: App, log: Log): Promise<void> {
  const deadline = Date.now() + a.healthTimeout * 1000;
  log(`\n▸ Menunggu app listen di port ${a.port} (maks ${a.healthTimeout}s)\n`);
  const baseRestarts = (await pm2.find(a.name))?.restarts ?? 0;
  await sleep(1500);
  while (Date.now() < deadline) {
    const proc = (await pm2.list(true)).list.find((p) => p.name === a.name);
    if (proc && ['errored', 'stopped'].includes(proc.status)) break;
    if (proc && proc.restarts - baseRestarts >= 3) { log('  ✖ app crash berulang kali\n'); break; }
    if (await portOpen('127.0.0.1', a.port, 700)) {
      await sleep(1500); // make sure it does not crash right after binding
      if ((await pm2.list(true)).list.find((p) => p.name === a.name)?.status === 'online') {
        log(`  ✓ port ${a.port} merespon\n`);
        return;
      }
    }
    await sleep(1000);
  }
  log(`\n--- 40 baris log terakhir app ---\n${await pm2.logs(a.name, 40)}\n`);
  throw new Error(`App tidak listen di port ${a.port}. Pastikan app memakai process.env.PORT.`);
}

async function buildAndRun(a: App, rec: Deploy, log: Log): Promise<void> {
  const dir = appDir(a);
  const d = detectProject(dir);
  const install = a.installCmd === '-' ? '' : a.installCmd || d.install;
  const build = a.buildCmd === '-' ? '' : a.buildCmd || d.build;
  const start = a.startCmd || d.start;
  rec.commands = { install, build, start };
  if (!start) throw new Error('Tidak bisa menentukan start command (tidak ada "start" di package.json). Isi manual di pengaturan app.');
  const appEnv = { ...a.env, PORT: String(a.port) };
  // devDependencies are needed to build, so NODE_ENV=production must not be set during install.
  if (install) {
    const env = childEnv(appEnv, { keepNodeEnv: false });
    delete env.NODE_ENV;
    await step(log, 'install', install, [], { cwd: dir, shell: true, env, timeout: 20 * 60_000 });
  }
  if (build) await step(log, 'build', build, [], { cwd: dir, shell: true, env: childEnv({ NODE_ENV: 'production', ...appEnv }), timeout: 30 * 60_000 });
  await fsp.writeFile(ecosystemFile(a), generateEcosystem(a, dir, start));
  await startOrReload(a, log);
  await waitHealthy(a, log);
}

// ---------------------------------------------------------------- records & queue

const deploying = new Set<string>();
export const isDeploying = (appId: string) => deploying.has(appId);

const KEEP_PER_APP = 30;

function newRecord(a: App, trigger: DeployTrigger, meta: DeployMeta): Deploy {
  const rec: Deploy = {
    id: crypto.randomUUID(), appId: a.id, app: a.name, trigger, status: 'queued',
    target: meta.commit ?? null, pushedBy: meta.pushedBy ?? null, pushMsg: meta.pushMsg ?? null,
    createdAt: new Date().toISOString(),
  };
  db.deploys.unshift(rec);
  const perApp = new Map<string, number>();
  db.deploys = db.deploys.filter((d) => {
    const n = (perApp.get(d.appId) ?? 0) + 1;
    perApp.set(d.appId, n);
    return n <= KEEP_PER_APP || d.status === 'queued' || d.status === 'running';
  });
  void pruneLogs();
  void saveDb();
  return rec;
}

async function pruneLogs(): Promise<void> {
  const keep = new Set(db.deploys.map((d) => d.id));
  for (const f of await fsp.readdir(paths.deployLogs).catch(() => [] as string[])) {
    if (!keep.has(f.replace(/\.log$/, ''))) await fsp.unlink(path.join(paths.deployLogs, f)).catch(() => {});
  }
}

export interface DeployMeta { commit?: string | null; pushedBy?: string | null; pushMsg?: string | null; isRollback?: boolean }

const queues = new Map<string, { running: boolean; pending: { rec: Deploy; meta: DeployMeta } | null }>();

export function queueDeploy(a: App, trigger: DeployTrigger, meta: DeployMeta = {}): Deploy {
  const q = queues.get(a.id) ?? { running: false, pending: null };
  queues.set(a.id, q);
  const rec = newRecord(a, trigger, meta);
  if (q.running) {
    if (q.pending) {
      q.pending.rec.status = 'skipped';
      q.pending.rec.finishedAt = new Date().toISOString();
    }
    q.pending = { rec, meta };
    void saveDb();
    return rec;
  }
  void (async () => {
    q.running = true;
    let job: { rec: Deploy; meta: DeployMeta } | null = { rec, meta };
    while (job) {
      await runDeploy(job.rec, job.meta).catch((e) => activity.error(`deploy crash: ${errMsg(e)}`));
      job = q.pending;
      q.pending = null;
    }
    q.running = false;
  })();
  return rec;
}

async function runDeploy(rec: Deploy, meta: DeployMeta): Promise<void> {
  const a = db.apps.find((x) => x.id === rec.appId);
  const out = fs.createWriteStream(deployLogFile(rec.id), { flags: 'a' });
  const log: Log = (t) => { out.write(t); };
  if (!a) {
    rec.status = 'failed'; rec.error = 'App sudah dihapus';
    out.end();
    void saveDb();
    return;
  }
  rec.status = 'running';
  rec.startedAt = new Date().toISOString();
  deploying.add(a.id);
  void saveDb();
  log(`== Deploy ${a.name} (${rec.trigger}) ${rec.startedAt}\n   repo ${a.repo} @ ${a.branch}${rec.target ? ` → ${rec.target}` : ''}\n`);
  activity.info(`Deploy ${a.name} mulai (${rec.trigger})`);
  const prevGood = a.lastGoodCommit;
  try {
    await checkout(a, rec.target, log);
    const h = await headInfo(a);
    if (h) {
      Object.assign(rec, { commit: h.sha, msg: h.msg, author: h.author });
      log(`   commit ${h.sha.slice(0, 8)} "${h.msg}" — ${h.author}\n`);
    }
    await buildAndRun(a, rec, log);
    rec.status = 'success';
    a.lastGoodCommit = rec.commit;
    a.currentCommit = h;
    if (!rec.target) a.lastRemoteSha = rec.commit;
    log('\n✓ Deploy berhasil\n');
    activity.info(`Deploy ${a.name} berhasil (${(rec.commit ?? '').slice(0, 8)})`);
  } catch (e) {
    rec.status = 'failed';
    rec.error = errMsg(e);
    // Remember the broken commit so polling does not retry it forever.
    if (!rec.target) a.lastRemoteSha = rec.commit ?? a.lastRemoteSha;
    log(`\n✖ ${rec.error}\n`);
    activity.error(`Deploy ${a.name} gagal: ${rec.error}`);
    if (a.autoRollback && prevGood && prevGood !== rec.commit && !meta.isRollback) {
      log(`\n== Auto-rollback ke ${prevGood.slice(0, 8)}\n`);
      try {
        await checkout(a, prevGood, log);
        await buildAndRun(a, rec, log);
        rec.rolledBackTo = prevGood;
        a.currentCommit = await headInfo(a);
        log('\n✓ Rollback berhasil, app kembali ke versi sebelumnya\n');
        activity.warn(`${a.name} di-rollback ke ${prevGood.slice(0, 8)}`);
      } catch (e2) {
        log(`\n✖ Rollback gagal: ${errMsg(e2)}\n`);
      }
    }
  } finally {
    rec.finishedAt = new Date().toISOString();
    rec.duration = Date.parse(rec.finishedAt) - Date.parse(rec.startedAt);
    deploying.delete(a.id);
    a.lastDeploy = { id: rec.id, status: rec.status, at: rec.finishedAt, rolledBackTo: rec.rolledBackTo ?? null };
    await saveDb();
    await new Promise<void>((r) => out.end(r));
    events.emit('deploy:finished', rec, a);
  }
}

/** Deploys left queued/running by a previous process can never finish. */
export function markInterrupted(): void {
  for (const d of db.deploys) {
    if (d.status === 'queued' || d.status === 'running') {
      d.status = 'interrupted';
      d.finishedAt = new Date().toISOString();
    }
  }
  void saveDb();
}

// ---------------------------------------------------------------- polling

const lastPoll = new Map<string, number>();
const pollErrors = new Set<string>();

export async function pollOnce(): Promise<void> {
  for (const a of db.apps) {
    if (a.autoDeploy !== 'poll' || deploying.has(a.id)) continue;
    if (Date.now() - (lastPoll.get(a.id) ?? 0) < a.pollInterval * 1000) continue;
    lastPoll.set(a.id, Date.now());
    const { sha, error } = await remoteHead(a);
    if (error) {
      if (!pollErrors.has(a.id)) activity.warn(`Polling ${a.name} gagal: ${error}`);
      pollErrors.add(a.id);
      continue;
    }
    pollErrors.delete(a.id);
    if (!sha) continue;
    if (!a.lastRemoteSha) { a.lastRemoteSha = sha; continue; }
    if (sha !== a.lastRemoteSha) {
      a.lastRemoteSha = sha;
      activity.info(`Commit baru di ${a.name}/${a.branch} (${sha.slice(0, 8)}), deploy…`);
      queueDeploy(a, 'poll');
    }
  }
}

export async function readLog(id: string, offset: number): Promise<{ text: string; offset: number }> {
  try {
    const fh = await fsp.open(deployLogFile(id), 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size - offset, 2_000_000);
      if (len <= 0) return { text: '', offset };
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      return { text: buf.toString('utf8'), offset: offset + len };
    } finally {
      await fh.close();
    }
  } catch {
    return { text: '', offset };
  }
}
