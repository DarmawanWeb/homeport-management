import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { UptimeDTO, UptimeHost } from '../../../src/shared/types';
import { Badge, Button, Empty, Field, Light, Loading, PageHead, Panel, Switch } from '../components/ui';
import { get, post, put } from '../lib/api';
import { ago, fmtDuration } from '../lib/format';
import { useAuth } from '../lib/queries';
import { useToast } from '../lib/toast';

const useUptime = () => useQuery({ queryKey: ['uptime'], queryFn: () => get<UptimeDTO>('/api/uptime'), refetchInterval: 30_000 });

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(v >= 0.9995 ? 2 : v >= 0.99 ? 2 : 1)}%`);

/** 90 days as bars, coloured like a status page. */
export function DayBars({ days }: { days: UptimeHost['days'] }) {
  return (
    <div className="daybars" role="img" aria-label="Uptime per day for the last 90 days">
      {days.map((d) => (
        <i
          key={d.day}
          data-s={d.uptime == null ? 'none' : d.uptime >= 0.999 ? 'ok' : d.uptime >= 0.98 ? 'warn' : 'err'}
          title={`${d.day}: ${d.uptime == null ? 'no data' : pct(d.uptime)}`}
        />
      ))}
    </div>
  );
}

/** Response time of the last checks. */
function Sparkline({ host }: { host: UptimeHost }) {
  const pts = host.recent.filter((c) => c.ms != null);
  if (pts.length < 2) return null;
  const max = Math.max(...pts.map((c) => c.ms!));
  const w = 160;
  const h = 32;
  const d = host.recent
    .map((c, i) => {
      const x = (i / Math.max(1, host.recent.length - 1)) * w;
      const y = c.ms == null ? h : h - 2 - ((c.ms ?? 0) / max) * (h - 4);
      return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join('');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function StatusPageSettings({ data }: { data: UptimeDTO }) {
  const sp = data.statusPage;
  const [title, setTitle] = useState(sp.title);
  const [hosts, setHosts] = useState<string[]>(sp.hosts);
  const toast = useToast();
  const qc = useQueryClient();
  const { data: auth } = useAuth();
  const save = async (patch: Partial<UptimeDTO['statusPage']>) => {
    await put('/api/settings', { statusPage: { ...patch } });
    await qc.invalidateQueries({ queryKey: ['uptime'] });
    toast('Status page saved', 'ok');
  };
  const base = auth?.publicUrls[0] ?? location.origin;
  return (
    <Panel
      title="Public status page"
      description="A page anyone can open, showing the uptime of the domains you pick. Nothing else about this machine is shown."
      actions={
        sp.enabled && (
          <a className="btn sm" href="/status" target="_blank" rel="noreferrer">
            Open <ExternalLink />
          </a>
        )
      }
    >
      <div className="form">
        <Switch checked={sp.enabled} onChange={(v) => save({ enabled: v })} hint={sp.enabled ? `${base}/status` : 'Off'}>
          Publish the status page
        </Switch>
        <div className="form-row">
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Agus's services" />
          </Field>
        </div>
        <fieldset className="checks">
          <legend>Domains shown (none ticked means all)</legend>
          {data.hosts.map((h) => (
            <label key={h.host}>
              <input
                type="checkbox"
                checked={hosts.includes(h.host)}
                onChange={(e) => setHosts(e.target.checked ? [...hosts, h.host] : hosts.filter((x) => x !== h.host))}
              />
              {h.host}
            </label>
          ))}
        </fieldset>
        <div className="btn-row">
          <Button onClick={() => save({ title, hosts })}>Save</Button>
        </div>
      </div>
    </Panel>
  );
}

export function Uptime() {
  const { data } = useUptime();
  const qc = useQueryClient();
  const toast = useToast();
  if (!data) return <Loading />;
  const up = data.hosts.filter((h) => h.state === 'up').length;
  const avg30 = data.hosts.map((h) => h.uptime30d).filter((v): v is number => v != null);
  const checkNow = async () => {
    qc.setQueryData(['uptime'], await post<UptimeDTO>('/api/uptime/check'));
    toast('Checked every domain', 'ok');
  };

  return (
    <div className="page">
      <PageHead
        title="Uptime"
        description={
          data.mode === 'public'
            ? 'Every domain is requested from the internet side once a minute: DNS, Cloudflare, the tunnel, Caddy and the app all have to answer.'
            : 'Every domain is checked once a minute through Caddy on this machine (local mode; change it in Settings).'
        }
        actions={
          <Button icon={<RefreshCw />} onClick={checkNow}>
            Check now
          </Button>
        }
      />

      <section className="panel kpis">
        <div className="kpi">
          <span className="kpi-label">Domains up</span>
          <span className="kpi-value">
            {up}
            <small> of {data.hosts.length}</small>
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Average uptime, 30 days</span>
          <span className="kpi-value">{avg30.length ? pct(avg30.reduce((a, b) => a + b, 0) / avg30.length) : '—'}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Open incidents</span>
          <span className="kpi-value">{data.incidents.filter((i) => i.end == null).length}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Incidents, 30 days</span>
          <span className="kpi-value">{data.incidents.filter((i) => i.start > Date.now() - 30 * 86_400_000).length}</span>
        </div>
      </section>

      {data.hosts.length === 0 ? (
        <Empty title="No domains to check">Add a domain and it is checked automatically.</Empty>
      ) : (
        <Panel title="Domains" flush>
          <ul className="uptime-list">
            {data.hosts.map((h) => (
              <li key={h.host}>
                <div className="uptime-head">
                  <Light tone={h.state === 'up' ? 'ok' : h.state === 'down' ? 'err' : undefined} label={h.state} />
                  <a href={`https://${h.host}`} target="_blank" rel="noreferrer" className="uptime-host">
                    {h.host}
                  </a>
                  {h.state === 'down' && <Badge tone="err">Down</Badge>}
                  <span className="grow" />
                  <Sparkline host={h} />
                  <span className="uptime-nums">
                    <b>{pct(h.uptime24h)}</b> 24h · <b>{pct(h.uptime7d)}</b> 7d · <b>{pct(h.uptime30d)}</b> 30d
                    {h.avgMs24h != null && <> · {h.avgMs24h} ms</>}
                  </span>
                </div>
                <DayBars days={h.days} />
                <div className="sub">
                  {h.last
                    ? `Checked ${ago(h.last.ts)}: ${h.last.ok ? `HTTP ${h.last.status} in ${h.last.ms} ms` : (h.last.error ?? 'failed')}`
                    : 'Not checked yet'}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="cols">
        <Panel title="Incidents" description="Two failed checks in a row open one; the next good check closes it." flush>
          {data.incidents.length === 0 ? (
            <Empty title="No incidents">Nothing has been down.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {data.incidents.slice(0, 15).map((i) => (
                  <tr key={`${i.host}-${i.start}`}>
                    <td>
                      <Light tone={i.end ? 'ok' : 'err'} label={i.end ? 'Resolved' : 'Ongoing'} />
                    </td>
                    <td>
                      <strong>{i.host}</strong>
                      <div className="sub">{i.cause}</div>
                    </td>
                    <td className="nowrap">{ago(i.start)}</td>
                    <td className="right nowrap">{i.end ? `lasted ${fmtDuration(i.end - i.start)}` : <Badge tone="err">Ongoing</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <StatusPageSettings data={data} />
      </div>
    </div>
  );
}
