import { useEffect, useState } from 'react';
import { DeployLogDialog, Pm2LogsDialog } from '../components/Logs';
import { SetupBanners, type Page } from '../components/Layout';
import { Banner, Button, CancelButton, Check, Confirm, CopyField, Empty, Field, Modal, Pill, StatusTag, SubmitButton, Tag, Toolbar } from '../components/ui';
import { del, get, post, put } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { ago, fmtBytes, repoShort, shortSha } from '../lib/format';
import { useAppState, useApps, useMonitoring, useRefresh, useTunnels } from '../lib/queries';
import { useReport, useToast } from '../lib/toast';
import { MetricCard, RangePicker, fmtPct } from './Overview';
import { SiteForm } from './Domains';
import type { AppView, AutoDeploy, Deploy } from '../../../src/shared/types';

// ---------------------------------------------------------------- list

export function Apps({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { data, error } = useApps();
  const { open } = useDialog();
  if (error) return <Empty>{error.message}</Empty>;
  if (!data) return <Empty>Memuat…</Empty>;
  const needsHookDomain = !data.webhookDomain && data.apps.some((a) => a.autoDeploy === 'webhook');
  return (
    <>
      <SetupBanners onNavigate={onNavigate} />
      {needsHookDomain && (
        <Banner action={<Button size="sm" variant="primary" onClick={() => onNavigate('settings')}>Atur</Button>}>
          Auto-deploy via webhook butuh domain publik untuk webhook server (port {data.webhookPort}). Atur sekali di Settings → Webhook.
        </Banner>
      )}
      <Toolbar title="Apps" count={data.apps.length}>
        <Button variant="primary" onClick={() => open(<AppForm />, { wide: true })}>+ Tambah app dari Git</Button>
      </Toolbar>
      {data.apps.length ? (
        <div className="appgrid">{data.apps.map((a) => <AppCard key={a.id} app={a} />)}</div>
      ) : (
        <div className="card"><Empty>
          Belum ada app.<br /><span className="sub">Tempel URL repo GitHub — Homeport akan clone, install, build, lalu menjalankannya dengan pm2.</span><br /><br />
          <Button variant="primary" onClick={() => open(<AppForm />, { wide: true })}>+ Tambah app pertama</Button>
        </Empty></div>
      )}
    </>
  );
}

function AppCard({ app: a }: { app: AppView }) {
  const { open } = useDialog();
  const toast = useToast();
  const refresh = useRefresh();
  const { data: mon } = useMonitoring();
  const p = a.pm2;
  const [tone, label]: [Parameters<typeof Pill>[0]['state'], string] = a.deploying ? ['run', 'deploying…']
    : !p ? ['', 'belum jalan']
    : p.status === 'online' ? (a.up ? ['ok', 'online'] : ['warn', 'online, port tertutup'])
    : ['err', p.status];
  const auto = a.autoDeploy === 'webhook' ? 'webhook' : a.autoDeploy === 'poll' ? `cek tiap ${a.pollInterval}s` : 'manual';
  const act = async (action: 'restart' | 'stop' | 'start') => { await post(`/api/apps/${a.id}/${action}`); toast(`${a.name}: ${action} OK`, 'ok'); await refresh('apps'); };
  const deploy = async () => { const r = await post<{ deploy: Deploy }>(`/api/apps/${a.id}/deploy`); open(<DeployLogDialog id={r.deploy.id} />, { wide: true }); await refresh('apps'); };

  return (
    <div className="card appc">
      <div className="appc-h">
        <div className="min0">
          <div className="host">{a.name}</div>
          <div className="sub mono ellipsis" title={a.repo}>{repoShort(a.repo)} <Tag>{a.branch}</Tag></div>
        </div>
        <Pill state={tone}>{label}</Pill>
      </div>
      <div className="kv">
        <div><span className="k">Port</span><span className="mono">{a.port}</span></div>
        <div><span className="k">Domain</span>{a.domains.length
          ? a.domains.map((d, i) => <span key={d}>{i > 0 && ', '}<a href={`https://${d}`} target="_blank" rel="noopener noreferrer">{d}</a></span>)
          : <a href="#" onClick={(e) => { e.preventDefault(); open(<SiteForm preset={{ pm2Name: a.name, upstreamPort: a.port, notes: a.name }} />); }}>+ tambah domain</a>}</div>
        <div><span className="k">Versi</span>{a.currentCommit ? <><span className="mono">{shortSha(a.currentCommit.sha)}</span> <span className="sub ellipsis">{a.currentCommit.msg}</span></> : <span className="sub">—</span>}</div>
        <div><span className="k">Deploy</span>{a.lastDeploy ? <><StatusTag status={a.lastDeploy.status} />{a.lastDeploy.rolledBackTo && <> <Tag tone="warn">di-rollback</Tag></>} <span className="sub">{ago(a.lastDeploy.at)}</span></> : <span className="sub">belum</span>}</div>
        <div><span className="k">Auto</span><span className="sub">{auto}</span></div>
        {p && <div><span className="k">Resource</span><span className="sub">{p.cpu}% CPU · {fmtBytes(p.mem)} · ↻{p.restarts}</span></div>}
      </div>
      <div className="actions left">
        <Button size="sm" variant="primary" disabled={a.deploying} onClick={deploy}>⟳ Deploy</Button>
        <Button size="sm" onClick={() => open(<AppHistory app={a} />, { wide: true })}>Riwayat</Button>
        <Button size="sm" onClick={() => open(<Pm2LogsDialog name={a.name} />, { wide: true })}>Logs</Button>
        {mon?.enabled && <Button size="sm" onClick={() => open(<AppMetrics name={a.name} />, { wide: true })}>Metrics</Button>}
        {p?.status === 'online'
          ? <><Button size="sm" onClick={() => act('restart')}>Restart</Button><Button size="sm" onClick={() => act('stop')}>Stop</Button></>
          : <Button size="sm" onClick={() => act('start')}>Start</Button>}
        <Button size="sm" onClick={() => open(<WebhookDialog app={a} />)}>Webhook</Button>
        <Button size="sm" onClick={() => open(<AppForm app={a} />, { wide: true })}>Edit</Button>
        <Button size="sm" variant="danger" onClick={() => open(<DeleteApp app={a} />)}>Hapus</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- create / edit

interface FormState {
  repo: string; name: string; branch: string; port: number; hostname: string; tunnel: string;
  autoDeploy: AutoDeploy; pollInterval: number; autoRollback: boolean; env: string;
  installCmd: string; buildCmd: string; startCmd: string; gitToken: string; maxMemory: string; healthTimeout: number; redeploy: boolean;
}

const nameFromRepo = (repo: string) => (/([^/:]+?)(\.git)?\/?$/.exec(repo.trim())?.[1] ?? '').toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 40);

function AppForm({ app }: { app?: AppView }) {
  const { data: apps } = useApps();
  const { data: state } = useAppState();
  const { data: tunnels } = useTunnels();
  const { open, close } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  const toast = useToast();
  const [nameTouched, setNameTouched] = useState(!!app);
  const [f, setF] = useState<FormState>(() => ({
    repo: app?.repo ?? '', name: app?.name ?? '', branch: app?.branch ?? 'main', port: app?.port ?? apps?.nextPort ?? 3001,
    hostname: '', tunnel: state?.settings.defaultTunnel ?? '', autoDeploy: app?.autoDeploy ?? 'webhook', pollInterval: app?.pollInterval ?? 60,
    autoRollback: app?.autoRollback ?? true, env: Object.entries(app?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    installCmd: app?.installCmd ?? '', buildCmd: app?.buildCmd ?? '', startCmd: app?.startCmd ?? '', gitToken: app?.gitToken ?? '',
    maxMemory: app?.maxMemory ?? '', healthTimeout: app?.healthTimeout ?? 40, redeploy: false,
  }));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  useEffect(() => { if (!nameTouched && f.repo) set('name', nameFromRepo(f.repo)); }, [f.repo, nameTouched]);

  const submit = async () => {
    const { hostname, tunnel, redeploy, ...rest } = f;
    const r = app
      ? await put<{ deploy?: Deploy; restarted?: boolean; warning?: string }>(`/api/apps/${app.id}`, { ...rest, redeploy })
      : await post<{ deploy?: Deploy; site?: unknown; warning?: string }>('/api/apps', { ...rest, hostname, tunnel });
    if (r.warning) toast(r.warning, 'warn', 9000);
    if ('site' in r && r.site) report(r.site, `Domain ${hostname} dibuat`);
    if ('restarted' in r && r.restarted) toast('App di-restart dengan config baru', 'ok');
    await refresh();
    if (r.deploy) open(<DeployLogDialog id={r.deploy.id} />, { wide: true });
    else { close(); toast('Tersimpan', 'ok'); }
  };

  const advancedOpen = !!(app && (app.installCmd || app.buildCmd || app.startCmd || app.gitTokenSet || app.maxMemory));
  return (
    <Modal title={app ? `Edit app ${app.name}` : 'Tambah app dari Git'} onSubmit={submit}
      footer={<><CancelButton /><SubmitButton>{app ? 'Simpan' : 'Buat & deploy'}</SubmitButton></>}>
      <Field label="URL repo">
        <input value={f.repo} onChange={(e) => set('repo', e.target.value)} required autoFocus autoComplete="off"
          placeholder="https://github.com/kamu/web-toko.git  atau  git@github.com:kamu/web-toko.git" />
      </Field>
      <div className="row">
        <Field label="Nama app (nama proses pm2)"><input value={f.name} readOnly={!!app} required onChange={(e) => { setNameTouched(true); set('name', e.target.value); }} placeholder="web-toko" /></Field>
        <Field label="Branch"><input value={f.branch} onChange={(e) => set('branch', e.target.value)} /></Field>
        <Field label="Port" hint={<>diberikan ke app sebagai <code>PORT</code></>}><input type="number" value={f.port} onChange={(e) => set('port', Number(e.target.value))} required /></Field>
      </div>
      {!app && (
        <div className="row">
          <Field label="Domain (opsional)" span={2}><input value={f.hostname} onChange={(e) => set('hostname', e.target.value)} placeholder="toko.domainkamu.com" autoComplete="off" /></Field>
          <Field label="Tunnel">
            <select value={f.tunnel} onChange={(e) => set('tunnel', e.target.value)}>
              <option value="">— tanpa tunnel —</option>
              {tunnels?.tunnels.map((t) => <option key={t.name}>{t.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      <div className="row">
        <Field label="Auto deploy saat push">
          <select value={f.autoDeploy} onChange={(e) => set('autoDeploy', e.target.value as AutoDeploy)}>
            <option value="webhook">Webhook (instan)</option>
            <option value="poll">Cek berkala (tanpa webhook)</option>
            <option value="off">Mati (deploy manual)</option>
          </select>
        </Field>
        {f.autoDeploy === 'poll' && <Field label="Interval cek (detik)"><input type="number" min={30} value={f.pollInterval} onChange={(e) => set('pollInterval', Number(e.target.value))} /></Field>}
      </div>
      <Check checked={f.autoRollback} onChange={(v) => set('autoRollback', v)}>Rollback otomatis ke versi terakhir yang sehat jika deploy gagal</Check>
      <Field label="Environment variables" hint={<>Satu per baris, format <code>KEY=VALUE</code>. <code>PORT</code> diisi otomatis.</>}>
        <textarea rows={4} value={f.env} onChange={(e) => set('env', e.target.value)} placeholder={'DATABASE_URL=postgres://…\nAPI_KEY=…'} />
      </Field>
      <details open={advancedOpen}>
        <summary>Perintah, repo private &amp; batas resource</summary>
        <p className="hint">Kosongkan = otomatis dari <code>package.json</code> (npm / pnpm / yarn / bun terdeteksi dari lockfile). Isi <code>-</code> untuk melewati langkah.</p>
        <div className="row">
          <Field label="Install"><input value={f.installCmd} onChange={(e) => set('installCmd', e.target.value)} placeholder="otomatis: npm ci" /></Field>
          <Field label="Build"><input value={f.buildCmd} onChange={(e) => set('buildCmd', e.target.value)} placeholder="otomatis: npm run build" /></Field>
          <Field label="Start"><input value={f.startCmd} onChange={(e) => set('startCmd', e.target.value)} placeholder="otomatis: npm start" /></Field>
        </div>
        <div className="row">
          <Field label="GitHub token (repo private via https)" span={2} hint={<>Fine-grained token dengan izin <b>Contents: Read</b>. Atau pakai URL <code>git@github.com:…</code> + SSH key di Mac.</>}>
            <input type="password" value={f.gitToken} onChange={(e) => set('gitToken', e.target.value)} autoComplete="new-password" placeholder="github_pat_…" />
          </Field>
          <Field label="Batas RAM"><input value={f.maxMemory} onChange={(e) => set('maxMemory', e.target.value)} placeholder="mis. 512M" /></Field>
        </div>
        <div className="row narrow"><Field label="Tunggu app siap (detik)"><input type="number" value={f.healthTimeout} onChange={(e) => set('healthTimeout', Number(e.target.value))} /></Field></div>
      </details>
      {app && <Check checked={f.redeploy} onChange={(v) => set('redeploy', v)}>Deploy ulang setelah disimpan</Check>}
    </Modal>
  );
}

// ---------------------------------------------------------------- history / rollback

interface CommitRow { sha: string; msg: string; author: string; date: string; deployedOk: boolean }

function AppHistory({ app }: { app: AppView }) {
  const { open } = useDialog();
  const [data, setData] = useState<{ deploys: Deploy[]; commits: CommitRow[]; current: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([get<{ deploys: Deploy[] }>(`/api/deploys?app=${app.id}`), get<{ commits: CommitRow[]; current: string | null }>(`/api/apps/${app.id}/commits`)])
      .then(([d, c]) => setData({ deploys: d.deploys, ...c }), (e: Error) => setErr(e.message));
  }, [app.id]);
  const rollback = async (sha: string) => { const r = await post<{ deploy: Deploy }>(`/api/apps/${app.id}/deploy`, { commit: sha }); open(<DeployLogDialog id={r.deploy.id} />, { wide: true }); };

  return (
    <Modal title={`Riwayat ${app.name}`}>
      {err ? <Empty>{err}</Empty> : !data ? <Empty>Memuat…</Empty> : <>
        <h4>Deploy</h4>
        <div className="card mb">
          {data.deploys.length ? <table><tbody>{data.deploys.map((d) => (
            <tr key={d.id}>
              <td><span className="mono">{shortSha(d.commit ?? d.target)}</span> <span className="sub">{d.msg ?? d.pushMsg ?? ''}</span></td>
              <td className="sub hide-sm">{d.trigger}{d.pushedBy ? ` · ${d.pushedBy}` : ''}</td>
              <td><StatusTag status={d.status} />{d.rolledBackTo && <> <Tag tone="warn">rollback</Tag></>}</td>
              <td className="sub">{ago(d.finishedAt ?? d.createdAt)}</td>
              <td><Button size="sm" onClick={() => open(<DeployLogDialog id={d.id} />, { wide: true })}>Log</Button></td>
            </tr>))}</tbody></table> : <Empty>Belum ada</Empty>}
        </div>
        <h4>Commit di {app.branch} — deploy versi mana pun</h4>
        <div className="card">
          {data.commits.length ? <table><tbody>{data.commits.map((c) => (
            <tr key={c.sha}>
              <td><span className="mono">{shortSha(c.sha)}</span> {c.msg}<div className="sub">{c.author} · {ago(c.date)}</div></td>
              <td>{c.sha === data.current ? <Tag tone="ok">aktif</Tag> : c.deployedOk ? <Tag>pernah sukses</Tag> : null}</td>
              <td className="right">{c.sha !== data.current && <Button size="sm" onClick={() => rollback(c.sha)}>Deploy versi ini</Button>}</td>
            </tr>))}</tbody></table> : <Empty>Repo belum di-clone</Empty>}
        </div>
        <p className="hint">Setelah rollback, app tetap di versi itu sampai ada push baru.</p>
      </>}
    </Modal>
  );
}

function AppMetrics({ name }: { name: string }) {
  const [range, setRange] = useState(6 * 3600);
  return (
    <Modal title={`Metrics ${name}`}>
      <div className="toolbar"><span className="grow" /><RangePicker value={range} onChange={setRange} /></div>
      <div className="grid2">
        <MetricCard title="CPU" preset="appCpu" app={name} range={range} format={fmtPct} />
        <MetricCard title="Memori" preset="appMem" app={name} range={range} format={fmtBytes} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- webhook & delete

function WebhookDialog({ app }: { app: AppView }) {
  const [w, setW] = useState<{ url: string | null; secret: string; lastWebhookAt: string | null } | null>(null);
  const toast = useToast();
  const load = () => get<{ url: string | null; secret: string; lastWebhookAt: string | null }>(`/api/apps/${app.id}/webhook`).then(setW, (e: Error) => toast(e.message, 'err'));
  useEffect(() => { void load(); }, [app.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const gh = /github\.com[/:]([^/]+\/[^/.]+)/.exec(app.repo)?.[1];
  const regen = async () => {
    if (!confirm('Secret lama tidak berlaku lagi. Kamu harus update secret di GitHub. Lanjut?')) return;
    await post(`/api/apps/${app.id}/secret`);
    await load();
    toast('Secret baru dibuat', 'ok');
  };
  return (
    <Modal title={`Webhook ${app.name}`} footer={<>{w?.url && <Button variant="danger" className="mr-auto" onClick={regen}>Buat secret baru</Button>}<button type="submit" className="btn">Tutup</button></>}>
      {!w ? <Empty>Memuat…</Empty> : !w.url ? (
        <Banner>Domain webhook belum diatur. Buka <b>Settings → Webhook</b>, isi domain (mis. <code>hooks.domainkamu.com</code>) lalu klik “Buat domain webhook”.</Banner>
      ) : <>
        <p className="sub">Pasang di GitHub: {gh ? <a href={`https://github.com/${gh}/settings/hooks/new`} target="_blank" rel="noopener noreferrer">repo → Settings → Webhooks → Add webhook</a> : 'repo → Settings → Webhooks → Add webhook'}</p>
        <Field label="Payload URL"><CopyField value={w.url} /></Field>
        <div className="row">
          <Field label="Content type"><input readOnly value="application/json" /></Field>
          <Field label="Event"><input readOnly value="Just the push event" /></Field>
        </div>
        <Field label="Secret"><CopyField value={w.secret} mono /></Field>
        <p className="sub">Webhook terakhir: {w.lastWebhookAt ? ago(w.lastWebhookAt) : 'belum pernah'} · hanya push ke <b>{app.branch}</b> yang memicu deploy.</p>
        {app.autoDeploy !== 'webhook' && <p className="hint">Mode auto-deploy app ini: <b>{app.autoDeploy}</b>. Ganti ke “Webhook” di Edit supaya push langsung ter-deploy.</p>}
      </>}
    </Modal>
  );
}

function DeleteApp({ app }: { app: AppView }) {
  const [files, setFiles] = useState(false);
  const [sites, setSites] = useState(true);
  const { close } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  return (
    <Confirm title="Hapus app" onConfirm={async () => {
      const r = await del(`/api/apps/${app.id}?files=${files ? 1 : 0}&site=${sites ? 1 : 0}`);
      close(); report(r, 'App dihapus'); await refresh();
    }}>
      <p>Hapus <b>{app.name}</b>? Proses pm2-nya dihentikan dan dihapus.</p>
      <Check checked={files} onChange={setFiles}>Hapus juga folder <code>{app.dir}</code></Check>
      {app.domains.length > 0 && <Check checked={sites} onChange={setSites}>Lepas domain: {app.domains.join(', ')}</Check>}
    </Confirm>
  );
}
