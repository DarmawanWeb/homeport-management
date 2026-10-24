import { execFile, spawn } from 'node:child_process';
import { IS_WIN } from '../config.js';
import { activity } from './activity.js';

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  cmd: string;
  notFound: boolean;
}

export interface RunOptions {
  timeout?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** Do not write to the activity log (for frequent status probes). */
  quiet?: boolean;
}

/** Variables that belong to Homeport itself and must not leak into managed processes. */
const PRIVATE_ENV = ['PORT', 'HOST', 'TM_PASSWORD', 'TM_DATA_DIR'];

/**
 * When Homeport itself runs under pm2, pm2 injects its process metadata as environment variables.
 * They must never reach child processes: some pm2 versions read `name` from the environment, so
 * `pm2 start caddy --name hp-caddy` would silently create a process called "homeport", and
 * NODE_CHANNEL_FD would make child Node processes think they have an IPC channel.
 */
const PM2_INJECTED = new Set([
  'name',
  'namespace',
  'status',
  'instances',
  'exec_mode',
  'exec_interpreter',
  'autorestart',
  'autostart',
  'automation',
  'treekill',
  'vizion',
  'vizion_running',
  'km_link',
  'merge_logs',
  'instance_var',
  'kill_retry_time',
  'windowsHide',
  'username',
  'unique_id',
  'created_at',
  'restart_time',
  'unstable_restarts',
  'pmx',
  'NODE_APP_INSTANCE',
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
  'PM2_USAGE',
  'PM2_JSON_PROCESSING',
  'PM2_INTERACTOR_PROCESSING',
  'PM2_PROGRAMMATIC',
]);

export function childEnv(extra: Record<string, string | undefined> = {}, opts: { keepNodeEnv?: boolean } = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const ownName = process.env.pm_id !== undefined ? process.env.name : undefined;
  for (const k of PRIVATE_ENV) delete env[k];
  for (const k of Object.keys(env)) {
    // PM2_HOME is kept on purpose: it tells the pm2 CLI which daemon to talk to.
    if (PM2_INJECTED.has(k) || k.startsWith('pm_') || k === ownName) delete env[k];
  }
  if (opts.keepNodeEnv === false) delete env.NODE_ENV;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
  return { ...env, ...extra };
}

const quoteWin = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

/** Run a binary with an argument list (no shell) and collect output. Never throws. */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const useShell = IS_WIN && /\.(cmd|bat)$/i.test(bin);
    const cmd = [bin, ...args].join(' ');
    execFile(
      useShell ? quoteWin(bin) : bin,
      useShell ? args.map(quoteWin) : args,
      {
        timeout: opts.timeout ?? 60_000,
        shell: useShell,
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024,
        env: childEnv(opts.env),
        cwd: opts.cwd,
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
        const r: RunResult = {
          ok: !e,
          code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          cmd,
          notFound: e?.code === 'ENOENT',
        };
        if (!opts.quiet) {
          const out = `${r.stdout}\n${r.stderr}`.trim() || e?.message;
          if (r.ok) activity.info(`$ ${cmd} → OK`, out);
          else activity.error(`$ ${cmd} → failed (${r.code})`, out);
        }
        resolve(r);
      },
    );
  });
}

export const tail = (r: RunResult, lines = 6) => (r.stderr || r.stdout).trim().split('\n').slice(-lines).join('\n');

export interface StepOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  timeout?: number;
  /** What to print instead of the real command (e.g. to hide credentials). */
  display?: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences is the point
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Remove terminal colour codes so logs read cleanly in the browser. */
export const stripAnsi = (t: string) => t.replace(ANSI, '');

const redact = (t: string) =>
  stripAnsi(t)
    .replace(/AUTHORIZATION: basic [A-Za-z0-9+/=]+/gi, 'AUTHORIZATION: basic ***')
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');

/**
 * Run a command and stream its output to `log`. Rejects on non-zero exit.
 * The child gets its own process group so a timeout kills the whole tree (npm → node → …).
 */
export function step(log: (t: string) => void, label: string, cmd: string, args: string[], opts: StepOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`\n▸ ${label}\n$ ${opts.display ?? [cmd, ...args].join(' ')}\n`);
    const t0 = Date.now();
    const timeout = opts.timeout ?? 20 * 60_000;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? childEnv(),
      shell: !!opts.shell,
      windowsHide: true,
      detached: !IS_WIN,
    });
    const timer = setTimeout(() => {
      log(`\n✖ timed out after ${Math.round(timeout / 1000)}s, stopped\n`);
      try {
        if (IS_WIN || !child.pid) child.kill();
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeout);
    child.stdout.on('data', (d: Buffer) => log(redact(d.toString())));
    child.stderr.on('data', (d: Buffer) => log(redact(d.toString())));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${e.code === 'ENOENT' ? `command not found (${cmd})` : e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s, exit ${code})\n`);
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (exit ${code})`));
    });
  });
}

/** Split a command line into argv, honouring simple quotes. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let quoted = false;
  for (const c of cmd) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      quoted = true;
    } else if (/\s/.test(c)) {
      if (cur || quoted) {
        out.push(cur);
        cur = '';
        quoted = false;
      }
    } else cur += c;
  }
  if (cur || quoted) out.push(cur);
  return out;
}
