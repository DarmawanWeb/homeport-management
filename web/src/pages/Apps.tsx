import { Boxes, Plus, Rocket, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { AppView, Deploy } from '../../../src/shared/types';
import { DeployStrip } from '../components/DeployStrip';
import { DeployLogDialog } from '../components/Logs';
import { SetupNotices } from '../components/Shell';
import { Badge, Button, Empty, Light, Loading, Modal, Notice, PageHead, Panel, Switch, type Tone } from '../components/ui';
import { del, post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { ago, repoShort } from '../lib/format';
import { useApps, useRefresh } from '../lib/queries';
import { href, parseHash } from '../lib/router';
import { useReport } from '../lib/toast';
import { AppForm } from './AppForm';

export function appState(a: AppView): [Tone, string] {
  if (a.deploying) return ['run', 'Deploying'];
  if (!a.pm2) return [undefined, 'Not started'];
  if (a.pm2.status !== 'online') return ['err', a.pm2.status === 'errored' ? 'Crashed' : 'Stopped'];
  return a.up ? ['ok', 'Running'] : ['warn', 'Port closed'];
}

export function useDeployAction() {
  const { open } = useDialog();
  const refresh = useRefresh();
  return async (a: AppView, commit?: string) => {
    const r = await post<{ deploy: Deploy }>(`/api/apps/${a.id}/deploy`, commit ? { commit } : undefined);
    open(<DeployLogDialog id={r.deploy.id} />, { wide: true });
    await refresh('apps', 'deploys');
  };
}

/** Opens the delete dialog. Disabled while a deploy runs, since the server refuses then. */
export function DeleteAppButton({ app, size, iconOnly, className }: { app: AppView; size?: 'sm'; iconOnly?: boolean; className?: string }) {
  const { open } = useDialog();
  return (
    <Button
      variant="danger"
      size={size}
      icon={<Trash2 />}
      iconOnly={iconOnly}
      className={className}
      title={app.deploying ? 'Wait for the deploy to finish' : `Delete ${app.name}`}
      disabled={app.deploying}
      onClick={() => open(<DeleteAppDialog app={app} />)}
    >
      Delete app
    </Button>
  );
}

export function DeleteAppDialog({ app }: { app: AppView }) {
  // Default to a clean delete: no checkout, node_modules or build cache left in the apps folder.
  const [files, setFiles] = useState(true);
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
        if (parseHash(location.hash).page === 'app') location.hash = href({ page: 'apps' });
      }}
    >
      <div className="form">
        <p>
          The pm2 process and its logs are removed, its deploy history is cleared, and pushes are no longer deployed. This cannot be undone.
        </p>
        <Switch checked={files} onChange={setFiles} hint={`${app.dir}, with node_modules and build caches`}>
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

export function Apps() {
  const { data, error } = useApps();
  const { open } = useDialog();
  const deploy = useDeployAction();
  const create = () => open(<AppForm />, { wide: true });

  return (
    <div className="page">
      <PageHead
        title="Apps"
        description="Each app is a Git repository that Homeport clones, builds and keeps running with pm2. Pushing to its branch ships a new version."
        actions={
          <Button variant="primary" icon={<Plus />} onClick={create}>
            Add app
          </Button>
        }
      />
      <SetupNotices />
      {data && !data.webhookDomain && data.apps.some((a) => a.autoDeploy === 'webhook') && (
        <div className="notices">
          <Notice
            action={
              <a className="btn sm" href="#/settings">
                Set webhook domain
              </a>
            }
          >
            Some apps deploy on push, but GitHub has no public address to send pushes to yet.
          </Notice>
        </div>
      )}
      {error ? (
        <Notice tone="err">{error.message}</Notice>
      ) : !data ? (
        <Loading />
      ) : data.apps.length === 0 ? (
        <Panel>
          <Empty
            icon={<Boxes />}
            title="No apps yet"
            action={
              <Button variant="primary" icon={<Plus />} onClick={create}>
                Add your first app
              </Button>
            }
          >
            Paste a repository URL. Homeport detects npm, pnpm, yarn or bun, builds the project, and starts it on its own port.
          </Empty>
        </Panel>
      ) : (
        <Panel flush>
          <div className="manifest">
            {data.apps.map((a) => {
              const [tone, label] = appState(a);
              return (
                <div key={a.id} className="ship">
                  <div className="ship-name">
                    <Light tone={tone} label={label} />
                    <div style={{ minWidth: 0 }}>
                      <a className="ship-link" href={href({ page: 'app', id: a.id, tab: 'deploys' })}>
                        <strong>{a.name}</strong>
                      </a>
                      <span className="sub ellipsis code">
                        {repoShort(a.repo)}@{a.branch}
                      </span>
                    </div>
                  </div>
                  <div className="ship-cell hide-md">
                    {a.domains[0] ? <span className="ellipsis">{a.domains[0]}</span> : <span className="muted">No domain</span>}
                    <span className="sub">
                      Port <span className="code">{a.port}</span>
                      {a.domains.length > 1 && `, ${a.domains.length - 1} more domain${a.domains.length > 2 ? 's' : ''}`}
                    </span>
                  </div>
                  <div className="ship-cell hide-md">
                    <DeployStrip deploys={a.recentDeploys} />
                    <span className="sub">{a.lastDeploy ? `Last deploy ${ago(a.lastDeploy.at)}` : 'Never deployed'}</span>
                  </div>
                  <div className="ship-cell">
                    <Badge tone={tone}>{label}</Badge>
                  </div>
                  <div className="btn-row">
                    <Button size="sm" icon={<Rocket />} disabled={a.deploying} onClick={() => deploy(a)}>
                      Deploy
                    </Button>
                    <DeleteAppButton app={a} size="sm" iconOnly />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}
