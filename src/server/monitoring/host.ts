import fs from 'node:fs';
import os from 'node:os';
import { IS_MAC } from '../config.js';
import { run } from '../lib/exec.js';
import { settings } from '../store.js';

export interface HostMemory { total: number; available: number; used: number }

/**
 * Memory that is actually available to programs. `os.freemem()` is misleading on macOS
 * (cached/inactive pages count as used), so read vm_stat there and MemAvailable on Linux.
 */
export async function hostMemory(): Promise<HostMemory> {
  const total = os.totalmem();
  let available = os.freemem();
  if (IS_MAC) {
    const r = await run('vm_stat', [], { quiet: true, timeout: 3000 });
    if (r.ok) {
      const pageSize = Number(/page size of (\d+) bytes/.exec(r.stdout)?.[1] ?? 4096);
      const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(r.stdout)?.[1] ?? 0);
      available = (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * pageSize;
    }
  } else if (process.platform === 'linux') {
    try {
      const m = /MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
      if (m) available = Number(m[1]) * 1024;
    } catch { /* fall back to freemem */ }
  }
  available = Math.min(available, total);
  return { total, available, used: total - available };
}

export interface HostDisk { total: number; used: number; avail: number }

export async function hostDisk(): Promise<HostDisk | null> {
  const dir = fs.existsSync(settings().appsDir) ? settings().appsDir : os.homedir();
  const r = await run('df', ['-k', dir], { quiet: true, timeout: 5000 });
  if (!r.ok) return null;
  const parts = r.stdout.trim().split('\n').pop()?.split(/\s+/) ?? [];
  const [total, used, avail] = [Number(parts[1]) * 1024, Number(parts[2]) * 1024, Number(parts[3]) * 1024];
  return Number.isFinite(total) && total > 0 ? { total, used, avail } : null;
}

let lastCpu: { idle: number; total: number } | null = null;

/** CPU busy fraction (0-1) since the previous call. */
export function hostCpuUsage(): number {
  const now = os.cpus().reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.irq + t.idle;
    return acc;
  }, { idle: 0, total: 0 });
  const prev = lastCpu;
  lastCpu = now;
  if (!prev || now.total === prev.total) return 0;
  return Math.max(0, Math.min(1, 1 - (now.idle - prev.idle) / (now.total - prev.total)));
}
