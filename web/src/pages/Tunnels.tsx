import { Cable, Plus, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TunnelView } from '../../../src/shared/types';
import { Pm2LogsDialog } from '../components/Logs';
import { SetupNotices } from '../components/Shell';
import { Badge, Button, Empty, Field, Light, Loading, Modal, Notice, PageHead, Panel, Switch } from '../components/ui';
import { del, get, post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useAppState, useRefresh, useTunnels } from '../lib/queries';
import { useReport, useToast } from '../lib/toast';

export function Tunnels() {
  const { data, error, isLoading } = useTunnels();
  const { data: state } = useAppState();
  const { open } = useDialog();
  const toast = useToast();
  const refresh = useRefresh();
  const prefix = state?.settings.tunnelPm2Prefix ?? 'hp-cf-';

  const reload = async () => {
    await get('/api/tunnels?refresh=1');
    await refresh('tunnels');
  };
  const act = async (t: TunnelView, action: string, done: string) => {
    await post(`/api/tunnels/${encodeURIComponent(t.name)}/${action}`);
    toast(done, 'ok');
    await refresh('tunnels', 'state', 'status');
    // Edge connections take a few seconds to register with Cloudflare.
    if (action === 'start' || action === 'restart') setTimeout(() => void reload(), 4000);
  };

  return (
    <div className="page">
      <PageHead
        title="Tunnels"
        description="An outbound connection from this machine to Cloudflare, so nothing has to be opened on your router. One tunnel carries every domain."
        actions={
          <>
            <Button icon={<RotateCw />} onClick={reload}>
              Refresh
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={() => open(<CreateTunnel />)}>
              Create tunnel
            </Button>
          </>
        }
      />
      <SetupNotices />
      {error && (
        <div className="notices">
          <Notice tone="err">{error.message}</Notice>
        </div>
      )}
      <Panel flush>
        {isLoading ? (
          <Loading />
        ) : data?.tunnels.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Tunnel</th>
                <th>Connection</th>
                <th className="hide-sm">Carries</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.tunnels.map((t) => {
                const running = t.pm2?.status === 'online';
                return (
                  <tr key={t.id}>
                    <td className="primary-cell">
                      {t.name} {state?.settings.defaultTunnel === t.name && <Badge tone="sea">Default</Badge>}
                      <span className="sub code">{t.id}</span>
                    </td>
                    <td>
                      <span className="btn-row" style={{ gap: 8 }}>
                        <Light tone={!running ? 'err' : t.connections ? 'ok' : 'warn'} />
                        {!running ? 'Stopped' : t.connections ? `${t.connections} edge connections` : 'Connecting'}
                      </span>
                      {!t.credentials && (
                        <span className="sub" style={{ color: 'var(--port)' }}>
                          Credentials are on another machine
                        </span>
                      )}
                    </td>
                    <td className="hide-sm">
                      {t.sites.length ? (
                        <span>
                          {t.sites.length} domain{t.sites.length === 1 ? '' : 's'}
                          <span className="sub ellipsis" style={{ maxWidth: 260 }}>
                            {t.sites.join(', ')}
                          </span>
                        </span>
                      ) : (
                        <span className="muted">No domains</span>
                      )}
                    </td>
                    <td>
                      <div className="row-actions">
                        {running ? (
                          <>
                            <Button size="sm" onClick={() => act(t, 'restart', `${t.name} restarted`)}>
                              Restart
                            </Button>
                            <Button size="sm" onClick={() => act(t, 'stop', `${t.name} stopped`)}>
                              Stop
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="primary"
                            disabled={!t.credentials}
                            onClick={() => act(t, 'start', `${t.name} started`)}
                          >
                            Start
                          </Button>
                        )}
                        <Button size="sm" onClick={() => open(<TunnelConfig name={t.name} />, { wide: true })}>
                          Routes
                        </Button>
                        <Button size="sm" onClick={() => open(<Pm2LogsDialog name={prefix + t.name} />, { wide: true })}>
                          Logs
                        </Button>
                        {state?.settings.defaultTunnel !== t.name && (
                          <Button size="sm" onClick={() => act(t, 'default', `${t.name} is now the default`)}>
                            Make default
                          </Button>
                        )}
                        <Button size="sm" variant="danger" onClick={() => open(<DeleteTunnel tunnel={t} />)}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty
            icon={<Cable />}
            title="No tunnels yet"
            action={
              <Button variant="primary" icon={<Plus />} onClick={() => open(<CreateTunnel />)}>
                Create a tunnel
              </Button>
            }
          >
            Name it after this machine. Homeport runs it under pm2 and rewrites its routes whenever a domain changes.
          </Empty>
        )}
      </Panel>
    </div>
  );
}

function CreateTunnel() {
  const [name, setName] = useState('');
  const [start, setStart] = useState(true);
  const { close } = useDialog();
  const toast = useToast();
  const refresh = useRefresh();
  return (
    <Modal
      title="Create a tunnel"
      submitLabel="Create tunnel"
      onSubmit={async () => {
        const r = await post<{ started: boolean }>('/api/tunnels', { name, start });
        close();
        toast(r.started ? `${name} created and started` : `${name} created`, 'ok');
        await refresh();
      }}
    >
      <div className="form">
        <Field label="Name" hint="Letters, digits, dashes and underscores.">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="mac-mini" pattern="[A-Za-z0-9_\-]+" required />
        </Field>
        <Switch checked={start} onChange={setStart}>
          Start it right away
        </Switch>
      </div>
    </Modal>
  );
}

function TunnelConfig({ name }: { name: string }) {
  const [r, setR] = useState<{ text: string; file: string } | null>(null);
  useEffect(() => {
    void get<{ text: string; file: string }>(`/api/tunnels/${encodeURIComponent(name)}/config`).then(setR);
  }, [name]);
  return (
    <Modal title={`Routes for ${name}`}>
      {r ? (
        <div className="stack" style={{ gap: 10 }}>
          <span className="muted code">{r.file}</span>
          <pre className="terminal">{r.text}</pre>
        </div>
      ) : (
        <Loading />
      )}
    </Modal>
  );
}

function DeleteTunnel({ tunnel: t }: { tunnel: TunnelView }) {
  const { data: state } = useAppState();
  const [dns, setDns] = useState(true);
  const { close } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  return (
    <Modal
      title={`Delete ${t.name}?`}
      danger
      submitLabel="Delete tunnel"
      onSubmit={async () => {
        const r = await del(`/api/tunnels/${encodeURIComponent(t.name)}?dns=${dns ? 1 : 0}`);
        close();
        report(r);
        await refresh();
      }}
    >
      <div className="form">
        <p>The tunnel is deleted on Cloudflare and its process stops. This cannot be undone.</p>
        {t.sites.length > 0 && (
          <p className="hint">{t.sites.length} domains use it. They stay in the list without a tunnel until you assign another.</p>
        )}
        {state?.settings.cfApiTokenSet && t.sites.length > 0 && (
          <Switch checked={dns} onChange={setDns}>
            Also delete their DNS records
          </Switch>
        )}
      </div>
    </Modal>
  );
}
