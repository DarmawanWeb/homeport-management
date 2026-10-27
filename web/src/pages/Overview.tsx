import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, BellRing } from 'lucide-react';
import { useState } from 'react';
import type { AnalyticsDTO, UptimeDTO } from '../../../src/shared/types';
import { Chart } from '../components/Chart';
import { DeployLogDialog } from '../components/Logs';
import { RouteMap } from '../components/RouteMap';
import { SetupNotices } from '../components/Shell';
import { DeployBadge, Empty, Meter, PageHead, Panel, Segmented } from '../components/ui';
import { get } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { ago, countryName, delta, flag, fmtBytes, fmtCount, fmtPct, fmtRate, fmtUptime, shortSha } from '../lib/format';
import { useMetric, useMonitoring, useSystem } from '../lib/queries';

export const RANGES = [
  [3600, '1h'],
  [6 * 3600, '6h'],
  [86_400, '24h'],
  [7 * 86_400, '7d'],
] as const;
export type RangeValue = (typeof RANGES)[number][0];

export function RangePicker({ value, onChange }: { value: RangeValue; onChange: (v: RangeValue) => void }) {
  return <Segmented label="Time range" value={value} options={RANGES} onChange={onChange} />;
}

export function MetricPanel({
  title,
  preset,
  range,
  app,
  format,
}: {
  title: string;
  preset: string;
  range: number;
  app?: string;
  format?: (v: number) => string;
}) {
  const { data } = useMetric(preset, range, app);
  return (
    <Panel title={title}>
      <Chart
        series={data?.series ?? []}
        format={format}
        empty={data && !data.available ? (data.error ?? 'Monitoring is off') : 'No data in this range yet'}
      />
    </Panel>
  );
}

/** Visitors and uptime in one strip, linking to the full pages. */
function AtAGlance() {
  const { data: a } = useQuery({
    queryKey: ['analytics', '24h', 'all'],
    queryFn: () => get<AnalyticsDTO>('/api/analytics?range=24h&host=all'),
    refetchInterval: 30_000,
  });
  const { data: u } = useQuery({ queryKey: ['uptime'], queryFn: () => get<UptimeDTO>('/api/uptime'), refetchInterval: 60_000 });
  if (!a || !u) return null;
  const up = u.hosts.filter((h) => h.state === 'up').length;
  const day = u.hosts.map((h) => h.uptime24h).filter((v): v is number => v != null);
  const change = delta(a.totals.visitors, a.previous.visitors);
  return (
    <section className="panel kpis glance">
      <a className="kpi" href="#/analytics">
        <span className="kpi-label">Visitors, 24 h</span>
        <span className="kpi-value">{fmtCount(a.totals.visitors)}</span>
        <span className="kpi-delta flat">
          {change == null ? 'first day' : `${change >= 0 ? '+' : '−'}${fmtPct(Math.abs(change) * 100)} vs day before`}
        </span>
      </a>
      <a className="kpi" href="#/analytics">
        <span className="kpi-label">Online now</span>
        <span className="kpi-value">{a.live.activeNow}</span>
        <span className="kpi-delta flat">
          {a.countries[0] ? `most from ${flag(a.countries[0].code)} ${countryName(a.countries[0].code)}` : 'no visits yet'}
        </span>
      </a>
      <a className="kpi" href="#/uptime">
        <span className="kpi-label">Domains up</span>
        <span className="kpi-value">
          {up}
          <small> of {u.hosts.length}</small>
        </span>
        <span className="kpi-delta flat">
          {day.length ? `${((day.reduce((x, y) => x + y, 0) / day.length) * 100).toFixed(2)}% over 24 h` : 'not checked yet'}
        </span>
      </a>
      <a className="kpi" href="#/analytics">
        <span className="kpi-label">Bandwidth, 24 h</span>
        <span className="kpi-value">{fmtBytes(a.totals.bytes)}</span>
        <span className="kpi-delta flat">{fmtCount(a.totals.requests)} requests</span>
      </a>
    </section>
  );
}

