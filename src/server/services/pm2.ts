import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Pm2Proc } from '../../shared/types.js';
import { HttpError } from '../lib/errors.js';
import { type RunOptions, type RunResult, run, stripAnsi, tail } from '../lib/exec.js';
import { settings } from '../store.js';

const MUTATING = new Set(['start', 'stop', 'restart', 'reload', 'delete', 'startOrReload', 'startOrRestart']);
let saveTimer: NodeJS.Timeout | null = null;

/**
 * Keep pm2's dump in step with what Homeport started or stopped, so `pm2 resurrect` after a reboot
 * (launchd, systemd, DSM Task Scheduler or the Docker entrypoint) brings back exactly this state.
 */
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void run(settings().pm2Bin, ['save', '--force'], { quiet: true, timeout: 20_000 });
  }, 3000);
  saveTimer.unref();
}

export async function pm2(args: string[], opts?: RunOptions): Promise<RunResult> {
  const r = await run(settings().pm2Bin, args, opts);
  if (r.ok && MUTATING.has(args[0] ?? '')) scheduleSave();
  return r;
}

/** Throw a readable error if a pm2 call failed. */
export function must(r: RunResult, what: string): RunResult {
  if (r.notFound) throw new HttpError(500, `${what}: ${r.cmd.split(' ')[0]} was not found. Check the path in Settings.`);
  if (!r.ok) throw new HttpError(500, `${what} failed: ${tail(r)}`);
  return r;
}

interface RawProc {
  name: string;
  pm_id: number;
  monit?: { cpu?: number; memory?: number };
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
    PORT?: string;
    env?: Record<string, string>;
    pm_out_log_path?: string;
    pm_err_log_path?: string;
    pm_log_path?: string;
  };
}

let cache: { at: number; value: { list: Pm2Proc[]; error: string | null } } | null = null;

/** List pm2 processes. Cached for 2s because many endpoints ask at once. */
/**
 * `pm2 jlist` can print notices before the JSON: "[PM2][WARN] …", or ">>>> In-memory PM2 is
 * out-of-date" when the CLI and the daemon versions differ. The JSON is the line that starts with
 * `[{` or `[]`. Exported for tests.
 */
export function jsonPart(stdout: string): string {
  const m = /^\[(\{|\s*\])/m.exec(stdout);
  return m ? stdout.slice(m.index) : stdout;
}

export async function list(fresh = false): Promise<{ list: Pm2Proc[]; error: string | null }> {
  if (!fresh && cache && Date.now() - cache.at < 2000) return cache.value;
  const r = await pm2(['jlist'], { timeout: 20_000, quiet: true });
  let value: { list: Pm2Proc[]; error: string | null };
  if (!r.ok) {
    value = { list: [], error: r.notFound ? 'pm2 was not found' : (r.stderr || 'pm2 jlist failed').trim() };
  } else {
    try {
      const raw = JSON.parse(jsonPart(r.stdout)) as RawProc[];
      value = {
        error: null,
        list: raw.map((p) => {
          const port = p.pm2_env?.env?.PORT ?? p.pm2_env?.PORT;
          return {
            name: p.name,
            id: p.pm_id,
            status: p.pm2_env?.status ?? 'unknown',
            cpu: p.monit?.cpu ?? 0,
            mem: p.monit?.memory ?? 0,
            uptime: p.pm2_env?.pm_uptime ?? null,
            restarts: p.pm2_env?.restart_time ?? 0,
            port: port ? Number(port) : null,
          };
        }),
      };
    } catch {
      const first = r.stdout.trim().split('\n')[0]?.slice(0, 120) ?? '';
      value = { list: [], error: `could not parse pm2 output${first ? `: ${first}` : ''}` };
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

export const invalidate = () => {
  cache = null;
};

export async function find(name: string): Promise<Pm2Proc | undefined> {
  return (await list()).list.find((p) => p.name === name);
}

/** Start a binary under pm2 (or restart it if it already exists). */
export async function startBinary(name: string, bin: string, args: string[]): Promise<void> {
  invalidate();
  if (await find(name)) {
    must(await pm2(['restart', name, '--update-env']), `pm2 restart ${name}`);
  } else {
    must(await pm2(['start', bin, '--name', name, '--interpreter', 'none', '--time', '--', ...args]), `pm2 start ${name}`);
  }
  invalidate();
}

/** Log files pm2 writes for a process, from `pm2 jlist`. */
export async function logFiles(name: string): Promise<string[]> {
  const r = await pm2(['jlist'], { timeout: 20_000, quiet: true });
  if (!r.ok) return [];
  try {
    const env = (JSON.parse(jsonPart(r.stdout)) as RawProc[]).find((p) => p.name === name)?.pm2_env;
    return [env?.pm_out_log_path, env?.pm_err_log_path, env?.pm_log_path].filter(
      (f): f is string => typeof f === 'string' && path.isAbsolute(f) && !f.startsWith('/dev/'),
    );
  } catch {
    return [];
  }
}

/** Delete a log file and the copies pm2-logrotate made of it (name-out__2026-10-28_00-00-00.log). */
async function removeLogFile(file: string): Promise<void> {
  const dir = path.dirname(file);
  const stem = path.basename(file).replace(/\.log$/, '');
  const rotated = (await fsp.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(`${stem}__`));
  for (const f of [file, ...rotated.map((r) => path.join(dir, r))]) await fsp.rm(f, { force: true }).catch(() => {});
}

/** Delete a pm2 process. With `logs`, its log files go too, so nothing of it is left behind. */
export async function remove(name: string, opts: { logs?: boolean } = {}): Promise<boolean> {
  invalidate();
  if (!(await find(name))) return false;
  const files = opts.logs ? await logFiles(name) : [];
  must(await pm2(['delete', name]), `pm2 delete ${name}`);
  invalidate();
  for (const f of files) await removeLogFile(f);
  return true;
}

export async function action(name: string, act: 'restart' | 'stop' | 'start' | 'reload'): Promise<void> {
  must(await pm2([act, name]), `pm2 ${act}`);
  invalidate();
}

export async function logs(name: string, lines = 150): Promise<string> {
  const r = await pm2(['logs', name, '--lines', String(lines), '--nostream', '--raw'], { quiet: true, timeout: 15_000 });
  return stripAnsi(`${r.stdout}\n${r.stderr}`).trim();
}

export async function version(): Promise<string | null> {
  const r = await pm2(['--version'], { quiet: true, timeout: 15_000 });
  return r.ok ? (r.stdout.trim().split('\n').pop() ?? null) : null;
}
