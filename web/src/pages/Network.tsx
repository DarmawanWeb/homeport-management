import { useQuery } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import type { NetworkStatsDTO } from '../../../src/shared/types';
import { Chart } from '../components/Chart';
import { Badge, Button, Empty, Light, Loading, PageHead, Panel } from '../components/ui';
import { get } from '../lib/api';
import { ago, countryName, flag, fmtBytes, fmtBytesRate, fmtPct } from '../lib/format';

const useNetworkStats = () =>
  useQuery({ queryKey: ['network-stats'], queryFn: () => get<NetworkStatsDTO>('/api/network/stats'), refetchInterval: 15_000 });

/** Cloudflare data centre codes are IATA airport codes: SIN, CGK, NRT... */
const colo = (c: string) => c.replace(/\d+$/, '').toUpperCase();

export function Network() {
  const { data } = useNetworkStats();
  const [showIp, setShowIp] = useState(false);
  if (!data) return <Loading />;
  const net = data.internet;
  const now = data.throughput.at(-1);

  return (
    <div className="page">
      <PageHead
        title="Network"
        description="Traffic in and out of this machine, how well it reaches Cloudflare, and where your tunnels connect."
      />

      <section className="panel kpis">
        <div className="kpi">
          <span className="kpi-label">Internet</span>
          <span className="kpi-value">
            <Light tone={net.up == null ? undefined : net.up ? 'ok' : 'err'} label={net.up ? 'Online' : 'Offline'} />{' '}
            {net.up == null ? 'Checking' : net.up ? 'Online' : 'Offline'}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Latency to Cloudflare</span>
          <span className="kpi-value">{net.latencyMs != null ? `${Math.round(net.latencyMs)} ms` : '—'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Packet loss, 10 min</span>
          <span className="kpi-value">{fmtPct(net.lossPct)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">DNS lookup</span>
          <span className="kpi-value">{net.dnsMs != null ? `${net.dnsMs} ms` : '—'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Download now</span>
          <span className="kpi-value">{now ? fmtBytesRate(now.rx) : '—'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Upload now</span>
          <span className="kpi-value">{now ? fmtBytesRate(now.tx) : '—'}</span>
        </div>
      </section>

      <div className="cols">
        <Panel title="Throughput" description="All interfaces, last hour">
          <Chart
            format={fmtBytesRate}
            empty="Collecting the first samples"
            series={[
              { label: 'Download', points: data.throughput.map((p) => ({ t: p.t, v: p.rx })) },
              { label: 'Upload', points: data.throughput.map((p) => ({ t: p.t, v: p.tx })) },
            ]}
          />
        </Panel>
        <Panel title="Latency to Cloudflare" description="TCP connect time, every 30 seconds">
          <Chart
            format={(v) => `${Math.round(v)} ms`}
            empty="Collecting the first samples"
            series={[{ label: 'Latency', points: net.series.filter((p) => p.ms != null).map((p) => ({ t: p.t, v: p.ms! })) }]}
          />
        </Panel>
      </div>

      <div className="cols">
        <Panel title="Public address" description="As Cloudflare sees this machine">
          <dl className="kv">
            <dt>IP address</dt>
            <dd>
              {net.publicIp ? (
                <span className="btn-row">
                  <span className="code">{showIp ? net.publicIp : net.publicIp.replace(/[\da-f]+(?=[^.:]*$)/i, '•••')}</span>
                  <Button size="sm" variant="ghost" iconOnly icon={showIp ? <EyeOff /> : <Eye />} onClick={() => setShowIp(!showIp)}>
                    {showIp ? 'Hide' : 'Show'}
                  </Button>
                </span>
              ) : (
                '—'
              )}
            </dd>
            <dt>Location</dt>
            <dd>{net.country ? `${flag(net.country)} ${countryName(net.country)}` : '—'}</dd>
            <dt>Nearest Cloudflare</dt>
            <dd>{net.colo ? <Badge tone="sea">{colo(net.colo)}</Badge> : '—'}</dd>
            <dt>Checked</dt>
            <dd>{net.checkedAt ? ago(net.checkedAt) : 'not yet'}</dd>
          </dl>
        </Panel>
        <Panel title="Tunnel connections" description="Each tunnel keeps four connections to nearby Cloudflare data centres." flush>
          {data.tunnels.length === 0 ? (
            <Empty title="No tunnels running" />
          ) : (
            <table className="table">
              <tbody>
                {data.tunnels.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <Light tone={t.connections >= 4 ? 'ok' : t.connections > 0 ? 'warn' : 'err'} label={`${t.connections} connections`} />
                    </td>
                    <td>
                      <strong>{t.name}</strong>
                      <div className="sub">
                        {t.connections} of 4 connections{t.edges.length ? '' : t.connections ? '' : ', tunnel is not connected'}
                      </div>
                    </td>
                    <td className="right">
                      <span className="btn-row end">
                        {t.edges.map((e) => (
                          <Badge key={e} tone="sea">
                            {colo(e)}
                          </Badge>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="Interfaces" flush>
        {data.interfaces.length === 0 ? (
          <Empty title="No interface counters available" />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Interface</th>
                <th className="right">Download</th>
                <th className="right">Upload</th>
                <th className="right hide-sm">Received</th>
                <th className="right hide-sm">Sent</th>
              </tr>
            </thead>
            <tbody>
              {data.interfaces.map((i) => (
                <tr key={i.name}>
                  <td className="code">{i.name}</td>
                  <td className="right nowrap">{fmtBytesRate(i.rxRate)}</td>
                  <td className="right nowrap">{fmtBytesRate(i.txRate)}</td>
                  <td className="right hide-sm">{fmtBytes(i.rxTotal)}</td>
                  <td className="right hide-sm">{fmtBytes(i.txTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
