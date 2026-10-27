import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../src/server/config.js';
import { splitCommand } from '../src/server/lib/exec.js';
import { bracesBalanced, envMap } from '../src/server/lib/validators.js';
import { grafanaIni, prometheusConfig, rulesConfig } from '../src/server/monitoring/configs.js';
import { allDashboards, DATASOURCE_UID } from '../src/server/monitoring/dashboards.js';
import { generateCaddyfile } from '../src/server/services/caddy.js';
import { generateIngress } from '../src/server/services/cloudflared.js';
import { detectProject, generateEcosystem, gitAuthArgs } from '../src/server/services/deploy.js';
import { verifySignature } from '../src/server/services/webhooks.js';
import type { App, Site } from '../src/shared/types.js';

const site = (over: Partial<Site> = {}): Site => ({
  id: 'x',
  hostname: 'app.example.com',
  upstreamHost: 'localhost',
  upstreamPort: 3000,
  scheme: 'http',
  tlsInsecure: false,
  tunnel: 't',
  pm2Name: 'app',
  enabled: true,
  compress: false,
  basicAuthUser: '',
  basicAuthHash: '',
  extra: '',
  notes: '',
  createdAt: '',
  ...over,
});

const app = (over: Partial<App> = {}): App => ({
  id: 'id',
  name: 'web',
  repo: 'https://github.com/a/b.git',
  branch: 'main',
  port: 3001,
  installCmd: '',
  buildCmd: '',
  startCmd: '',
  env: {},
  autoDeploy: 'webhook',
  pollInterval: 60,
  autoRollback: true,
  healthTimeout: 40,
  maxMemory: '',
  gitToken: '',
  webhookSecret: 's',
  notes: '',
  createdAt: '',
  ...over,
});

const caddySettings = { caddyAdmin: 'localhost:2019', caddyHttpPort: 8080, caddyGlobalExtra: '', caddyRawAppend: '' };

describe('Caddyfile', () => {
  it('routes enabled sites and skips disabled ones', () => {
    const out = generateCaddyfile({
      settings: caddySettings,
      sites: [site(), site({ hostname: 'off.example.com', enabled: false })],
      metrics: 'none',
    });
    expect(out).toContain('http://app.example.com {\n\treverse_proxy http://localhost:3000\n}');
    expect(out).not.toContain('off.example.com');
    expect(out).toContain(':8080 {');
  });

  it('emits the right metrics option per Caddy version', () => {
    expect(generateCaddyfile({ settings: caddySettings, sites: [], metrics: 'per_host' })).toContain('\tmetrics {\n\t\tper_host\n\t}');
    expect(generateCaddyfile({ settings: caddySettings, sites: [], metrics: 'servers' })).toContain('\tservers {\n\t\tmetrics\n\t}');
    expect(generateCaddyfile({ settings: caddySettings, sites: [], metrics: 'none' })).not.toContain('metrics');
  });

  it('adds basic auth, compression and insecure TLS transport', () => {
    const hash = `$2a$14$${'a'.repeat(53)}`;
    const out = generateCaddyfile({
      settings: caddySettings,
      metrics: 'none',
      sites: [site({ compress: true, basicAuthUser: 'admin', basicAuthHash: hash, scheme: 'https', tlsInsecure: true })],
    });
    expect(out).toContain('encode zstd gzip');
    expect(out).toContain(`admin ${hash}`);
    expect(out).toContain('tls_insecure_skip_verify');
  });
});

describe('cloudflared ingress', () => {
  it('sends every hostname to Caddy and ends with a 404 catch-all', () => {
    const y = generateIngress({ id: 'abc', name: 't' }, ['a.example.com', 'b.example.com'], 8080, '/c/abc.json');
    expect(y).toContain('tunnel: abc');
    expect(y.match(/service: http:\/\/localhost:8080/g)).toHaveLength(2);
    expect(y.trim().endsWith('- service: http_status:404')).toBe(true);
  });
});

describe('deploy helpers', () => {
  it('splits commands with quotes', () => {
    expect(splitCommand('node dist/server.js --name "my app"')).toEqual(['node', 'dist/server.js', '--name', 'my app']);
    expect(splitCommand("npm run start -- --flag=''")).toEqual(['npm', 'run', 'start', '--', '--flag=']);
  });

  it('detects package manager and scripts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc', start: 'node dist' } }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(detectProject(dir)).toMatchObject({
      pm: 'pnpm',
      install: 'pnpm install --frozen-lockfile',
      build: 'pnpm run build',
      start: 'pnpm run start',
      workspace: null,
    });
    fs.rmSync(path.join(dir, 'pnpm-lock.yaml'));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    expect(detectProject(dir).install).toBe('npm ci');
  });

  it('writes a pm2 ecosystem with PORT and node interpreter', () => {
    const text = generateEcosystem(app({ env: { A: '1' }, maxMemory: '512M' }), '/apps/web', 'node dist/index.js', '/bin');
    const mod = { exports: {} as { apps: Record<string, unknown>[] } };
    new Function('module', text)(mod);
    const e = mod.exports.apps[0]!;
    expect(e).toMatchObject({ script: 'dist/index.js', interpreter: 'node', cwd: '/apps/web', max_memory_restart: '512M' });
    expect(e.env).toMatchObject({ A: '1', PORT: '3001', NODE_ENV: 'production', PATH: '/bin' });
  });

  it('only sends the token as a header for https repos', () => {
    expect(gitAuthArgs(app({ gitToken: 'tok' }))[1]).toMatch(/^http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic /);
    expect(gitAuthArgs(app({ gitToken: 'tok', repo: 'git@github.com:a/b.git' }))).toEqual([]);
  });
});

