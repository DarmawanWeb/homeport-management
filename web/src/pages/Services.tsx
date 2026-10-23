import { SetupBanners, type Page } from '../components/Layout';
import { Pm2LogsDialog } from '../components/Logs';
import { Button, Empty, Tag, Toolbar } from '../components/ui';
import { post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { fmtBytes, fmtUptime } from '../lib/format';
import { useAppState, useApps, usePm2, useRefresh, useStatus } from '../lib/queries';
import { useToast } from '../lib/toast';

export function Services({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { data: s } = useStatus();
  const { data: state } = useAppState();
  const { data: pm2 } = usePm2();
  const { data: apps } = useApps();
  const { open } = useDialog();
  const toast = useToast();
  const refresh = useRefresh();
  const st = state?.settings;

  const caddy = async (action: string) => {
    const r = await post<{ ok?: boolean; note?: string; reloaded?: boolean; reason?: string; output?: string }>(`/api/caddy/${action}`);
    if (action === 'validate') toast(r.ok ? 'Caddyfile valid ✓' : `Tidak valid:\n${r.output}`, r.ok ? 'ok' : 'err');
    else toast(r.note ?? r.reason ?? `Caddy: ${action} OK`, r.reloaded === false ? 'warn' : 'ok');
    setTimeout(() => void refresh('status', 'pm2'), 1200);
  };
  const pm2Act = async (name: string, action: string) => { await post(`/api/pm2/${encodeURIComponent(name)}/${action}`); toast(`${name}: ${action} OK`, 'ok'); await refresh('pm2', 'apps'); };
  const kind = (name: string) => apps?.apps.some((a) => a.name === name) ? 'app'
    : name === 'homeport' || name === st?.caddyPm2Name || name.startsWith(st?.tunnelPm2Prefix ?? '\0') || name.startsWith('hp-') ? 'system' : 'other';

  return (
    <>
      <SetupBanners onNavigate={onNavigate} />
      <div className="grid2 mb">
        <div className="card section">
          <h3>Caddy</h3>
          <div className="kv">
            <div><span className="k">Versi</span>{s?.caddy.version ?? 'tidak ditemukan'}</div>
            <div><span className="k">Admin API</span>{s?.caddy.adminUp ? <Tag tone="ok">jalan</Tag> : <Tag tone="err">mati</Tag>} <span className="sub">{st?.caddyAdmin}</span></div>
            <div><span className="k">Proxy</span>{s?.caddy.proxyUp ? <Tag tone="ok">listen :{st?.caddyHttpPort}</Tag> : <Tag tone="err">tidak listen</Tag>}</div>
            <div><span className="k">pm2</span>{s?.caddy.pm2 ? s.caddy.pm2.status : 'tidak dikelola pm2'}</div>
          </div>
          <div className="actions left">
            <Button size="sm" variant="primary" onClick={() => caddy('start')}>Start</Button>
            <Button size="sm" onClick={() => caddy('reload')}>Reload</Button>
            <Button size="sm" onClick={() => caddy('validate')}>Validate</Button>
            <Button size="sm" variant="danger" onClick={() => caddy('stop')}>Stop</Button>
            {s?.caddy.pm2 && st && <Button size="sm" onClick={() => open(<Pm2LogsDialog name={st.caddyPm2Name} />, { wide: true })}>Logs</Button>}
          </div>
        </div>
        <div className="card section">
          <h3>pm2</h3>
          <div className="kv"><div><span className="k">Versi</span>{s?.pm2.version ?? s?.pm2.error ?? '—'}</div></div>
          <p className="hint">Setelah semua jalan, klik <b>Simpan pm2</b>. Sekali saja jalankan <code>pm2 startup</code> di Terminal agar semua hidup lagi setelah Mac reboot.</p>
          <div className="actions left">
            <Button size="sm" variant="primary" onClick={async () => { await post('/api/pm2/save'); toast('pm2 save OK', 'ok'); }}>Simpan pm2</Button>
            <Button size="sm" onClick={() => refresh('pm2', 'status')}>⟳ Refresh</Button>
          </div>
        </div>
      </div>

      <Toolbar title="Proses pm2" count={pm2?.list.length} />
      <div className="card">
        {!pm2?.list.length ? <Empty>{pm2?.error ?? 'Tidak ada proses pm2'}</Empty> : (
          <table>
            <thead><tr><th>Nama</th><th>Status</th><th className="hide-sm">CPU / RAM</th><th className="hide-sm">Uptime</th><th /></tr></thead>
            <tbody>{pm2.list.map((p) => (
              <tr key={p.name}>
                <td><div className="host">{p.name} {kind(p.name) === 'system' && <Tag tone="acc">sistem</Tag>}{kind(p.name) === 'app' && <Tag>app</Tag>}</div><div className="sub">id {p.id}{p.port ? ` · PORT ${p.port}` : ''} · ↻{p.restarts}</div></td>
                <td><Tag tone={p.status === 'online' ? 'ok' : 'err'}>{p.status}</Tag></td>
                <td className="hide-sm">{p.cpu}% / {fmtBytes(p.mem)}</td>
                <td className="hide-sm">{p.status === 'online' && p.uptime ? fmtUptime((Date.now() - p.uptime) / 1000) : '—'}</td>
                <td><div className="actions">
                  <Button size="sm" onClick={() => pm2Act(p.name, 'restart')}>Restart</Button>
                  {p.status === 'online' ? <Button size="sm" onClick={() => pm2Act(p.name, 'stop')}>Stop</Button> : <Button size="sm" onClick={() => pm2Act(p.name, 'start')}>Start</Button>}
                  <Button size="sm" onClick={() => open(<Pm2LogsDialog name={p.name} />, { wide: true })}>Logs</Button>
                </div></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
