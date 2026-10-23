import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { DATA_DIR, defaultSettings, paths } from './config.js';
import type { DbShape, Settings } from '../shared/types.js';

const SCHEMA_VERSION = 3;

function emptyDb(): DbShape {
  return { version: SCHEMA_VERSION, settings: defaultSettings(), sites: [], apps: [], deploys: [] };
}

/** Merge stored settings onto defaults so new fields appear after upgrades. */
function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const d = defaultSettings();
  const s = stored ?? {};
  return {
    ...d,
    ...s,
    tunnelMetricsPorts: { ...(s.tunnelMetricsPorts ?? {}) },
    monitoring: { ...d.monitoring, ...(s.monitoring ?? {}) },
    notify: { ...d.notify, ...(s.notify ?? {}) },
  };
}

/** The single in-memory database. Mutate it, then call `save()`. */
export const db: DbShape = emptyDb();

export function loadDb(): void {
  for (const dir of [DATA_DIR, paths.tunnels, paths.backups, paths.ecosystem, paths.deployLogs, paths.monitoring]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(paths.db)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(paths.db, 'utf8')) as Partial<DbShape>;
    db.settings = mergeSettings(raw.settings);
    db.sites = raw.sites ?? [];
    db.apps = (raw.apps ?? []).map((a) => ({ ...a, env: a.env ?? {} }));
    db.deploys = raw.deploys ?? [];
    db.version = SCHEMA_VERSION;
  } catch (e) {
    const backup = `${paths.db}.corrupt-${Date.now()}`;
    fs.copyFileSync(paths.db, backup);
    console.error(`db.json tidak bisa dibaca (${(e as Error).message}); disalin ke ${backup}, memakai default`);
  }
}

// Writes are serialized and coalesced: a burst of saves results in one write of the latest state.
let chain: Promise<void> = Promise.resolve();
let pending = false;

export function saveDb(): Promise<void> {
  if (pending) return chain;
  pending = true;
  chain = chain
    .then(async () => {
      pending = false;
      const tmp = `${paths.db}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
      await fsp.rename(tmp, paths.db);
    })
    .catch((e: Error) => {
      pending = false;
      console.error('Gagal menyimpan db:', e.message);
    });
  return chain;
}

export const settings = (): Settings => db.settings;
