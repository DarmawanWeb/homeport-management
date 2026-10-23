import { useState } from 'react';
import { SetupBanners, type Page } from '../components/Layout';
import { Button, CancelButton, Check, Confirm, Dot, Empty, Field, Modal, SubmitButton, Tag, Toolbar } from '../components/ui';
import { del, post, put } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useAppState, usePm2, useRefresh, useSiteHealth, useTunnels } from '../lib/queries';
import { useReport } from '../lib/toast';
import type { Site } from '../../../src/shared/types';

export function Domains({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { data: state } = useAppState();
  const { data: health } = useSiteHealth();
  const { open } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  if (!state) return <Empty>Memuat…</Empty>;
  const sites = state.sites;
  const toggle = async (s: Site) => { report(await post(`/api/sites/${s.id}/toggle`)); await refresh(); };
  const apply = async () => { report({ apply: await post('/api/caddy/apply') }, 'Caddy di-reload, config tunnel tersinkron'); await refresh(); };

  return (
    <>
      <SetupBanners onNavigate={onNavigate} />
      <div className="card flow">
        <b>domain</b><span className="arr">→</span>Cloudflare Tunnel<span className="arr">→</span><b>Caddy :{state.settings.caddyHttpPort}</b><span className="arr">→</span><b>localhost:port</b><span className="sub">(app pm2 kamu)</span>
      </div>
      <Toolbar title="Domains" count={sites.length}>
        <Button onClick={apply}>⟳ Apply ulang</Button>
        <Button variant="primary" onClick={() => open(<SiteForm />)}>+ Tambah domain</Button>
      </Toolbar>
      <div className="card">
        {sites.length ? (
          <table>
            <thead><tr><th>Domain</th><th>Upstream</th><th className="hide-sm">Tunnel</th><th className="hide-sm">App</th><th /></tr></thead>
            <tbody>{sites.map((s) => (
              <tr key={s.id} className={s.enabled ? '' : 'disabled'}>
                <td><div className="host"><a href={`https://${s.hostname}`} target="_blank" rel="noopener noreferrer">{s.hostname}</a></div>{s.notes && <div className="sub">{s.notes}</div>}</td>
                <td className="mono"><Dot state={health?.[s.id] === true ? 'ok' : health?.[s.id] === false ? 'err' : ''} title={health?.[s.id] ? 'port terbuka' : 'port tidak merespon'} /> {s.scheme}://{s.upstreamHost}:{s.upstreamPort}</td>
                <td className="hide-sm">{s.tunnel ? <Tag tone="acc">{s.tunnel}</Tag> : <Tag tone="err">tanpa tunnel</Tag>}</td>
                <td className="hide-sm">{s.pm2Name ? <Tag>{s.pm2Name}</Tag> : <span className="sub">—</span>}</td>
                <td><div className="actions">
                  <Button size="sm" onClick={() => toggle(s)}>{s.enabled ? 'Disable' : 'Enable'}</Button>
                  <Button size="sm" onClick={() => open(<SiteForm site={s} />)}>Edit</Button>
                  <Button size="sm" variant="danger" onClick={() => open(<DeleteSite site={s} />)}>Hapus</Button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        ) : <Empty>Belum ada domain.<br /><br /><Button variant="primary" onClick={() => open(<SiteForm />)}>+ Tambah domain pertama</Button></Empty>}
      </div>
    </>
  );
}

type SiteForm = Omit<Site, 'id' | 'createdAt' | 'updatedAt'> & { routeDns: boolean; overwriteDns: boolean; deleteOldDns: boolean; basicAuthPw: string };

export function SiteForm({ site, preset }: { site?: Site; preset?: Partial<Site> }) {
  const { data: state } = useAppState();
  const { data: tunnels } = useTunnels();
  const { data: pm2 } = usePm2();
  const { close } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  const st = state?.settings;
  const [f, setF] = useState<SiteForm>(() => ({
    hostname: '', upstreamHost: 'localhost', upstreamPort: 3000, scheme: 'http', tlsInsecure: false, tunnel: st?.defaultTunnel ?? '',
    pm2Name: '', enabled: true, compress: false, basicAuthUser: '', basicAuthHash: '', extra: '', notes: '',
    ...preset, ...site, routeDns: !site, overwriteDns: !!site, deleteOldDns: false, basicAuthPw: '',
  }));
  const set = <K extends keyof SiteForm>(k: K, v: SiteForm[K]) => setF((s) => ({ ...s, [k]: v }));
  const procs = (pm2?.list ?? []).filter((p) => st && !p.name.startsWith(st.tunnelPm2Prefix) && !p.name.startsWith('hp-') && p.name !== 'homeport');

  const submit = async () => {
    const { basicAuthPw, ...body } = f;
    if (body.basicAuthUser && basicAuthPw) body.basicAuthHash = (await post<{ hash: string }>('/api/caddy-hash', { password: basicAuthPw })).hash;
    if (!body.basicAuthUser) body.basicAuthHash = '';
    if (body.basicAuthUser && !body.basicAuthHash) throw new Error('Isi password basic auth');
    const r = site ? await put(`/api/sites/${site.id}`, body) : await post('/api/sites', body);
    close();
    report(r, site ? 'Domain diperbarui' : 'Domain ditambahkan');
    await refresh();
  };

  return (
    <Modal title={site ? 'Edit domain' : 'Tambah domain'} onSubmit={submit} footer={<><CancelButton /><SubmitButton>Simpan</SubmitButton></>}>
      <Field label="Domain / hostname" hint="Domain harus ada di akun Cloudflare yang dipakai login cloudflared.">
        <input value={f.hostname} onChange={(e) => set('hostname', e.target.value)} placeholder="app.domainkamu.com" required autoFocus autoComplete="off" />
      </Field>
      {procs.length > 0 && (
        <Field label="Ambil dari proses pm2">
          <div className="chips">{procs.map((p) => (
            <button type="button" key={p.name} className="chip" onClick={() => setF((s) => ({ ...s, pm2Name: p.name, upstreamPort: p.port ?? s.upstreamPort, notes: s.notes || p.name }))}>
              {p.name}{p.port ? ` :${p.port}` : ''} <Dot state={p.status === 'online' ? 'ok' : 'err'} />
            </button>
          ))}</div>
        </Field>
      )}
      <div className="row">
        <Field label="Host upstream" span={2}><input value={f.upstreamHost} onChange={(e) => set('upstreamHost', e.target.value)} /></Field>
        <Field label="Port app"><input type="number" min={1} max={65535} value={f.upstreamPort} onChange={(e) => set('upstreamPort', Number(e.target.value))} required /></Field>
      </div>
      <div className="row">
        <Field label="Tunnel">
          <select value={f.tunnel} onChange={(e) => set('tunnel', e.target.value)}>
            <option value="">— tanpa tunnel —</option>
            {tunnels?.tunnels.map((t) => <option key={t.name}>{t.name}</option>)}
            {f.tunnel && !tunnels?.tunnels.some((t) => t.name === f.tunnel) && <option>{f.tunnel}</option>}
          </select>
        </Field>
        <Field label="Nama app / proses pm2"><input value={f.pm2Name} onChange={(e) => set('pm2Name', e.target.value)} placeholder="opsional" /></Field>
      </div>
      <Check checked={f.routeDns} onChange={(v) => set('routeDns', v)}>{site ? 'Route ulang DNS ke tunnel (jika domain/tunnel berubah)' : 'Buat DNS record (CNAME) ke tunnel otomatis'}</Check>
      <Check checked={f.overwriteDns} onChange={(v) => set('overwriteDns', v)}>Timpa DNS record yang sudah ada</Check>
      {site && st?.cfApiTokenSet && <Check checked={f.deleteOldDns} onChange={(v) => set('deleteOldDns', v)}>Hapus DNS lama jika domain diganti</Check>}
      <Check checked={f.enabled} onChange={(v) => set('enabled', v)}>Aktif</Check>
      <details open={!!(site && (site.extra || site.basicAuthUser || site.scheme === 'https' || site.compress))}>
        <summary>Opsi lanjutan</summary>
        <div className="row">
          <Field label="Skema upstream"><select value={f.scheme} onChange={(e) => set('scheme', e.target.value as 'http' | 'https')}><option>http</option><option>https</option></select></Field>
          <div className="field pad-top"><Check checked={f.tlsInsecure} onChange={(v) => set('tlsInsecure', v)}>Skip verify TLS upstream</Check></div>
        </div>
        <Check checked={f.compress} onChange={(v) => set('compress', v)}>Kompresi gzip/zstd</Check>
        <div className="row">
          <Field label="Basic auth user"><input value={f.basicAuthUser} onChange={(e) => set('basicAuthUser', e.target.value)} autoComplete="off" /></Field>
          <Field label="Password (di-hash bcrypt)"><input type="password" value={f.basicAuthPw} onChange={(e) => set('basicAuthPw', e.target.value)} placeholder={f.basicAuthHash ? '(tidak diubah)' : ''} autoComplete="new-password" /></Field>
        </div>
        <Field label="Directive Caddy tambahan (di dalam blok site)"><textarea value={f.extra} onChange={(e) => set('extra', e.target.value)} placeholder={'header X-Robots-Tag noindex\nrequest_body { max_size 50MB }'} /></Field>
        <Field label="Catatan"><input value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      </details>
    </Modal>
  );
}

function DeleteSite({ site }: { site: Site }) {
  const { data: state } = useAppState();
  const [dns, setDns] = useState(true);
  const { close } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  return (
    <Confirm title="Hapus domain" onConfirm={async () => { const r = await del(`/api/sites/${site.id}?dns=${dns && state?.settings.cfApiTokenSet ? 1 : 0}`); close(); report(r, 'Domain dihapus'); await refresh(); }}>
      <p>Hapus <b>{site.hostname}</b>? Route Caddy dan ingress tunnel akan dihapus.</p>
      {state?.settings.cfApiTokenSet
        ? <Check checked={dns} onChange={setDns}>Hapus juga CNAME DNS di Cloudflare</Check>
        : <p className="hint">CNAME DNS tidak ikut terhapus. Hapus manual di dashboard Cloudflare, atau isi API token di Settings supaya otomatis.</p>}
    </Confirm>
  );
}