export function Overview() {
  const { data: s } = useSystem();
  const { data: mon } = useMonitoring();
  const { open } = useDialog();
  const [range, setRange] = useState<RangeValue>(6 * 3600);
  const firing = mon?.alerts.filter((a) => a.state === 'firing') ?? [];
  const memUsed = s ? s.mem.total - s.mem.free : 0;

  return (
    <div className="page">
      <PageHead
        title="Overview"
        description={
          s
            ? `How a request reaches your apps on ${s.hostname}, and how the machine is holding up. Up for ${fmtUptime(s.uptime)}.`
            : 'Loading…'
        }
      />
      <SetupNotices />
      <div className="stack">
        <Panel
          title="Traffic route"
          description="Left to right is the path every request takes. The first red light is where to look."
          flush
        >
          <RouteMap />
        </Panel>

        <AtAGlance />

        {firing.length > 0 && (
          <Panel
            title="Needs attention"
            actions={
              <a className="btn sm" href="#/monitoring">
                All alerts
              </a>
            }
            flush
          >
            {firing.map((a) => (
              <div key={a.name + JSON.stringify(a.labels)} className="alert-row">
                <BellRing size={16} color={a.severity === 'critical' ? 'var(--port)' : 'var(--buoy)'} />
                <div>
                  <strong>{a.summary || a.name}</strong>
                  <span className="sub">
                    {a.name}, since {ago(a.activeAt)}
                  </span>
                </div>
              </div>
            ))}
          </Panel>
        )}

        {s && (
          <Panel title="This machine" description={`${s.platform}, Node ${s.node}`} flush>
            <div className="gauges">
              <div className="gauge">
                <span className="gauge-label">CPU load</span>
                <span className="gauge-value">
                  {s.load[0]?.toFixed(2)}
                  <small>of {s.cpus} cores</small>
                </span>
                <Meter value={(s.load[0] ?? 0) / s.cpus} />
              </div>
              <div className="gauge">
                <span className="gauge-label">Memory in use</span>
                <span className="gauge-value">
                  {fmtBytes(memUsed)}
                  <small>of {fmtBytes(s.mem.total)}</small>
                </span>
                <Meter value={memUsed / s.mem.total} />
              </div>
              <div className="gauge">
                <span className="gauge-label">Disk free</span>
                <span className="gauge-value">
                  {fmtBytes(s.disk?.avail)}
                  {s.disk && <small>of {fmtBytes(s.disk.total)}</small>}
                </span>
                {s.disk && <Meter value={s.disk.used / s.disk.total} />}
              </div>
              <div className="gauge">
                <span className="gauge-label">Processes online</span>
                <span className="gauge-value">
                  {s.pm2.online}
                  <small>
                    of {s.pm2.total}, using {fmtBytes(s.pm2.mem)}
                  </small>
                </span>
                <Meter value={s.pm2.total ? s.pm2.online / s.pm2.total : 0} />
              </div>
            </div>
          </Panel>
        )}

        <div className="cols">
          <Panel title="Recent deploys" flush>
            {s?.recentDeploys.length ? (
              <table className="table">
                <tbody>
                  {s.recentDeploys.map((d) => (
                    <tr key={d.id} className="link" onClick={() => open(<DeployLogDialog id={d.id} />, { wide: true })}>
                      <td>
                        <span className="primary-cell">{d.app}</span>
                        <span className="sub ellipsis" style={{ maxWidth: 260 }}>
                          <span className="code">{shortSha(d.commit) || 'pending'}</span> {d.msg ?? d.pushMsg ?? ''}
                          <span className="show-sm">, {ago(d.finishedAt ?? d.createdAt)}</span>
                        </span>
                      </td>
                      <td>
                        <DeployBadge status={d.status} rolledBack={!!d.rolledBackTo} />
                      </td>
                      <td className="right muted nowrap hide-sm">{ago(d.finishedAt ?? d.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty title="No deploys yet">Deploys appear here as soon as an app is created or a push arrives.</Empty>
            )}
          </Panel>

          {mon?.enabled ? (
            <Panel title="Requests per second" actions={<RangePicker value={range} onChange={setRange} />}>
              <MetricChart preset="requests" range={range} format={fmtRate} />
              <div style={{ height: 18 }} />
              <h3 style={{ fontSize: 'var(--t-md)', marginBottom: 8 }}>CPU on this machine</h3>
              <MetricChart preset="hostCpu" range={range} format={fmtPct} height={110} />
            </Panel>
          ) : (
            <Panel title="Metrics">
              <Empty
                title="Monitoring is off"
                action={
                  <a className="btn primary" href="#/monitoring">
                    Set up monitoring <ArrowUpRight />
                  </a>
                }
              >
                Turn it on for traffic per domain, latency, per-app CPU and memory, and alerts sent to Discord or Telegram.
              </Empty>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricChart({ preset, range, format, height }: { preset: string; range: number; format: (v: number) => string; height?: number }) {
  const { data } = useMetric(preset, range);
  return (
    <Chart
      series={data?.series ?? []}
      format={format}
      height={height}
      empty={data && !data.available ? (data.error ?? 'No data') : 'No data in this range yet'}
    />
  );
}
