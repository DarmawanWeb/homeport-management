import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectProject, findWorkspace, withPackageManager, workspacePackages } from '../src/server/services/project.js';

/** A Turborepo laid out like DCTEdu: two Next.js apps (with hardcoded ports) and shared packages. */
function monorepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-mono-'));
  const write = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof data === 'string' ? data : JSON.stringify(data));
  };
  write('package.json', { name: 'dctedu', private: true, packageManager: 'pnpm@10.28.0', scripts: { build: 'turbo run build' } });
  write('pnpm-lock.yaml', '');
  write('turbo.json', '{}');
  write('pnpm-workspace.yaml', "packages:\n  - apps/*\n  - 'packages/*'\n\nonlyBuiltDependencies:\n  - sharp\n");
  write('apps/store/package.json', {
    name: '@dctedu/store',
    scripts: { build: 'next build', start: 'next start --port 3000' },
    dependencies: { next: '^16' },
  });
  write('apps/simulator/package.json', {
    name: '@dctedu/simulator',
    scripts: { build: 'next build', start: 'next start --port 3001' },
    dependencies: { next: '^16' },
  });
  write('packages/ui/package.json', { name: '@dctedu/ui' });
  write('packages/api/package.json', { name: '@dctedu/api', scripts: { build: 'tsc', start: 'node dist/index.js' } });
  return root;
}

describe('monorepos', () => {
  it('lists workspace packages from pnpm-workspace.yaml', () => {
    const root = monorepo();
    expect(workspacePackages(root).map((p) => p.name)).toEqual(['@dctedu/api', '@dctedu/simulator', '@dctedu/store', '@dctedu/ui']);
    expect(findWorkspace(root, 'apps/store')?.name).toBe('@dctedu/store');
    expect(findWorkspace(root, 'simulator')?.name).toBe('@dctedu/simulator');
    expect(findWorkspace(root, '@dctedu/nope')).toBeNull();
  });

  it('builds one package with Turborepo and starts Next.js on the assigned port', () => {
    const root = monorepo();
    const d = detectProject(root, { workspace: '@dctedu/store', port: 3010 });
    expect(d).toMatchObject({
      pm: 'pnpm',
      pmSpec: 'pnpm@10.28.0',
      install: 'pnpm install --frozen-lockfile',
      build: 'pnpm exec turbo run build --filter=@dctedu/store',
      startDir: path.join(root, 'apps/store'),
      turbo: true,
      next: true,
    });
    // The package's own script says --port 3000; Homeport's port wins.
    expect(d.start).toBe(`${path.join(root, 'apps/store/node_modules/.bin/next')} start --port 3010`);
  });

  it('uses workspace filters when there is no Turborepo', () => {
    const root = monorepo();
    fs.rmSync(path.join(root, 'turbo.json'));
    const d = detectProject(root, { workspace: 'packages/api', port: 3020 });
    expect(d.build).toBe('pnpm --filter @dctedu/api run build');
    expect(d.start).toBe('pnpm run start');
    expect(d.startDir).toBe(path.join(root, 'packages/api'));
  });

  it('explains a package name that does not exist', () => {
    expect(() => detectProject(monorepo(), { workspace: '@dctedu/shop' })).toThrow(/Packages here: @dctedu\/api, @dctedu\/simulator/);
  });

  it('falls back to corepack or npx when pnpm is not installed', () => {
    expect(withPackageManager('pnpm install --frozen-lockfile', 'pnpm', 'pnpm@10.28.0', { pm: true, corepack: true })).toBe(
      'pnpm install --frozen-lockfile',
    );
    expect(withPackageManager('pnpm install --frozen-lockfile', 'pnpm', 'pnpm@10.28.0', { pm: false, corepack: true })).toBe(
      'corepack pnpm install --frozen-lockfile',
    );
    expect(withPackageManager('pnpm exec turbo run build', 'pnpm', 'pnpm@10.28.0', { pm: false, corepack: false })).toBe(
      'npx --yes pnpm@10.28.0 exec turbo run build',
    );
    expect(withPackageManager('npm ci', 'npm', 'npm', { pm: false, corepack: false })).toBe('npm ci');
  });
});

describe('pm2 output', async () => {
  const { jsonPart } = await import('../src/server/services/pm2.js');
  it('finds the JSON after notices from pm2', () => {
    const out = `[PM2][WARN] Current process list is not synchronized with saved list.
>>>> In-memory PM2 is out-of-date, do:
>>>> $ pm2 update
[{"name":"web","pm_id":0}]`;
    expect(JSON.parse(jsonPart(out))).toEqual([{ name: 'web', pm_id: 0 }]);
    expect(JSON.parse(jsonPart('[]\n'))).toEqual([]);
  });
});

describe('Tailscale', async () => {
  const { parseTailscale } = await import('../src/server/services/tailscale.js');
  it('reads the tailnet name and whether the dashboard is served', () => {
    const status = {
      BackendState: 'Running',
      Self: { DNSName: 'mac-mini.tail1234.ts.net.', TailscaleIPs: ['100.101.1.2', 'fd7a:115c::1'] },
      CurrentTailnet: { Name: 'agus@example.com' },
    };
    const serve = {
      TCP: { '443': { HTTPS: true } },
      Web: { 'mac-mini.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7070' } } } },
    };
    expect(parseTailscale(status, serve, 7070)).toEqual({
      running: true,
      state: 'Running',
      dnsName: 'mac-mini.tail1234.ts.net',
      ip: '100.101.1.2',
      tailnet: 'agus@example.com',
      serving: 'https://mac-mini.tail1234.ts.net',
    });
    expect(parseTailscale(status, { Web: {} }, 7070).serving).toBeNull();
    expect(parseTailscale(status, serve, 8080).serving).toBeNull();
    expect(parseTailscale(null, null, 7070)).toMatchObject({ running: false, state: 'NoState', dnsName: null });
  });
});
