import os from 'node:os';
import type { SystemDTO } from '../../shared/types.js';
import { hostDisk, hostMemory } from '../monitoring/host.js';
import { db } from '../store.js';
import * as pm2 from './pm2.js';

export async function systemInfo(): Promise<SystemDTO> {
  const [procs, mem, disk] = await Promise.all([pm2.list(), hostMemory(), hostDisk()]);
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version,
    uptime: os.uptime(),
    load: os.loadavg(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? '',
    mem: { total: mem.total, free: mem.available },
    disk,
    pm2: {
      total: procs.list.length,
      online: procs.list.filter((p) => p.status === 'online').length,
      mem: procs.list.reduce((t, p) => t + p.mem, 0),
    },
    counts: { apps: db.apps.length, sites: db.sites.length },
    recentDeploys: db.deploys.slice(0, 8),
  };
}
