import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AnalyticsDTO, AnalyticsRange } from '../../shared/types.js';
import { paths } from '../config.js';
import { activity } from '../lib/activity.js';
import { errMsg } from '../lib/errors.js';
import { settings } from '../store.js';
import { parseLine } from './parse.js';
import { AnalyticsStore } from './store.js';

/**
 * Follows Caddy's JSON access log (written for every public domain) and feeds the aggregate store.
 * The read position is saved, so a restart neither loses nor double counts requests; when Caddy
 * rolls the file over, reading starts again at the top of the new one.
 */

export const ACCESS_LOG = path.join(paths.analytics, 'access.log');
const STATE = path.join(paths.analytics, 'reader.json');

let store: AnalyticsStore | null = null;
let pos = { ino: 0, offset: 0 };
let timer: NodeJS.Timeout | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let reading = false;

export const analyticsStore = (): AnalyticsStore => {
  if (!store) {
    store = new AnalyticsStore(path.join(paths.analytics, 'days'), settings().analytics.retentionDays);
    store.load();
  }
  return store;
};

async function readNew(): Promise<void> {
  if (reading) return;
  reading = true;
  try {
    const st = await fsp.stat(ACCESS_LOG).catch(() => null);
    if (!st) return;
    if (st.ino !== pos.ino || st.size < pos.offset) pos = { ino: st.ino, offset: 0 };
    if (st.size === pos.offset) return;
    // At most 8 MB per pass, so a big backlog never blocks the event loop for long.
    const end = Math.min(st.size, pos.offset + 8 * 1024 * 1024);
    const fh = await fsp.open(ACCESS_LOG, 'r');
    try {
      const buf = Buffer.alloc(end - pos.offset);
      await fh.read(buf, 0, buf.length, pos.offset);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) return;
      const s = analyticsStore();
      for (const line of text.slice(0, lastNl).split('\n')) {
        const hit = line ? parseLine(line) : null;
        if (hit) s.add(hit);
      }
      pos.offset += Buffer.byteLength(text.slice(0, lastNl + 1));
    } finally {
      await fh.close();
    }
    await fsp.writeFile(STATE, JSON.stringify(pos));
  } catch (e) {
    activity.warn(`Analytics: ${errMsg(e)}`);
  } finally {
    reading = false;
  }
}

export function startAnalytics(): void {
  fs.mkdirSync(paths.analytics, { recursive: true });
  try {
    pos = JSON.parse(fs.readFileSync(STATE, 'utf8')) as typeof pos;
  } catch {
    pos = { ino: 0, offset: 0 };
  }
  analyticsStore();
  timer ??= setInterval(() => void readNew(), 2000);
  flushTimer ??= setInterval(() => flushAnalytics(), 60_000);
  timer.unref();
  flushTimer.unref();
  void readNew();
}

export function flushAnalytics(): void {
  try {
    store?.flush();
  } catch (e) {
    activity.warn(`Analytics save: ${errMsg(e)}`);
  }
}

export async function analytics(range: AnalyticsRange, host: string): Promise<AnalyticsDTO> {
  await readNew();
  const s = analyticsStore();
  return {
    ...s.query(range, host),
    enabled: settings().analytics.enabled,
    receiving: fs.existsSync(ACCESS_LOG),
  };
}
