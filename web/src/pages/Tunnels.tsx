import { useEffect, useState } from 'react';
import { SetupBanners, type Page } from '../components/Layout';
import { Pm2LogsDialog } from '../components/Logs';
import { Banner, Button, CancelButton, Check, Confirm, Empty, Field, Modal, SubmitButton, Tag, Toolbar } from '../components/ui';
import { del, get, post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useAppState, useRefresh, useTunnels } from '../lib/queries';
import { useReport, useToast } from '../lib/toast';
import type { TunnelView } from '../../../src/shared/types';

export function Tunnels({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { data, error, isLoading } = useTunnels();
  const { data: state } = useAppState();
  const { open } = useDialog();
  const toast = useToast();
  const refresh = useRefresh();
  const prefix = state?.settings.tunnelPm2Prefix ?? 'hp-cf-';

  const act = async (t: TunnelView, action: string) => {
    await post(`/api/tunnels/${encodeURIComponent(t.name)}/${action}`);
    toast(`${t.name}: ${action} OK`, 'ok');
    await refresh('tunnels', 'state', 'status');
    if (action === 'start' || action === 'restart') setTimeout(() => void get('/api/tunnels?refresh=1').then(() => refresh('tunnels')), 4000);
  };

  return (
    <>
      <SetupBanners onNavigate={onNavigate} />
      <Toolbar title="Cloudflare Tunnels">
        <Button onClick={async () => { await get('/api/tunnels?refresh=1'); await refresh('tunnels'); }}>⟳ Refresh</Button>
        <Button variant="primary" onClick={() => open(<CreateTunnel />)}>+ Buat tunnel</Button>
      </Toolbar>
      {error && <Banner>{error.message}</Banner>}
      <div className="card">
        {isLoading ? <Empty>Memuat…</Empty> : data?.tunnels.length ? (
          <table>
            <thead><tr><th>Tunnel</th><th>Status</th><th className="hide-sm">Domain</th><th /></tr></thead>
            <tbody>{data.tunnels.map((t) => {
              const running = t.pm2?.status === 'online';
              return (
                <tr key={t.id}>
                  <td><div className="host">{t.name} {state?.settings.defaultTunnel === t.name && <Tag tone="acc">default</Tag>}</div><div className="sub mono">{t.id}</div></td>
                  <td>
                    {t.connections ? <Tag tone="ok">{t.connections} koneksi edge</Tag> : <Tag>0 koneksi</Tag>}
                    <div className="sub">pm2: {t.pm2?.status ?? 'tidak jalan'}{t.metricsPort ? ` · metrics :${t.metricsPort}` : ''}</div>
                    {!t.credentials && <Tag tone="err">kredensial tidak ada di Mac ini</Tag>}
                  </td>
                  <td className="hide-sm">{t.sites.length ? t.sites.map((h) => <div key={h} className="sub">{h}</div>) : <span className="sub">—</span>}</td>
                  <td><div className="actions">
                    {running
                      ? <><Button size="sm" onClick={() => act(t, 'restart')}>Restart</Button><Button size="sm" onClick={() => act(t, 'stop')}>Stop</Button></>
                      : <Button size="sm" variant="primary" disabled={!t.credentials} onClick={() => act(t, 'start')}>Start</Button>}
                    <Button size="sm" onClick={() => open(<TunnelConfig name={t.name} />, { wide: true })}>Config</Button>
                    <Button size="sm" onClick={() => open(<Pm2LogsDialog name={prefix + t.name} />, { wide: true })}>Logs</Button>
                    {state?.settings.defaultTunnel !== t.name && <Button size="sm" onClick={() => act(t, 'default')}>Jadikan default</Button>}
                    <Button size="sm" variant="danger" onClick={() => open(<DeleteTunnel tunnel={t} />)}>Hapus</Button>
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table>
        ) : <Empty>Belum ada tunnel. Biasanya cukup <b>1 tunnel</b> untuk semua domain di Mac ini.</Empty>}
      </div>
      <p className="hint">Tunnel dijalankan via pm2 sebagai <code>{prefix}&lt;nama&gt;</code>, dengan endpoint metrics untuk Prometheus. Ingress dibuat otomatis dari daftar Domains.</p>
    </>
  );
}

function CreateTunnel() {
  const [name, setName] = useState('');
  const [start, setStart] = useState(true);
  const { close } = useDialog();
  const toast = useToast();
  const refresh = useRefresh();
  return (
    <Modal title="Buat tunnel" onSubmit={async () => {
      const r = await post<{ started: boolean }>('/api/tunnels', { name, start });
      close(); toast(`Tunnel dibuat${r.started ? ' & dijalankan' : ''}`, 'ok'); await refresh();
    }} footer={<><CancelButton /><SubmitButton>Buat</SubmitButton></>}>
      <Field label="Nama tunnel"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="macmini" pattern="[A-Za-z0-9_\-]+" required autoFocus /></Field>
      <Check checked={start} onChange={setStart}>Langsung jalankan via pm2</Check>
    </Modal>
  );
}

function TunnelConfig({ name }: { name: string }) {
  const [r, setR] = useState<{ text: string; file: string } | null>(null);
  useEffect(() => { void get<{ text: string; file: string }>(`/api/tunnels/${encodeURIComponent(name)}/config`).then(setR); }, [name]);
  return <Modal title={`Config ${name}`}>{r ? <><div className="sub mono mb">{r.file}</div><pre className="box">{r.text}</pre></> : <Empty>Memuat…</Empty>}</Modal>;
}

function DeleteTunnel({ tunnel: t }: { tunnel: TunnelView }) {
  const { data: state } = useAppState();
  const [dns, setDns] = useState(true);
  const { close } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  return (
    <Confirm title="Hapus tunnel" confirmLabel="Hapus tunnel" onConfirm={async () => {
      const r = await del(`/api/tunnels/${encodeURIComponent(t.name)}?dns=${dns ? 1 : 0}`);
      close(); report(r); await refresh();
    }}>
      <p>Hapus tunnel <b>{t.name}</b> dari Cloudflare? Proses pm2-nya ikut dihentikan.</p>
      {t.sites.length > 0 && <p className="hint">{t.sites.length} domain memakai tunnel ini dan akan dilepas (domain tetap ada, tinggal pilih tunnel lain).</p>}
      {state?.settings.cfApiTokenSet && t.sites.length > 0 && <Check checked={dns} onChange={setDns}>Hapus juga CNAME DNS milik domain tersebut</Check>}
    </Confirm>
  );
}
