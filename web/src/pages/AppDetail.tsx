import { ChevronLeft, ExternalLink, Globe, Play, Rocket, RotateCw, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AppView } from '../../../src/shared/types';
import { DeployStrip } from '../components/DeployStrip';
import { DeployLogDialog, Pm2Log } from '../components/Logs';
import { Badge, Button, CopyField, DeployBadge, Empty, Field, Loading, Modal, Notice, PageHead, Panel, Switch } from '../components/ui';
import { del, get, post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { ago, fmtBytes, fmtDuration, fmtPct, fmtUptime, repoShort, shortSha } from '../lib/format';
import { useAppState, useApps, useCommits, useDeploys, useMonitoring, useRefresh } from '../lib/queries';
import { type AppTab, href, navigate } from '../lib/router';
import { useReport, useToast } from '../lib/toast';
import { AppSettings } from './AppForm';
import { appState, useDeployAction } from './Apps';
import { MetricPanel, RangePicker, type RangeValue } from './Overview';

const TABS: [AppTab, string][] = [
  ['deploys', 'Deploys'],
  ['logs', 'Logs'],
  ['metrics', 'Metrics'],
  ['webhook', 'Auto-deploy'],
  ['settings', 'Settings'],
];

export function AppDetail({ id, tab }: { id: string; tab: AppTab }) {
  const { data, isLoading } = useApps();
  const app = data?.apps.find((a) => a.id === id || a.name === id);
  const deploy = useDeployAction();
  const toast = useToast();
  const report = useReport();
  const refresh = useRefresh();
  const { data: state } = useAppState();

  if (isLoading) return <Loading />;
  if (!app)
    return (
      <div className="page">
        <Empty
          title="App not found"
          action={
            <a className="btn" href="#/apps">
              Back to apps
            </a>
          }
        >
          It may have been deleted.
        </Empty>
      </div>
    );

  const [tone, label] = appState(app);
  const appDomain = state?.settings.appDomain;
  const defaultHost = appDomain ? `${app.name.replace(/[^a-z0-9-]/g, '-')}.${appDomain}` : '';
  const addDefaultDomain = async () => {
    const r = await post('/api/sites', {
      hostname: defaultHost,
      upstreamPort: app.port,
      pm2Name: app.name,
      tunnel: state?.settings.defaultTunnel ?? '',
      routeDns: true,
      overwriteDns: false,
    });
    report(r, `${app.name} is live at https://${defaultHost}`);
    await refresh();
  };
  const act = async (action: 'restart' | 'stop' | 'start') => {
    await post(`/api/apps/${app.id}/${action}`);
    toast(`${app.name}: ${action === 'stop' ? 'stopped' : action === 'start' ? 'started' : 'restarted'}`, 'ok');
    await refresh('apps');
  };

  return (
    <div className="page">
      <PageHead
        back={
          <a className="back" href="#/apps">
            <ChevronLeft size={14} /> Apps
          </a>
        }
        title={
          <span className="btn-row" style={{ gap: 12 }}>
            {app.name}{' '}
            <Badge tone={tone} light>
              {label}
            </Badge>
          </span>
        }
        description={
          <>
            <span className="code">{repoShort(app.repo)}</span> on <span className="code">{app.branch}</span>, port{' '}
            <span className="code">{app.port}</span>
            {app.domains.map((d) => (
              <span key={d}>
                {', '}
                <a href={`https://${d}`} target="_blank" rel="noopener noreferrer">
                  {d}
                </a>
              </span>
            ))}
          </>
        }
        actions={
          <>
            {app.domains[0] ? (
              <a className="btn" href={`https://${app.domains[0]}`} target="_blank" rel="noopener noreferrer">
                <ExternalLink /> Visit
              </a>
            ) : (
              defaultHost && (
                <Button icon={<Globe />} onClick={addDefaultDomain}>
                  Add {defaultHost}
                </Button>
              )
            )}
            {app.pm2?.status === 'online' ? (
              <>
                <Button icon={<RotateCw />} onClick={() => act('restart')}>
                  Restart
                </Button>
                <Button icon={<Square />} onClick={() => act('stop')}>
                  Stop
                </Button>
              </>
            ) : (
              <Button icon={<Play />} onClick={() => act('start')} disabled={!app.lastDeploy}>
                Start
              </Button>
            )}
            <Button variant="primary" icon={<Rocket />} disabled={app.deploying} onClick={() => deploy(app)}>
              Deploy now
            </Button>
          </>
        }
      />

      <div className="cols-3" style={{ marginBottom: 20 }}>
        <Panel>
          <dl className="kv">
            <dt>Running</dt>
            <dd>
              {app.currentCommit ? (
                <>
                  <span className="code">{shortSha(app.currentCommit.sha)}</span> {app.currentCommit.msg}
                </>
              ) : (
                'Nothing deployed yet'
              )}
            </dd>
            <dt>By</dt>
            <dd>{app.currentCommit?.author ?? '—'}</dd>
          </dl>
        </Panel>
        <Panel>
          <dl className="kv">
            <dt>Process</dt>
            <dd>
              {app.pm2
                ? `${app.pm2.status}${app.pm2.uptime && app.pm2.status === 'online' ? `, up ${fmtUptime((Date.now() - app.pm2.uptime) / 1000)}` : ''}`
                : 'Not in pm2'}
            </dd>
            <dt>Usage</dt>
            <dd>{app.pm2 ? `${fmtPct(app.pm2.cpu)} CPU, ${fmtBytes(app.pm2.mem)}, ${app.pm2.restarts} restarts` : '—'}</dd>
          </dl>
        </Panel>
        <Panel>
          <div className="stack" style={{ gap: 8 }}>
            <DeployStrip deploys={app.recentDeploys} />
            <span className="muted" style={{ fontSize: 'var(--t-sm)' }}>
              {app.recentDeploys.length ? `Last ${app.recentDeploys.length} deploys, newest on the right` : 'No deploys yet'}
            </span>
          </div>
        </Panel>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map(([key, text]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => navigate({ page: 'app', id: app.id, tab: key })}
          >
            {text}
          </button>
        ))}
      </div>

      {tab === 'deploys' && <DeploysTab app={app} />}
      {tab === 'logs' && (
        <Panel>
          <Pm2Log name={app.name} />
        </Panel>
      )}
      {tab === 'metrics' && <MetricsTab app={app} />}
      {tab === 'webhook' && <WebhookTab app={app} />}
      {tab === 'settings' && (
        <Panel title="Settings">
          <AppSettings app={app} footer={<DeleteButton app={app} />} />
        </Panel>
      )}
    </div>
  );
}

