import { useState } from 'react';
import { Chart } from '../components/Chart';
import { DeployLogDialog } from '../components/Logs';
import { SetupBanners, type Page } from '../components/Layout';
import { Bar, Empty, StatusTag, Tag, Toolbar } from '../components/ui';
import { ago, fmtBytes, fmtDuration, fmtUptime, shortSha } from '../lib/format';
import { useDialog } from '../lib/dialog';
import { useMetric, useMonitoring, useSystem } from '../lib/queries';

export const RANGES = [[3600, '1 jam'], [6 * 3600, '6 jam'], [86_400, '24 jam'], [7 * 86_400, '7 hari']] as const;

export function RangePicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="seg">
      {RANGES.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}
    </div>
  );
}

export function MetricCard({ title, preset, range, app, format, height }: { title: string; preset: string; range: number; app?: string; format?: (v: number) => string; height?: number }) {
  const { data } = useMetric(preset, range, app);
  return (
    <div className="card section">
      <h3>{title}</h3>
      <Chart series={data?.series ?? []} format={format} height={height} empty={data && !data.available ? data.error ?? 'Monitoring belum aktif' : 'Belum ada data'} />
    </div>
  );
}

export const fmtPct = (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}%`;
export const fmtReq = (v: number) => (v >= 10 ? v.toFixed(0) : v.toFixed(2));
export const fmtSec = (v: number) => (v >= 1 ? `${v.toFixed(1)}s` : `${(v * 1000).toFixed(0)}ms`);

export function Overview({ onNavigate }: { onNavigate: (p: Page) => void }) {
  const { data: s, error } = useSystem();
  const { data: mon } = useMonitoring();
  const { open } = useDialog();
  const [range, setRange] = useState(6 * 3600);
  if (error) return <Empty>{error.message}</Empty>;
  if (!s) return <Empty>Memuat…</Empty>;
  const memUsed = s.mem.total - s.mem.free;
  const firing = mon?.alerts.filter((a) => a.state === 'firing') ?? [];

  return (
    <>
      <SetupBanners onNavigate={onNavigate} />
      <div className="toolbar">
        <h2>{s.hostname}</h2>
        <span className="sub">{s.platform} · Node {s.node} · nyala {fmtUptime(s.uptime)}</span>
      </div>

      {firing.length > 0 && (
        <div className="card alerts">
          {firing.map((a) => (
            <div key={a.name + JSON.stringify(a.labels)} className={`alert ${a.severity}`}>
              <b>{a.name}</b> <span>{a.summary}</span> <span className="sub">sejak {ago(a.activeAt)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="tiles">
        <div className="card tile"><div className="k">CPU load (1m)</div><div className="v">{s.load[0]?.toFixed(2)}</div><div className="sub">{s.cpus} core · {s.cpuModel}</div><Bar value={(s.load[0] ?? 0) / s.cpus} /></div>
        <div className="card tile"><div className="k">Memori</div><div className="v">{fmtBytes(memUsed)}</div><div className="sub">dari {fmtBytes(s.mem.total)} · pm2 {fmtBytes(s.pm2.mem)}</div><Bar value={memUsed / s.mem.total} /></div>
        <div className="card tile"><div className="k">Disk</div><div className="v">{fmtBytes(s.disk?.avail)}</div><div className="sub">tersisa{s.disk ? ` dari ${fmtBytes(s.disk.total)}` : ''}</div>{s.disk && <Bar value={s.disk.used / s.disk.total} />}</div>
        <div className="card tile"><div className="k">Proses</div><div className="v">{s.pm2.online}<span className="sub" style={{ fontSize: 14 }}> / {s.pm2.total} online</span></div><div className="sub">{s.counts.apps} app · {s.counts.sites} domain</div></div>
      </div>

      {mon?.enabled ? (
        <>
          <div className="toolbar spaced"><h2>Metrics</h2><RangePicker value={range} onChange={setRange} /></div>
          <div className="grid2">
            <MetricCard title="CPU Mac mini" preset="hostCpu" range={range} format={fmtPct} />
            <MetricCard title="Request / detik per domain" preset="requests" range={range} format={fmtReq} />
            <MetricCard title="Memori per app" preset="appMem" range={range} format={fmtBytes} />
            <MetricCard title="CPU per app" preset="appCpu" range={range} format={fmtPct} />
          </div>
        </>
      ) : (
        <div className="card section hint-card">
          <b>Aktifkan monitoring</b> untuk grafik CPU, memori, traffic per domain dan alert otomatis (Prometheus + Grafana).
          <button className="btn sm primary" onClick={() => onNavigate('monitoring')}>Buka Monitoring</button>
        </div>
      )}

      <div className="toolbar spaced"><h2>Deploy terakhir</h2></div>
      <div className="card">
        {s.recentDeploys.length ? (
          <table><tbody>
            {s.recentDeploys.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => open(<DeployLogDialog id={d.id} />, { wide: true })}>
                <td><div className="host">{d.app}</div><div className="sub">{d.trigger}{d.pushedBy ? ` · ${d.pushedBy}` : ''}</div></td>
                <td className="hide-sm"><span className="mono">{shortSha(d.commit)}</span> <span className="sub">{d.msg ?? d.pushMsg ?? ''}</span></td>
                <td><StatusTag status={d.status} />{d.rolledBackTo && <> <Tag tone="warn">rollback</Tag></>}</td>
                <td className="sub right">{ago(d.finishedAt ?? d.createdAt)}<br />{fmtDuration(d.duration)}</td>
              </tr>
            ))}
          </tbody></table>
        ) : <Empty>Belum ada deploy</Empty>}
      </div>
    </>
  );
}
