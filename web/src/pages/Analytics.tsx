import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Globe2, Laptop, MapPin, Monitor, Smartphone, Tablet } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useState } from 'react';
import type { AnalyticsDTO, AnalyticsRange, CountItem } from '../../../src/shared/types';
import { Chart } from '../components/Chart';
import { Empty, Loading, Notice, PageHead, Panel, Segmented } from '../components/ui';
import { get } from '../lib/api';
import { ago, countryName, dayLabel, delta, flag, fmtBytes, fmtCount, fmtPct, fmtSeconds } from '../lib/format';

const WorldMap = lazy(() => import('../components/WorldMap'));

const RANGES = [
  ['1h', '1 hour'],
  ['24h', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
] as const;

const useAnalytics = (range: AnalyticsRange, host: string) =>
  useQuery({
    queryKey: ['analytics', range, host],
    queryFn: () => get<AnalyticsDTO>(`/api/analytics?range=${range}&host=${encodeURIComponent(host)}`),
    refetchInterval: range === '1h' ? 10_000 : 30_000,
  });

/** A headline number with its change against the previous period. */
function Kpi({ label, value, change, inverse }: { label: string; value: string; change: number | null; inverse?: boolean }) {
  const good = change == null || change === 0 ? null : inverse ? change < 0 : change > 0;
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {change != null && Math.abs(change) >= 0.005 ? (
        <span className={`kpi-delta ${good ? 'up' : 'down'}`}>
          {change > 0 ? <ArrowUpRight /> : <ArrowDownRight />}
          {fmtPct(Math.abs(change) * 100)}
        </span>
      ) : (
        <span className="kpi-delta flat">no change</span>
      )}
    </div>
  );
}

/** Horizontal bars, the way analytics tools list top items. */
function Bars({
  items,
  label = (s) => s,
  icon,
  total,
}: {
  items: CountItem[];
  label?: (s: string) => ReactNode;
  icon?: (s: string) => ReactNode;
  total?: number;
}) {
  if (!items.length) return <p className="muted pad">Nothing yet</p>;
  const max = total ?? Math.max(...items.map((i) => i.count));
  return (
    <ul className="bars">
      {items.map((i) => (
        <li key={i.name}>
          <span className="bar" style={{ width: `${Math.max(2, (i.count / max) * 100)}%` }} />
          <span className="bar-label">
            {icon?.(i.name)}
            {label(i.name)}
          </span>
          <span className="bar-value">{fmtCount(i.count)}</span>
        </li>
      ))}
    </ul>
  );
}

const DEVICE_ICON: Record<string, ReactNode> = { desktop: <Monitor />, mobile: <Smartphone />, tablet: <Tablet />, bot: <Laptop /> };

