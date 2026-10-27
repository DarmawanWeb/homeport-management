import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { App, AppsDTO, AppView, Deploy, PublicApp } from '../../shared/types.js';
import { RESERVED_PORTS } from '../config.js';
import { activity } from '../lib/activity.js';
import { badRequest, errMsg, notFound, parse } from '../lib/errors.js';
import { run } from '../lib/exec.js';
import { portOpen } from '../lib/net.js';
import { expectRestart } from '../lib/restarts.js';
import { envMap, port, RE_APPNAME, RE_BRANCH, RE_REPO, RE_SHA } from '../lib/validators.js';
import { db, saveDb, settings } from '../store.js';
import { appDir, detectProject, ecosystemFile, generateEcosystem, git, isDeploying, queueDeploy } from './deploy.js';
import * as pm2 from './pm2.js';
import { createSite, type MutationResult, maybeApply, sitesForApp } from './sites.js';

const MASK = '••••';

const appInput = z.object({
  name: z.string().trim().toLowerCase().regex(RE_APPNAME, 'App names use lowercase letters, digits, dashes, dots or underscores (max 40)'),
  repo: z.string().trim().regex(RE_REPO, 'Repository must be an https:// or git@host:user/repo.git URL'),
  branch: z
    .string()
    .trim()
    .default('main')
    .refine((v) => RE_BRANCH.test(v), 'Invalid branch name'),
  port,
  installCmd: z.string().trim().default(''),
  buildCmd: z.string().trim().default(''),
  startCmd: z.string().trim().default(''),
  workspace: z
    .string()
    .trim()
    .default('')
    .refine(
      (v) => v === '' || (/^(@[a-z0-9._-]+\/)?[a-zA-Z0-9._/-]+$/.test(v) && !v.includes('..')),
      'Use a package name like @scope/web or a folder like apps/web',
    ),
  submodules: z.enum(['pinned', 'latest']).default('pinned'),
  env: envMap,
  autoDeploy: z.enum(['webhook', 'poll', 'off']).default('webhook'),
  pollInterval: z.coerce.number().int().min(30, 'The check interval is at least 30 seconds').default(60),
  autoRollback: z.boolean().default(true),
  healthTimeout: z.coerce.number().int().min(5).max(300).default(40),
  maxMemory: z
    .string()
    .trim()
    .default('')
    .refine((v) => v === '' || /^\d+[MG]$/i.test(v), 'Memory limit looks like 512M or 1G'),
  gitToken: z.string().trim().default(''),
  notes: z.string().max(300).default(''),
});

const createExtras = z.object({
  hostname: z.string().trim().toLowerCase().default(''),
  tunnel: z.string().trim().default(''),
  routeDns: z.boolean().default(true),
  overwriteDns: z.boolean().default(false),
  deployNow: z.boolean().default(true),
});

export function findApp(id: string): App {
  const a = db.apps.find((x) => x.id === id);
  if (!a) throw notFound('App not found');
  return a;
}

export function nextFreePort(): number {
  const st = settings();
  const used = new Set([...db.apps.map((a) => a.port), ...db.sites.map((s) => s.upstreamPort), ...RESERVED_PORTS(st)]);
  let p = st.portRangeStart || 3001;
  while (used.has(p)) p++;
  return p;
}

export function toPublic(a: App): PublicApp {
  const { webhookSecret: _secret, ...rest } = a;
  const domain = settings().webhookDomain;
  return {
    ...rest,
    dir: appDir(a),
    gitTokenSet: !!a.gitToken,
    gitToken: a.gitToken ? MASK + a.gitToken.slice(-4) : '',
    webhookUrl: domain ? `https://${domain}/hooks/${a.id}` : null,
  };
}

