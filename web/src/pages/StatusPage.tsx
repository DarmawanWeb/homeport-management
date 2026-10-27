import { useQuery } from '@tanstack/react-query';
import type { PublicStatusDTO } from '../../../src/shared/types';
import { BrandMark } from '../components/Shell';
import { Light, Loading } from '../components/ui';
import { ApiError, get } from '../lib/api';
import { ago, fmtDuration } from '../lib/format';
import { DayBars } from './Uptime';

const HEADLINE: Record<PublicStatusDTO['state'], string> = {
  operational: 'All systems operational',
  degraded: 'Some services are down',
  down: 'Major outage',
  unknown: 'Checking…',
};

/** The public status page at /status: no sign-in, only what the owner chose to show. */
export function StatusPage() {
  const { data, error } = useQuery({
    queryKey: ['public-status'],
    queryFn: () => get<PublicStatusDTO>('/api/public/status'),
    refetchInterval: 60_000,
    retry: false,
  });
  if (error instanceof ApiError && error.status === 404)
    return (
      <div className="status-page">
        <p className="muted">There is no public status page here.</p>
      </div>
    );
  if (!data) return <Loading />;
  document.title = data.title;
  const tone = data.state === 'operational' ? 'ok' : data.state === 'unknown' ? undefined : 'err';
  return (
    <div className="status-page">
      <header>
        <BrandMark />
        <h1>{data.title}</h1>
      </header>
      <div className={`status-banner ${data.state}`}>
        <Light tone={tone} label={HEADLINE[data.state]} />
        {HEADLINE[data.state]}
      </div>
      <section className="panel">
        <ul className="uptime-list">
          {data.hosts.map((h) => (
            <li key={h.host}>
              <div className="uptime-head">
                <Light tone={h.state === 'up' ? 'ok' : h.state === 'down' ? 'err' : undefined} label={h.state} />
                <span className="uptime-host">{h.host}</span>
                <span className="grow" />
                <span className="uptime-nums">
                  <b>{h.uptime30d == null ? '—' : `${(h.uptime30d * 100).toFixed(2)}%`}</b> uptime, 30 days
                </span>
              </div>
              <DayBars days={h.days} />
              <div className="daybars-axis">
                <span>90 days ago</span>
                <span>Today</span>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {data.incidents.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Recent incidents</h2>
          </div>
          <ul className="incident-list">
            {data.incidents.map((i) => (
              <li key={`${i.host}-${i.start}`}>
                <strong>{i.host}</strong> {i.end ? `was down for ${fmtDuration(i.end - i.start)}` : 'is down'}
                <span className="muted"> · {ago(i.start)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <footer className="sub">
        Updated {ago(data.updatedAt)} · Powered by <a href="https://github.com/DarmawanWeb/homeport-management">Homeport</a>
      </footer>
    </div>
  );
}