function DeploysTab({ app }: { app: AppView }) {
  const { data } = useDeploys(app.id);
  const { data: commits } = useCommits(app.id);
  const { open } = useDialog();
  const deploy = useDeployAction();

  return (
    <div className="cols">
      <Panel title="History" description="Click a deploy to read its build log." flush>
        {data?.deploys.length ? (
          <table className="table">
            <tbody>
              {data.deploys.map((d) => (
                <tr key={d.id} className="link" onClick={() => open(<DeployLogDialog id={d.id} />, { wide: true })}>
                  <td>
                    <span className="code">{shortSha(d.commit ?? d.target) || '—'}</span>{' '}
                    <span className="ellipsis">{d.msg ?? d.pushMsg ?? ''}</span>
                    <span className="sub">
                      {d.trigger === 'webhook'
                        ? `Push${d.pushedBy ? ` by ${d.pushedBy}` : ''}`
                        : d.trigger === 'poll'
                          ? 'New commit found'
                          : d.trigger === 'rollback'
                            ? 'Manual rollback'
                            : 'Manual'}
                      {d.duration ? `, ${fmtDuration(d.duration)}` : ''}
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
          <Empty title="No deploys yet" />
        )}
      </Panel>
      <Panel title={`Commits on ${app.branch}`} description="Deploy any of them to roll back or forward." flush>
        {commits?.commits.length ? (
          <table className="table">
            <tbody>
              {commits.commits.map((c) => (
                <tr key={c.sha}>
                  <td>
                    <span className="code">{shortSha(c.sha)}</span> {c.msg}
                    <span className="sub">
                      {c.author}, {ago(c.date)}
                    </span>
                  </td>
                  <td className="right">
                    {c.sha === commits.current ? (
                      <Badge tone="ok">Running</Badge>
                    ) : (
                      <Button size="sm" onClick={() => deploy(app, c.sha)}>
                        Deploy this
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="Not cloned yet">Commits appear after the first deploy.</Empty>
        )}
      </Panel>
    </div>
  );
}

function MetricsTab({ app }: { app: AppView }) {
  const { data: mon } = useMonitoring();
  const [range, setRange] = useState<RangeValue>(6 * 3600);
  if (!mon?.enabled)
    return (
      <Panel>
        <Empty
          title="Monitoring is off"
          action={
            <a className="btn primary" href="#/monitoring">
              Set up monitoring
            </a>
          }
        >
          CPU and memory history per app come from Prometheus.
        </Empty>
      </Panel>
    );
  return (
    <div className="stack">
      <div className="btn-row">
        <span className="right-push" />
        <RangePicker value={range} onChange={setRange} />
      </div>
      <div className="cols">
        <MetricPanel title="CPU" preset="appCpu" app={app.name} range={range} format={fmtPct} />
        <MetricPanel title="Memory" preset="appMem" app={app.name} range={range} format={fmtBytes} />
      </div>
    </div>
  );
}

function WebhookTab({ app }: { app: AppView }) {
  const [w, setW] = useState<{ url: string | null; secret: string; lastWebhookAt: string | null } | null>(null);
  const toast = useToast();
  useEffect(() => {
    void get<{ url: string | null; secret: string; lastWebhookAt: string | null }>(`/api/apps/${app.id}/webhook`).then(setW);
  }, [app.id]);
  const gh = /github\.com[/:]([^/]+\/[^/.]+)/.exec(app.repo)?.[1];
  const regen = async () => {
    if (!confirm('The current secret stops working immediately. Update it on GitHub afterwards. Continue?')) return;
    const r = await post<{ secret: string }>(`/api/apps/${app.id}/secret`);
    setW((x) => (x ? { ...x, secret: r.secret } : x));
    toast('New secret created', 'ok');
  };
  if (!w) return <Loading />;

  return (
    <div className="cols">
      <Panel
        title="GitHub webhook"
        description={
          app.autoDeploy === 'webhook'
            ? 'Pushes to this branch deploy within seconds.'
            : `This app currently ships ${app.autoDeploy === 'poll' ? 'by polling' : 'manually'}. Switch to webhook in Settings to use this.`
        }
      >
        {!w.url ? (
          <Notice
            action={
              <a className="btn sm" href="#/settings">
                Open settings
              </a>
            }
          >
            Set a public webhook domain first, for example hooks.example.com.
          </Notice>
        ) : (
          <div className="form">
            <Field label="Payload URL">
              <CopyField value={w.url} />
            </Field>
            <Field label="Secret">
              <CopyField value={w.secret} code />
            </Field>
            <Field label="Content type">
              <input readOnly value="application/json" />
            </Field>
            <div className="btn-row">
              {gh && (
                <a className="btn primary" href={`https://github.com/${gh}/settings/hooks/new`} target="_blank" rel="noopener noreferrer">
                  Add on GitHub <ExternalLink />
                </a>
              )}
              <Button variant="danger" onClick={regen}>
                Rotate secret
              </Button>
            </div>
          </div>
        )}
      </Panel>
      <Panel title="How it works">
        <dl className="kv">
          <dt>Last delivery</dt>
          <dd>{w.lastWebhookAt ? ago(w.lastWebhookAt) : 'None received yet'}</dd>
          <dt>Branch</dt>
          <dd>
            Only pushes to <span className="code">{app.branch}</span> deploy
          </dd>
          <dt>Verification</dt>
          <dd>Every request is checked with HMAC-SHA256 against the secret; anything else is rejected with 401.</dd>
          <dt>Bursts</dt>
          <dd>Pushes that arrive during a deploy collapse into one follow-up deploy of the newest commit.</dd>
        </dl>
      </Panel>
    </div>
  );
}

function DeleteButton({ app }: { app: AppView }) {
  const { open } = useDialog();
  return (
    <Button variant="danger" icon={<Trash2 />} className="right-push" onClick={() => open(<DeleteApp app={app} />)}>
      Delete app
    </Button>
  );
}

function DeleteApp({ app }: { app: AppView }) {
  const [files, setFiles] = useState(false);
  const [sites, setSites] = useState(true);
  const { close } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  return (
    <Modal
      title={`Delete ${app.name}?`}
      danger
      submitLabel="Delete app"
      onSubmit={async () => {
        const r = await del(`/api/apps/${app.id}?files=${files ? 1 : 0}&site=${sites ? 1 : 0}`);
        close();
        report(r, `${app.name} deleted`);
        await refresh();
        location.hash = href({ page: 'apps' });
      }}
    >
      <div className="form">
        <p>The pm2 process is stopped and removed, and pushes are no longer deployed.</p>
        <Switch checked={files} onChange={setFiles} hint={app.dir}>
          Also delete the checked-out code
        </Switch>
        {app.domains.length > 0 && (
          <Switch checked={sites} onChange={setSites} hint={app.domains.join(', ')}>
            Also remove its domains from Caddy and the tunnel
          </Switch>
        )}
      </div>
    </Modal>
  );
}
