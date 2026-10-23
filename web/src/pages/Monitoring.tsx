import { useState } from 'react';
import { Pm2LogsDialog } from '../components/Logs';
import { Banner, Button, CopyField, Empty, Field, Modal, Pill, Tag, Toolbar } from '../components/ui';
import { get, post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { ago } from '../lib/format';
import { useMonitoring, useRefresh } from '../lib/queries';
import { useToast } from '../lib/toast';
import { MetricCard, RangePicker, fmtPct, fmtReq, fmtSec } from './Overview';
import type { ComponentKey } from '../../../src/shared/types';

const INSTALL: Record<ComponentKey, string> = { prometheus: 'brew install prometheus', grafana: 'brew install grafana', nodeExporter: 'brew install node_exporter' };

export function Monitoring() {
  const { data: m, error } = useMonitoring();
  const { open } = useDialog();
  const toast = useToast();
  const refresh = useRefresh();
  const [range, setRange] = useState(3600);
  if (error) return <Empty>{error.message}</Empty>;
  if (!m) return <Empty>Memuat…</Empty>;

  const start = async () => {
    const r = await post<{ notes: string[] }>('/api/monitoring/start');
    r.notes.forEach((n) => toast(n, 'warn', 8000));
    toast('Monitoring dijalankan', 'ok');
    setTimeout(() => void refresh('monitoring', 'pm2'), 3000);
  };
  const stop = async () => { await post('/api/monitoring/stop'); toast('Monitoring dihentikan', 'ok'); await refresh('monitoring', 'pm2'); };
  const restart = async (key: ComponentKey) => { await post(`/api/monitoring/${key}/restart`); toast(`${key} di-restart`, 'ok'); setTimeout(() => void refresh('monitoring'), 2500); };
  const showCreds = async () => {
    const c = await get<{ user: string; password: string }>('/api/monitoring/credentials');
    open(<Modal title="Login admin Grafana"><Field label="User"><CopyField value={c.user} /></Field><Field label="Password"><CopyField value={c.password} mono /></Field>
      <p className="hint">Tanpa login pun dashboard bisa dilihat (mode viewer). Login admin hanya untuk mengubah pengaturan Grafana. Password berlaku sejak Grafana pertama kali dijalankan.</p></Modal>);
  };

  const firing = m.alerts.filter((a) => a.state === 'firing');
  const pending = m.alerts.filter((a) => a.state === 'pending');
  const grafana = m.components.find((c) => c.key === 'grafana');

  return (
    <>
      <Toolbar title="Monitoring">
        {m.enabled ? <>
          {grafana?.running && <a className="btn primary" href={`${m.grafanaUrl}/d/homeport-overview`} target="_blank" rel="noopener noreferrer">Buka Grafana ↗</a>}
          <a className="btn" href={`${m.prometheusUrl}/alerts`} target="_blank" rel="noopener noreferrer">Prometheus ↗</a>
          <Button variant="danger" onClick={stop}>Matikan</Button>
        </> : <Button variant="primary" onClick={start}>Aktifkan monitoring</Button>}
      </Toolbar>

      {!m.enabled && (
        <div className="card section mb">
          <p style={{ marginTop: 0 }}>Monitoring menjalankan tiga komponen lewat pm2, semuanya hanya di <code>127.0.0.1</code>:</p>
          <ul className="list">
            <li><b>Prometheus</b> mengumpulkan metrics tiap 15 detik dari Homeport (app, deploy, pm2), Caddy (traffic per domain), cloudflared (koneksi tunnel) dan node_exporter (CPU, disk, jaringan), lalu mengevaluasi aturan alert.</li>
            <li><b>Grafana</b> menampilkan dashboard “Homeport — Overview” dan “Homeport — Mac mini” yang langsung tersedia.</li>
            <li><b>Alert</b> dikirim ke Discord/Telegram (atur di Settings → Notifikasi).</li>
          </ul>
          <p className="hint">Butuh sekitar 300 MB RAM. Pasang dulu: <code>brew install prometheus grafana node_exporter</code></p>
        </div>
      )}

      <div className="tiles mb">
        {m.components.map((c) => (
          <div key={c.key} className="card tile">
            <div className="k">{c.label}</div>
            <div className="comp">
              <Pill state={!c.installed ? 'err' : c.running ? 'ok' : m.enabled ? 'warn' : ''}>{!c.installed ? 'belum terpasang' : c.running ? 'jalan' : 'mati'}</Pill>
              <span className="sub">{c.version ? `v${c.version}` : ''} · :{c.port}</span>
            </div>
            {!c.installed && <div className="sub mono">{INSTALL[c.key]}</div>}
            {m.enabled && c.installed && <div className="actions left">
              <Button size="sm" onClick={() => restart(c.key)}>Restart</Button>
              <Button size="sm" onClick={() => open(<Pm2LogsDialog name={c.pm2Name} />, { wide: true })}>Logs</Button>
              {c.key === 'grafana' && <Button size="sm" onClick={showCreds}>Login admin</Button>}
            </div>}
          </div>
        ))}
      </div>

      {m.enabled && <>
        <Toolbar title={`Alert ${firing.length ? `(${firing.length} aktif)` : ''}`} />
        <div className="card mb">
          {m.alerts.length === 0 ? <Empty>✓ Tidak ada alert. Semua sehat.</Empty> : (
            <table><tbody>{[...firing, ...pending].map((a) => (
              <tr key={a.name + JSON.stringify(a.labels)}>
                <td><b>{a.name}</b><div className="sub">{a.summary}</div></td>
                <td><Tag tone={a.state === 'firing' ? (a.severity === 'critical' ? 'err' : 'warn') : undefined}>{a.state === 'firing' ? a.severity : 'pending'}</Tag></td>
                <td className="sub right">sejak {ago(a.activeAt)}</td>
              </tr>
            ))}</tbody></table>
          )}
        </div>

        <div className="toolbar spaced"><h2>Grafik</h2><RangePicker value={range} onChange={setRange} /></div>
        <div className="grid2 mb">
          <MetricCard title="Request / detik per domain" preset="requests" range={range} format={fmtReq} />
          <MetricCard title="Latensi p95" preset="latency" range={range} format={fmtSec} />
          <MetricCard title="Error 5xx / detik" preset="errors" range={range} format={fmtReq} />
          <MetricCard title="Koneksi tunnel ke Cloudflare" preset="tunnel" range={range} format={(v) => v.toFixed(0)} />
          <MetricCard title="CPU Mac mini" preset="hostCpu" range={range} format={fmtPct} />
          <MetricCard title="CPU per app" preset="appCpu" range={range} format={fmtPct} />
        </div>

        <Toolbar title="Target scrape" />
        {m.caddyMetrics === 'none' && <Banner>Versi Caddy ini tidak mendukung metrics HTTP. Update Caddy: <code>brew upgrade caddy</code></Banner>}
        <div className="card">
          {m.targets.length ? <table><tbody>{m.targets.map((t) => (
            <tr key={t.job + t.instance}>
              <td><b>{t.job}</b> <span className="sub mono">{t.instance}</span>{t.lastError && <div className="sub err-text">{t.lastError}</div>}</td>
              <td className="right"><Tag tone={t.health === 'up' ? 'ok' : t.health === 'down' ? 'err' : undefined}>{t.health}</Tag></td>
            </tr>
          ))}</tbody></table> : <Empty>Prometheus belum jalan</Empty>}
        </div>
      </>}
    </>
  );
}