describe('webhook signature', () => {
  it('accepts a valid GitHub signature and rejects others', () => {
    const body = Buffer.from('{"ref":"refs/heads/main"}');
    const sig = `sha256=${crypto.createHmac('sha256', 'secret').update(body).digest('hex')}`;
    expect(verifySignature('secret', body, sig)).toBe(true);
    expect(verifySignature('other', body, sig)).toBe(false);
    expect(verifySignature('secret', body, 'sha256=abc')).toBe(false);
  });
});

describe('validators', () => {
  it('parses env text', () => {
    expect(envMap.parse('A=1\n# c\nexport B="two"\nPORT=9')).toEqual({ A: '1', B: 'two' });
    expect(envMap.safeParse('1BAD=x').success).toBe(false);
  });
  it('checks braces', () => {
    expect(bracesBalanced('a { b { } }')).toBe(true);
    expect(bracesBalanced('}{')).toBe(false);
  });
});

describe('monitoring configs', () => {
  const st = { ...defaultSettings(), tunnelMetricsPorts: { macmini: 20241 } };

  it('scrapes every component (YAML written as JSON)', () => {
    const cfg = JSON.parse(prometheusConfig(st).replace(/^#.*\n/, ''));
    const jobs = cfg.scrape_configs.map((j: { job_name: string }) => j.job_name);
    expect(jobs).toEqual(['homeport', 'node', 'caddy', 'cloudflared', 'prometheus']);
    expect(cfg.scrape_configs[3].static_configs[0].labels).toEqual({ tunnel: 'macmini' });
  });

  it('defines alert rules with severity and summary', () => {
    const rules = JSON.parse(rulesConfig().replace(/^#.*\n/, '')).groups[0].rules;
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) expect(r.labels.severity).toMatch(/critical|warning/) && expect(r.annotations.summary).toBeTruthy();
  });

  it('binds Grafana to localhost and enables embedding', () => {
    const ini = grafanaIni({ ...st, monitoring: { ...st.monitoring, grafanaAdminPassword: 'pw' } });
    expect(ini).toContain('http_addr = 127.0.0.1');
    expect(ini).toContain('admin_password = pw');
    expect(ini).toContain('allow_embedding = true');
  });

  it('builds dashboards with unique panel ids and the provisioned datasource', () => {
    for (const { json } of allDashboards()) {
      const panels = json.panels as { id: number; datasource?: { uid: string }; targets?: { expr: string }[]; type: string }[];
      expect(new Set(panels.map((p) => p.id)).size).toBe(panels.length);
      for (const p of panels.filter((x) => x.type !== 'row')) {
        expect(p.datasource?.uid).toBe(DATASOURCE_UID);
        for (const t of p.targets ?? []) expect(t.expr.length).toBeGreaterThan(3);
      }
    }
  });
});

describe('child process environment', () => {
  it('strips variables pm2 injects so child pm2 calls keep their own --name', async () => {
    const { childEnv } = await import('../src/server/lib/exec.js');
    const saved = { ...process.env };
    Object.assign(process.env, {
      pm_id: '1',
      name: 'homeport',
      homeport: '{}',
      namespace: 'default',
      NODE_CHANNEL_FD: '3',
      PM2_HOME: '/x/.pm2',
      PM2_USAGE: 'CLI',
      KEEP_ME: 'yes',
    });
    try {
      const env = childEnv();
      for (const k of ['pm_id', 'name', 'homeport', 'namespace', 'NODE_CHANNEL_FD', 'PM2_USAGE']) expect(env[k]).toBeUndefined();
      expect(env.PM2_HOME).toBe('/x/.pm2');
      expect(env.KEEP_ME).toBe('yes');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe('log hygiene', () => {
  it('strips terminal colour codes', async () => {
    const { stripAnsi } = await import('../src/server/lib/exec.js');
    expect(stripAnsi('\x1b[32m[PM2]\x1b[39m Applying action')).toBe('[PM2] Applying action');
  });
});
