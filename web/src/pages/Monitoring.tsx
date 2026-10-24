import { BellRing, ExternalLink, Power, RotateCw, ScrollText, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { ComponentKey } from '../../../src/shared/types';
import { Pm2LogsDialog } from '../components/Logs';
import { Badge, Button, CopyField, Empty, Field, Hint, Light, Loading, Modal, Notice, PageHead, Panel } from '../components/ui';
import { get, post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { ago, fmtPct, fmtRate, fmtSeconds } from '../lib/format';
import { useAppState, useMonitoring, useRefresh } from '../lib/queries';
import { useToast } from '../lib/toast';
import { MetricPanel, RangePicker, type RangeValue } from './Overview';

const PURPOSE: Record<ComponentKey, string> = {
  prometheus: 'Collects metrics every 15 seconds and evaluates alert rules.',
  grafana: 'Dashboards for history, provisioned automatically.',
  nodeExporter: 'Machine metrics: CPU, disks, network.',
};

export function Monitoring() {
  const { data: m, error } = useMonitoring();
  const { data: state } = useAppState();
  const hint = (k: ComponentKey | 'caddy') => state?.hints[k] ?? '';
  const { open } = useDialog();
  const toast = useToast();
  const refresh = useRefresh();
  const [range, setRange] = useState<RangeValue>(3600);
  if (error)
    return (
      <div className="page">
        <Notice tone="err">{error.message}</Notice>
      </div>
    );
  if (!m) return <Loading />;

  const start = async () => {
    const r = await post<{ notes: string[] }>('/api/monitoring/start');
    for (const n of r.notes) toast(n, 'warn', 8000);
    toast('Monitoring started', 'ok');
    setTimeout(() => void refresh('monitoring', 'pm2'), 3000);
  };
  const stop = async () => {
    await post('/api/monitoring/stop');
    toast('Monitoring stopped', 'ok');
    await refresh('monitoring', 'pm2');
  };
  const restart = async (key: ComponentKey) => {
    await post(`/api/monitoring/${key}/restart`);
    toast('Restarted', 'ok');
    setTimeout(() => void refresh('monitoring'), 2500);
  };
  const creds = async () => {
    const c = await get<{ user: string; password: string }>('/api/monitoring/credentials');
    open(
      <Modal title="Grafana admin sign-in">
        <div className="form">
          <Field label="Username">
            <CopyField value={c.user} />
          </Field>
          <Field label="Password">
            <CopyField value={c.password} code />
          </Field>
          <p className="hint">Dashboards are readable without signing in. The admin account is only for changing Grafana itself.</p>
        </div>
      </Modal>,
    );
  };

  const firing = m.alerts.filter((a) => a.state === 'firing');
  const pending = m.alerts.filter((a) => a.state === 'pending');
  const grafana = m.components.find((c) => c.key === 'grafana');

  return (
    <div className="page">
      <PageHead
        title="Monitoring"
        description="Prometheus records how apps, Caddy, tunnels and this machine behave over time. Alerts go to Discord or Telegram, set up in Settings."
        actions={
          m.enabled ? (
            <>
              {grafana?.running && (
                <a className="btn primary" href={`${m.grafanaUrl}/d/homeport-overview`} target="_blank" rel="noopener noreferrer">
                  Open Grafana <ExternalLink />
                </a>
              )}
              <a className="btn" href={`${m.prometheusUrl}/alerts`} target="_blank" rel="noopener noreferrer">
                Prometheus <ExternalLink />
              </a>
              <Button variant="danger" icon={<Power />} onClick={stop}>
                Turn off
              </Button>
            </>
          ) : (
            <Button variant="primary" icon={<Power />} onClick={start}>
              Turn on monitoring
            </Button>
          )
        }
      />

      <div className="stack">
        {!m.enabled && (
          <Notice>
            Turning it on starts three processes under pm2, all bound to 127.0.0.1, using about 300 MB of memory.
            {state?.flavor === 'docker' ? (
              <> Prometheus and node_exporter are in the image. Grafana is not; the charts below cover the same metrics.</>
            ) : (
              <>
                {' '}
                Install them first: <code>{hint('prometheus')}</code>, <code>{hint('nodeExporter')}</code> and{' '}
                <code>{hint('grafana')}</code>.
              </>
            )}
          </Notice>
        )}

        <div className="cols-3">
          {m.components.map((c) => (
            <Panel key={c.key}>
              <div className="stack" style={{ gap: 10 }}>
                <div className="btn-row" style={{ gap: 10 }}>
                  <Light tone={!c.installed ? 'err' : c.running ? 'ok' : m.enabled ? 'warn' : undefined} />
                  <h3 style={{ fontSize: 'var(--t-lg)' }}>{c.label}</h3>
                  <span className="muted right-push">{c.version ? `v${c.version}` : ''}</span>
                </div>
                <p className="muted" style={{ fontSize: 'var(--t-sm)' }}>
                  {PURPOSE[c.key]}
                </p>
                {!c.installed ? (
                  <Hint text={hint(c.key)} />
                ) : (
                  <div className="btn-row">
                    <span className="muted code" style={{ fontSize: 'var(--t-xs)' }}>
                      127.0.0.1:{c.port}
                    </span>
                    {m.enabled && (
                      <>
                        <Button size="sm" icon={<RotateCw />} className="right-push" onClick={() => restart(c.key)}>
                          Restart
                        </Button>
                        <Button
                          size="sm"
                          iconOnly
                          icon={<ScrollText />}
                          onClick={() => open(<Pm2LogsDialog name={c.pm2Name} />, { wide: true })}
                        >
                          Logs for {c.label}
                        </Button>
                        {c.key === 'grafana' && (
                          <Button size="sm" iconOnly icon={<ShieldCheck />} onClick={creds}>
                            Admin sign-in
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </Panel>
          ))}
        </div>

        {m.enabled && (
          <>
            <Panel
              title="Alerts"
              description={
                firing.length
                  ? `${firing.length} firing${pending.length ? `, ${pending.length} pending` : ''}`
                  : pending.length
                    ? `${pending.length} pending, nothing firing yet`
                    : 'Nothing is firing'
              }
              flush
            >
              {m.alerts.length === 0 ? (
                <Empty icon={<BellRing />} title="All quiet">
                  Rules cover apps that stop answering, crash loops, tunnels losing Cloudflare, 5xx spikes, and a full disk.
                </Empty>
              ) : (
                [...firing, ...pending].map((a) => (
                  <div key={a.name + JSON.stringify(a.labels)} className="alert-row">
                    <Light tone={a.state === 'firing' ? (a.severity === 'critical' ? 'err' : 'warn') : undefined} />
                    <div style={{ flex: 1 }}>
                      <strong>{a.summary || a.name}</strong>
                      <span className="sub">
                        {a.name}, {a.state === 'firing' ? 'firing' : 'pending'} since {ago(a.activeAt)}
                      </span>
                    </div>
                    <Badge tone={a.severity === 'critical' ? 'err' : 'warn'}>{a.severity}</Badge>
                  </div>
                ))
              )}
            </Panel>

            <div className="btn-row">
              <h2 style={{ fontSize: 'var(--t-xl)' }}>History</h2>
              <span className="right-push" />
              <RangePicker value={range} onChange={setRange} />
            </div>
            <div className="cols">
              <MetricPanel title="Requests per second, by domain" preset="requests" range={range} format={fmtRate} />
              <MetricPanel title="Response time, 95th percentile" preset="latency" range={range} format={fmtSeconds} />
              <MetricPanel title="Server errors per second" preset="errors" range={range} format={fmtRate} />
              <MetricPanel title="Tunnel connections to Cloudflare" preset="tunnel" range={range} format={(v) => v.toFixed(0)} />
              <MetricPanel title="CPU on this machine" preset="hostCpu" range={range} format={fmtPct} />
              <MetricPanel title="CPU by app" preset="appCpu" range={range} format={fmtPct} />
            </div>

            <Panel title="Scrape targets" description="Where Prometheus pulls metrics from." flush>
              {m.caddyMetrics === 'none' && (
                <div style={{ padding: '14px 18px 0' }}>
                  <Notice>
                    This Caddy version has no HTTP metrics. Update it: <Hint text={hint('caddy')} />.
                  </Notice>
                </div>
              )}
              {m.targets.length ? (
                <table className="table">
                  <tbody>
                    {m.targets.map((t) => (
                      <tr key={t.job + t.instance}>
                        <td className="primary-cell">
                          {t.job}
                          <span className="sub code">{t.instance}</span>
                          {t.lastError && (
                            <span className="sub" style={{ color: 'var(--port)' }}>
                              {t.lastError}
                            </span>
                          )}
                        </td>
                        <td className="right">
                          <Badge tone={t.health === 'up' ? 'ok' : t.health === 'down' ? 'err' : undefined} light>
                            {t.health}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <Empty title="Prometheus is not running" />
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