function validate(input: Record<string, unknown>, cur?: App): z.infer<typeof appInput> {
  const v = parse(appInput, input);
  const st = settings();
  if (db.apps.some((x) => x.name === v.name && x.id !== cur?.id)) throw badRequest('Another app already uses this name');
  if (v.name === 'homeport' || v.name === st.caddyPm2Name || v.name.startsWith(st.tunnelPm2Prefix) || v.name.startsWith('hp-')) {
    throw badRequest('That name is reserved for Homeport');
  }
  if (db.apps.some((x) => x.port === v.port && x.id !== cur?.id)) throw badRequest(`Port ${v.port} is already used by another app`);
  if (RESERVED_PORTS(st).includes(v.port)) throw badRequest(`Port ${v.port} is reserved for Homeport or monitoring`);
  // A masked token from the UI means "unchanged".
  if (v.gitToken.startsWith(MASK)) v.gitToken = cur?.gitToken ?? '';
  return v;
}

export async function listApps(): Promise<AppsDTO> {
  const procs = (await pm2.list()).list;
  const apps: AppView[] = await Promise.all(
    db.apps.map(async (a) => {
      const p = procs.find((x) => x.name === a.name);
      return {
        ...toPublic(a),
        deploying: isDeploying(a.id),
        pm2: p ? { status: p.status, cpu: p.cpu, mem: p.mem, uptime: p.uptime, restarts: p.restarts } : null,
        up: await portOpen('127.0.0.1', a.port, 500),
        domains: sitesForApp(a.name, a.port).map((s) => s.hostname),
        recentDeploys: db.deploys
          .filter((d) => d.appId === a.id && d.status !== 'skipped')
          .slice(0, 20)
          .map(({ id, status, createdAt, commit, msg, trigger, rolledBackTo }) => ({
            id,
            status,
            createdAt,
            commit,
            msg,
            trigger,
            rolledBackTo,
          })),
      };
    }),
  );
  const st = settings();
  return { apps, nextPort: nextFreePort(), webhookDomain: st.webhookDomain, webhookPort: st.webhookPort };
}

export async function createApp(
  body: Record<string, unknown>,
): Promise<{ app: PublicApp; deploy?: Deploy; site?: MutationResult; warning?: string }> {
  const v = validate({ port: nextFreePort(), ...body });
  const extras = parse(createExtras, body);
  const a: App = {
    ...v,
    id: crypto.randomUUID(),
    webhookSecret: crypto.randomBytes(24).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  const dir = appDir(a);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const r = await run('git', ['remote', 'get-url', 'origin'], { cwd: dir, quiet: true });
    if (r.ok && r.stdout.trim() && r.stdout.trim() !== a.repo)
      throw badRequest(`${dir} already holds a different repository (${r.stdout.trim()})`);
  }
  db.apps.push(a);
  await saveDb();
  activity.info(`App created: ${a.name} (${a.repo})`);
  const out: { app: PublicApp; deploy?: Deploy; site?: MutationResult; warning?: string } = { app: toPublic(a) };
  if (extras.hostname) {
    try {
      out.site = await createSite({
        hostname: extras.hostname,
        upstreamPort: a.port,
        tunnel: extras.tunnel || settings().defaultTunnel,
        pm2Name: a.name,
        routeDns: extras.routeDns,
        overwriteDns: extras.overwriteDns,
        notes: a.name,
      });
    } catch (e) {
      out.warning = `The domain could not be created: ${errMsg(e)}`;
    }
  }
  if (extras.deployNow) out.deploy = queueDeploy(a, 'manual');
  return out;
}

