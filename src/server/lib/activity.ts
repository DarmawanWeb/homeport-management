import type { ActivityEntry } from '../../shared/types.js';

const MAX = 500;
const entries: ActivityEntry[] = [];

function push(level: ActivityEntry['level'], msg: string, detail?: unknown): void {
  const entry: ActivityEntry = { t: new Date().toISOString(), level, msg, detail: detail ? String(detail).slice(0, 4000) : '' };
  entries.push(entry);
  if (entries.length > MAX) entries.shift();
  const line = `[${entry.t}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

/** Human-facing activity log, shown in the dashboard and printed to stdout (pm2 logs). */
export const activity = {
  info: (msg: string, detail?: unknown) => push('info', msg, detail),
  warn: (msg: string, detail?: unknown) => push('warn', msg, detail),
  error: (msg: string, detail?: unknown) => push('error', msg, detail),
  recent: (n = 300): ActivityEntry[] => entries.slice(-n).reverse(),
};
