import fs from 'node:fs';
import path from 'node:path';

/**
 * Works out how to install, build and start a repository: a plain Node app, or one package of a
 * monorepo (pnpm, npm, yarn or bun workspaces, with or without Turborepo).
 */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface Pkg {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

export interface Detected {
  pm: PackageManager;
  /** Version from package.json "packageManager", e.g. pnpm@10.28.0. */
  pmSpec: string;
  install: string;
  build: string;
  start: string;
  /** Where the app runs (the workspace package's folder, or the repository root). */
  startDir: string;
  /** Set when a monorepo package was picked. */
  workspace: { name: string; dir: string } | null;
  turbo: boolean;
  next: boolean;
}

function readPkg(dir: string): Pkg | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Pkg;
  } catch {
    return null;
  }
}

/** Workspace globs from pnpm-workspace.yaml or package.json "workspaces". Only `dir/*` and plain paths. */
export function workspaceGlobs(root: string): string[] {
  const out: string[] = [];
  try {
    const yaml = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    let inPackages = false;
    for (const line of yaml.split('\n')) {
      if (/^packages:\s*$/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = /^\s+-\s+['"]?([^'"#\s]+)['"]?/.exec(line);
        if (m) out.push(m[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  } catch {
    /* not pnpm */
  }
  const w = readPkg(root)?.workspaces;
  if (Array.isArray(w)) out.push(...w);
  else if (w?.packages) out.push(...w.packages);
  return out.filter((g) => !g.startsWith('!'));
}

/** Every package folder in the workspace, with its name. */
export function workspacePackages(root: string): { name: string; dir: string }[] {
  const dirs = new Set<string>();
  for (const g of workspaceGlobs(root)) {
    const clean = g.replace(/\/\*\*$/, '/*');
    if (clean.endsWith('/*')) {
      const base = path.join(root, clean.slice(0, -2));
      try {
        for (const d of fs.readdirSync(base, { withFileTypes: true })) if (d.isDirectory()) dirs.add(path.join(base, d.name));
      } catch {
        /* missing folder, e.g. an uninitialised submodule */
      }
    } else dirs.add(path.join(root, clean));
  }
  const out: { name: string; dir: string }[] = [];
  for (const dir of dirs) {
    const p = readPkg(dir);
    if (p?.name) out.push({ name: p.name, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Find a package by name (@scope/app) or folder (apps/store). */
export function findWorkspace(root: string, wanted: string): { name: string; dir: string } | null {
  const w = wanted.trim().replace(/\/$/, '');
  if (!w) return null;
  const pkgs = workspacePackages(root);
  const byName = pkgs.find((p) => p.name === w);
  if (byName) return byName;
  const byDir = pkgs.find((p) => path.relative(root, p.dir) === w || path.basename(p.dir) === w);
  if (byDir) return byDir;
  // A folder outside the declared globs still works if it has a package.json.
  const dir = path.resolve(root, w);
  if (dir.startsWith(root) && readPkg(dir)) return { name: readPkg(dir)?.name ?? w, dir };
  return null;
}

const usesNext = (p: Pkg | null) => !!(p?.dependencies?.next || p?.devDependencies?.next);

export function detectProject(dir: string, opts: { workspace?: string; port?: number } = {}): Detected {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  const root = readPkg(dir);
  const pm: PackageManager = has('pnpm-lock.yaml')
    ? 'pnpm'
    : has('yarn.lock')
      ? 'yarn'
      : has('bun.lockb') || has('bun.lock')
        ? 'bun'
        : 'npm';
  const pmSpec = root?.packageManager?.startsWith(`${pm}@`) ? root.packageManager.split('+')[0] : pm;
  const turbo = has('turbo.json');

  const install = !root
    ? ''
    : pm === 'npm'
      ? has('package-lock.json') || has('npm-shrinkwrap.json')
        ? 'npm ci'
        : 'npm install'
      : pm === 'pnpm'
        ? 'pnpm install --frozen-lockfile'
        : pm === 'yarn'
          ? 'yarn install --frozen-lockfile'
          : 'bun install';

  const ws = opts.workspace ? findWorkspace(dir, opts.workspace) : null;
  if (opts.workspace && !ws) {
    const names = workspacePackages(dir).map((p) => p.name);
    throw new Error(`No workspace package "${opts.workspace}"${names.length ? `. Packages here: ${names.join(', ')}` : ''}`);
  }
  // A monorepo root usually cannot run on its own (DCTEdu: `turbo run start` with no start task).
  // Say which package to pick instead of letting pm2 crash-loop.
  if (!ws && root) {
    const rootStart = root.scripts?.start ?? '';
    const apps = workspacePackages(dir).filter((p) => readPkg(p.dir)?.scripts?.start);
    if (apps.length && (!rootStart || /^(turbo|nx|lerna)\b/.test(rootStart.trim())))
      throw new Error(
        `This repository is a monorepo. Edit the app and set "Package (monorepos)" to the app to run: ${apps.map((p) => p.name).join(', ')}. Make one Homeport app per package.`,
      );
  }
  const pkg = ws ? readPkg(ws.dir) : root;
  const startDir = ws?.dir ?? dir;
  const next = usesNext(pkg);

  // Build: Turborepo builds the package and everything it depends on, in order, with caching.
  let build = '';
  if (ws) {
    const exec = { pnpm: 'pnpm exec', npm: 'npx', yarn: 'yarn', bun: 'bunx' }[pm];
    if (turbo) build = `${exec} turbo run build --filter=${ws.name}`;
    else if (pkg?.scripts?.build)
      build = {
        pnpm: `pnpm --filter ${ws.name} run build`,
        npm: `npm run build --workspace=${ws.name}`,
        yarn: `yarn workspace ${ws.name} run build`,
        bun: `bun run --filter ${ws.name} build`,
      }[pm];
  } else if (pkg?.scripts?.build) build = `${pm} run build`;

  // Start: Next.js is started directly so it listens on Homeport's port even when the "start"
  // script hardcodes one (next start --port 3000), which is common.
  let start = '';
  const nextBin = path.join(startDir, 'node_modules', '.bin', 'next');
  if (next && (!pkg?.scripts?.start || /\bnext start\b/.test(pkg.scripts.start))) {
    start = `${nextBin} start --port ${opts.port ?? 3000}`;
  } else if (pkg?.scripts?.start) start = `${pm} run start`;
  else if (pkg?.main) start = `node ${pkg.main}`;
  else if (fs.existsSync(path.join(startDir, 'index.js'))) start = 'node index.js';
  else if (fs.existsSync(path.join(startDir, 'server.js'))) start = 'node server.js';

  return { pm, pmSpec, install, build, start, startDir, workspace: ws, turbo, next };
}

/**
 * Package managers other than npm come through corepack, which newer Node releases no longer
 * bundle. Rewrite a leading `pnpm`/`yarn` to whatever is available on this machine.
 */
export function withPackageManager(cmd: string, pm: PackageManager, pmSpec: string, available: { pm: boolean; corepack: boolean }): string {
  if (pm === 'npm' || pm === 'bun' || available.pm) return cmd;
  const re = new RegExp(`^${pm}(\\s|$)`);
  if (!re.test(cmd)) return cmd;
  const prefix = available.corepack ? `corepack ${pm}` : `npx --yes ${pmSpec}`;
  return cmd.replace(re, `${prefix}$1`);
}