export async function updateApp(
  id: string,
  body: Record<string, unknown>,
): Promise<{ app: PublicApp; deploy?: Deploy; restarted?: boolean; warning?: string }> {
  const a = findApp(id);
  const v = validate({ ...a, ...body, env: body.env ?? a.env }, a);
  if (v.name !== a.name) throw badRequest('An app cannot be renamed. Delete it and create a new one.');
  const oldPort = a.port;
  const restartNeeded =
    v.port !== a.port || JSON.stringify(v.env) !== JSON.stringify(a.env) || v.startCmd !== a.startCmd || v.maxMemory !== a.maxMemory;
  const repoChanged = v.repo !== a.repo || v.branch !== a.branch;
  const linked = sitesForApp(a.name, oldPort);
  Object.assign(a, v, { updatedAt: new Date().toISOString() });
  if (repoChanged) a.lastRemoteSha = null;
  if (oldPort !== a.port) for (const s of linked) s.upstreamPort = a.port;
  await saveDb();

  const out: { app: PublicApp; deploy?: Deploy; restarted?: boolean; warning?: string } = { app: toPublic(a) };
  if (oldPort !== a.port) {
    try {
      await maybeApply();
    } catch (e) {
      out.warning = errMsg(e);
    }
  }
  if (body.redeploy === true || repoChanged) {
    out.deploy = queueDeploy(a, 'manual');
  } else if (restartNeeded && fs.existsSync(ecosystemFile(a))) {
    try {
      const start = a.startCmd || detectProject(appDir(a)).start;
      await fsp.writeFile(ecosystemFile(a), generateEcosystem(a, appDir(a), start));
      expectRestart(a.name);
      const r = await pm2.pm2(['reload', ecosystemFile(a), '--update-env'], { timeout: 60_000 });
      pm2.invalidate();
      out.restarted = r.ok;
    } catch (e) {
      out.warning = errMsg(e);
    }
  }
  return out;
}

export async function deleteApp(id: string, opts: { files: boolean; sites: boolean }): Promise<{ steps: string[] }> {
  const a = findApp(id);
  if (isDeploying(a.id)) throw badRequest('A deploy is running. Wait for it to finish.');
  const steps: string[] = [];
  if (await pm2.remove(a.name)) steps.push('pm2 process removed');
  await fsp.unlink(ecosystemFile(a)).catch(() => {});
  if (opts.files) {
    const dir = appDir(a);
    // Only ever delete inside the apps folder.
    if (dir.startsWith(path.resolve(settings().appsDir) + path.sep)) {
      await fsp.rm(dir, { recursive: true, force: true });
      steps.push(`Deleted ${dir}`);
    }
  }
  if (opts.sites) {
    const linked = new Set(sitesForApp(a.name, a.port).map((s) => s.id));
    db.sites = db.sites.filter((s) => !linked.has(s.id));
    if (linked.size) steps.push(`Removed ${linked.size} domain(s)`);
  }
  db.apps = db.apps.filter((x) => x.id !== a.id);
  await saveDb();
  try {
    await maybeApply();
  } catch (e) {
    steps.push(`⚠ ${errMsg(e)}`);
  }
  activity.info(`App deleted: ${a.name}`);
  return { steps };
}

export function deployApp(id: string, commit?: string): Deploy {
  const a = findApp(id);
  if (commit && !RE_SHA.test(commit)) throw badRequest('Invalid commit');
  return queueDeploy(a, commit ? 'rollback' : 'manual', { commit: commit ?? null, isRollback: !!commit });
}

export async function appAction(id: string, action: 'restart' | 'stop' | 'start'): Promise<void> {
  const a = findApp(id);
  expectRestart(a.name);
  const exists = !!(await pm2.find(a.name));
  if (action === 'start' && !exists) {
    if (!fs.existsSync(ecosystemFile(a))) throw badRequest('This app has never been deployed');
    pm2.must(await pm2.pm2(['start', ecosystemFile(a)]), 'pm2 start');
    pm2.invalidate();
  } else {
    await pm2.action(a.name, action);
  }
}

export async function commits(id: string) {
  const a = findApp(id);
  if (!fs.existsSync(path.join(appDir(a), '.git'))) return { current: null, commits: [] };
  const r = await git(a, ['log', `origin/${a.branch}`, '-25', '--format=%H%x1f%s%x1f%an%x1f%cI']);
  const succeeded = new Set(db.deploys.filter((d) => d.appId === a.id && d.status === 'success').map((d) => d.commit));
  return {
    current: a.currentCommit?.sha ?? null,
    commits: r.ok
      ? r.stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [sha = '', msg = '', author = '', date = ''] = l.split('\x1f');
            return { sha, msg, author, date, deployedOk: succeeded.has(sha) };
          })
      : [],
  };
}

export async function regenerateSecret(id: string): Promise<string> {
  const a = findApp(id);
  a.webhookSecret = crypto.randomBytes(24).toString('hex');
  await saveDb();
  return a.webhookSecret;
}