export function Analytics() {
  const [range, setRange] = useState<AnalyticsRange>('24h');
  const [host, setHost] = useState('all');
  const { data, isLoading } = useAnalytics(range, host);
  if (isLoading || !data) return <Loading />;

  const t = data.totals;
  const p = data.previous;
  const timeFormat = range === '30d' || range === '7d' ? dayLabel : undefined;
  const statusItems = Object.entries(data.status).map(([name, count]) => ({ name, count }));
  const empty = t.requests === 0;

  return (
    <div className="page">
      <PageHead
        title="Analytics"
        description="Who visits your sites, from where and on what. No cookies and no tracking script; IP addresses are never stored."
        actions={
          <>
            <span className="live-pill" title="Unique visitors in the last 5 minutes">
              <i /> {data.live.activeNow} online now
            </span>
            <select className="compact" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Domain">
              <option value="all">All domains</option>
              {data.hosts.map((h) => (
                <option key={h}>{h}</option>
              ))}
            </select>
            <Segmented label="Time range" value={range} options={RANGES} onChange={setRange} />
          </>
        }
      />

      {!data.enabled && <Notice>Analytics is turned off in Settings. Caddy is not writing an access log.</Notice>}
      {data.enabled && !data.receiving && (
        <Notice>Waiting for the first visit. Caddy starts writing its access log as soon as one of your domains gets a request.</Notice>
      )}
      {data.receiving && !data.locationHeaders && t.requests > 0 && (
        <Notice icon={<MapPin />}>
          Countries come from Cloudflare automatically. For cities and the dots on the map, turn on{' '}
          <strong>Rules → Settings → Managed Transforms → Add visitor location headers</strong> for your zone in Cloudflare (free).
        </Notice>
      )}

      <section className="panel kpis">
        <Kpi label="Visitors" value={fmtCount(t.visitors)} change={delta(t.visitors, p.visitors)} />
        <Kpi label="Page views" value={fmtCount(t.pageviews)} change={delta(t.pageviews, p.pageviews)} />
        <Kpi label="Requests" value={fmtCount(t.requests)} change={delta(t.requests, p.requests)} />
        <Kpi label="Bandwidth" value={fmtBytes(t.bytes)} change={delta(t.bytes, p.bytes)} />
        <Kpi label="Server errors" value={fmtPct(t.errorRate * 100)} change={delta(t.errorRate, p.errorRate)} inverse />
        <Kpi label="p95 response" value={t.p95 ? fmtSeconds(t.p95) : '—'} change={delta(t.p95, p.p95)} inverse />
      </section>

      <Panel title="Traffic" description={range === '1h' ? 'Per minute' : range === '30d' ? 'Per day' : 'Per hour'}>
        <Chart
          height={220}
          timeFormat={timeFormat}
          format={(v) => fmtCount(v)}
          empty="No visits in this range yet"
          series={[
            { label: 'Visitors', points: data.series.map((s) => ({ t: s.t, v: s.visitors })) },
            { label: 'Page views', points: data.series.map((s) => ({ t: s.t, v: s.pageviews })) },
          ]}
        />
      </Panel>

      <div className="cols map-cols">
        <Panel title="Where visitors are" description={`${data.countries.length} countr${data.countries.length === 1 ? 'y' : 'ies'}`} flush>
          <Suspense fallback={<Loading />}>
            <WorldMap values={data.countries} cities={data.cities} />
          </Suspense>
        </Panel>
        <Panel title="Countries" flush>
          <Bars
            items={data.countries.slice(0, 12).map((c) => ({ name: c.code, count: c.visitors }))}
            icon={(c) => <span className="flag">{flag(c)}</span>}
            label={countryName}
          />
        </Panel>
      </div>

      {data.cities.length > 0 && (
        <Panel title="Cities" flush>
          <Bars
            items={data.cities.slice(0, 10).map((c) => ({ name: `${c.name}|${c.country}`, count: c.visitors }))}
            icon={(k) => <span className="flag">{flag(k.split('|')[1])}</span>}
            label={(k) => k.split('|')[0]}
          />
        </Panel>
      )}

      <div className="cols">
        <Panel title="Top pages" flush>
          <Bars items={data.pages} label={(s) => <span className="code">{s}</span>} />
        </Panel>
        <Panel title="Sources" description="Where visitors came from" flush>
          <Bars
            items={data.referrers}
            icon={(s) => (s === '(direct)' ? null : <Globe2 />)}
            label={(s) => (s === '(direct)' ? 'Direct or unknown' : s)}
          />
        </Panel>
      </div>

      <div className="cols-3">
        <Panel title="Devices" flush>
          <Bars items={data.devices} icon={(s) => DEVICE_ICON[s]} label={(s) => s[0].toUpperCase() + s.slice(1)} />
        </Panel>
        <Panel title="Browsers" flush>
          <Bars items={data.browsers} />
        </Panel>
        <Panel title="Operating systems" flush>
          <Bars items={data.os} />
        </Panel>
      </div>

      <div className="cols">
        <Panel title="Responses" description={`${fmtCount(data.bots)} requests from bots and crawlers are not counted as visitors.`} flush>
          <Bars items={statusItems} total={Math.max(1, t.requests)} label={(s) => <span className={`status-chip s${s[0]}`}>{s}</span>} />
        </Panel>
        <Panel title="Live" description="Latest page views" flush>
          {data.live.recent.length === 0 ? (
            <Empty title={empty ? 'No visits yet' : 'No page views in a while'} />
          ) : (
            <ul className="live-feed">
              {data.live.recent.slice(0, 12).map((r) => (
                <li key={`${r.ts}-${r.path}-${r.city}`}>
                  <span className="flag" title={countryName(r.country)}>
                    {flag(r.country)}
                  </span>
                  <div className="grow">
                    <span className="code">{r.path}</span>
                    <span className="sub">
                      {[r.city || countryName(r.country), r.browser, r.os, r.referrer && `from ${r.referrer}`].filter(Boolean).join(' · ')}
                      {host === 'all' ? ` · ${r.host}` : ''}
                    </span>
                  </div>
                  <span className="sub nowrap">{ago(r.ts)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
