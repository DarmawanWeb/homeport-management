import { Boxes, Plus, Rocket } from 'lucide-react';
import type { AppView, Deploy } from '../../../src/shared/types';
import { DeployStrip } from '../components/DeployStrip';
import { DeployLogDialog } from '../components/Logs';
import { SetupNotices } from '../components/Shell';
import { Badge, Button, Empty, Light, Loading, Notice, PageHead, Panel, type Tone } from '../components/ui';
import { post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { ago, repoShort } from '../lib/format';
import { useApps, useRefresh } from '../lib/queries';
import { href } from '../lib/router';
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
