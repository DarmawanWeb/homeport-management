import { Play, RotateCw, ShieldCheck, Square } from 'lucide-react';
import { Pm2LogsDialog } from '../components/Logs';
import { SetupNotices } from '../components/Shell';
import { Badge, Button, Empty, Light, PageHead, Panel } from '../components/ui';
import { post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { fmtBytes, fmtPct, fmtUptime } from '../lib/format';
import { useAppState, useApps, usePm2, useRefresh, useStatus } from '../lib/queries';
import { useToast } from '../lib/toast';

export function Services() {
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
    if (action === 'validate') toast(r.ok ? 'The Caddyfile is valid' : `Caddy rejected the config:\n${r.output}`, r.ok ? 'ok' : 'err');
    else toast(r.note ?? r.reason ?? `Caddy ${action === 'stop' ? 'stopped' : 'reloaded'}`, r.reloaded === false ? 'warn' : 'ok');
    setTimeout(() => void refresh('status', 'pm2'), 1200);
  };
  const pm2Act = async (name: string, action: string) => {
    await post(`/api/pm2/${encodeURIComponent(name)}/${action}`);
    toast(`${name}: ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`, 'ok');
    await refresh('pm2', 'apps');
  };
  const kind = (name: string) =>
    apps?.apps.some((a) => a.name === name)
      ? 'App'
      : name === 'homeport' || name === st?.caddyPm2Name || name.startsWith(st?.tunnelPm2Prefix ?? '\0') || name.startsWith('hp-')
        ? 'System'
        : null;

  return (
    <div className="page">
      <PageHead
        title="Services"
        description="Everything pm2 keeps alive on this machine: your apps, the Caddy proxy, tunnels and monitoring."
      />
      <SetupNotices />
      <div className="stack">
        <div className="cols">
          <Panel
            title="Caddy"
            description="Reverse proxy that routes each hostname to its port."
            actions={
              st && s?.caddy.pm2 ? (
                <Button size="sm" onClick={() => open(<Pm2LogsDialog name={st.caddyPm2Name} />, { wide: true })}>
                  Logs
                </Button>
              ) : null
            }
          >
            <div className="stack" style={{ gap: 16 }}>
              <dl className="kv">
                <dt>Version</dt>
                <dd>{s?.caddy.version ?? 'Not installed'}</dd>
                <dt>Admin API</dt>
                <dd className="btn-row" style={{ gap: 8 }}>
                  <Light tone={s?.caddy.adminUp ? 'ok' : 'err'} /> {s?.caddy.adminUp ? 'Answering' : 'Not answering'}{' '}
                  <span className="code muted">{st?.caddyAdmin}</span>
                </dd>
                <dt>Proxy</dt>
                <dd className="btn-row" style={{ gap: 8 }}>
                  <Light tone={s?.caddy.proxyUp ? 'ok' : 'err'} /> {s?.caddy.proxyUp ? 'Listening' : 'Not listening'}{' '}
                  <span className="code muted">:{st?.caddyHttpPort}</span>
                </dd>
              </dl>
              <div className="btn-row">
                <Button variant="primary" icon={<Play />} onClick={() => caddy('start')}>
                  Start
                </Button>
                <Button icon={<RotateCw />} onClick={() => caddy('reload')}>
                  Reload
                </Button>
                <Button icon={<ShieldCheck />} onClick={() => caddy('validate')}>
                  Validate
                </Button>
                <Button variant="danger" icon={<Square />} onClick={() => caddy('stop')}>
                  Stop
                </Button>
              </div>
            </div>
          </Panel>
          <Panel title="pm2" description="Process manager that restarts anything that crashes.">
            <div className="stack" style={{ gap: 16 }}>
              <dl className="kv">
                <dt>Version</dt>
                <dd>{s?.pm2.version ?? s?.pm2.error ?? '—'}</dd>
                <dt>After a reboot</dt>
                <dd>
                  Run <span className="code">pm2 startup</span> once in a terminal, then save the process list here.
                </dd>
              </dl>
              <div className="btn-row">
                <Button
                  variant="primary"
                  onClick={async () => {
                    await post('/api/pm2/save');
                    toast('Process list saved. It will be restored after a reboot.', 'ok');
                  }}
                >
                  Save process list
                </Button>
              </div>
            </div>
          </Panel>
        </div>

        <Panel
          title="Processes"
          description={pm2 ? `${pm2.list.filter((p) => p.status === 'online').length} of ${pm2.list.length} online` : undefined}
          flush
        >
          {!pm2?.list.length ? (
            <Empty title="No pm2 processes">{pm2?.error ?? 'Nothing is running under pm2 yet.'}</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Process</th>
                  <th>Status</th>
                  <th className="hide-sm">CPU</th>
                  <th className="hide-sm">Memory</th>
                  <th className="hide-sm">Uptime</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pm2.list.map((p) => {
                  const k = kind(p.name);
                  return (
                    <tr key={`${p.id}-${p.name}`}>
                      <td className="primary-cell">
                        {p.name} {k && <Badge tone={k === 'App' ? 'sea' : undefined}>{k}</Badge>}
                        <span className="sub">
                          {p.port ? `PORT ${p.port}, ` : ''}
                          {p.restarts} restart{p.restarts === 1 ? '' : 's'}
                        </span>
                      </td>
                      <td>
                        <Badge tone={p.status === 'online' ? 'ok' : 'err'} light>
                          {p.status}
                        </Badge>
                      </td>
                      <td className="hide-sm">{fmtPct(p.cpu)}</td>
                      <td className="hide-sm">{fmtBytes(p.mem)}</td>
                      <td className="hide-sm">{p.status === 'online' && p.uptime ? fmtUptime((Date.now() - p.uptime) / 1000) : '—'}</td>
                      <td>
                        <div className="row-actions">
                          <Button size="sm" onClick={() => pm2Act(p.name, 'restart')}>
                            Restart
                          </Button>
                          {p.status === 'online' ? (
                            <Button size="sm" onClick={() => pm2Act(p.name, 'stop')}>
                              Stop
                            </Button>
                          ) : (
                            <Button size="sm" onClick={() => pm2Act(p.name, 'start')}>
                              Start
                            </Button>
                          )}
                          <Button size="sm" onClick={() => open(<Pm2LogsDialog name={p.name} />, { wide: true })}>
                            Logs
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </div>
  );
}
