import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import type { AppView, AutoDeploy, Deploy } from '../../../src/shared/types';
import { DeployLogDialog } from '../components/Logs';
import { Field, Modal, Switch } from '../components/ui';
import { post, put } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useAppState, useApps, useRefresh, useTunnels } from '../lib/queries';
import { navigate } from '../lib/router';
import { useReport, useToast } from '../lib/toast';

interface FormState {
  repo: string;
  name: string;
  branch: string;
  port: number;
  hostname: string;
  tunnel: string;
  autoDeploy: AutoDeploy;
  pollInterval: number;
  autoRollback: boolean;
  env: string;
  installCmd: string;
  buildCmd: string;
  startCmd: string;
  gitToken: string;
  maxMemory: string;
  healthTimeout: number;
}

const nameFromRepo = (repo: string) =>
  (/([^/:]+?)(\.git)?\/?$/.exec(repo.trim())?.[1] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 40);

function useAppFormState(app?: AppView) {
  const { data: apps } = useApps();
  const { data: state } = useAppState();
  const [f, setF] = useState<FormState>(() => ({
    repo: app?.repo ?? '',
    name: app?.name ?? '',
    branch: app?.branch ?? 'main',
    port: app?.port ?? apps?.nextPort ?? 3001,
    hostname: '',
    tunnel: state?.settings.defaultTunnel ?? '',
    autoDeploy: app?.autoDeploy ?? 'webhook',
    pollInterval: app?.pollInterval ?? 60,
    autoRollback: app?.autoRollback ?? true,
    env: Object.entries(app?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    installCmd: app?.installCmd ?? '',
    buildCmd: app?.buildCmd ?? '',
    startCmd: app?.startCmd ?? '',
    gitToken: app?.gitToken ?? '',
    maxMemory: app?.maxMemory ?? '',
    healthTimeout: app?.healthTimeout ?? 40,
  }));
  const set = useCallback(<K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => (s[k] === v ? s : { ...s, [k]: v })), []);
  return { f, set, setF };
}

function Fields({
  f,
  set,
  creating,
  onNameTouched,
}: {
  f: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  creating: boolean;
  onNameTouched: () => void;
}) {
  const { data: tunnels } = useTunnels();
  return (
    <div className="form">
      <Field label="Repository" hint="HTTPS or SSH URL. Private repositories need an access token or an SSH key on this machine.">
        <input
          value={f.repo}
          onChange={(e) => set('repo', e.target.value)}
          required
          autoComplete="off"
          placeholder="https://github.com/you/shop.git"
        />
      </Field>
      <div className="form-row">
        <Field label="Name" hint={creating ? 'Also the pm2 process name.' : 'Fixed after creation.'}>
          <input
            value={f.name}
            readOnly={!creating}
            required
            onChange={(e) => {
              onNameTouched();
              set('name', e.target.value);
            }}
            placeholder="shop"
          />
        </Field>
        <Field label="Branch">
          <input value={f.branch} onChange={(e) => set('branch', e.target.value)} />
        </Field>
        <Field
          label="Port"
          hint={
            <>
              Passed to the app as <code>PORT</code>.
            </>
          }
        >
          <input type="number" min={1} max={65535} value={f.port} onChange={(e) => set('port', Number(e.target.value))} required />
        </Field>
      </div>
      {creating && (
        <div className="form-row">
          <Field label="Domain" hint="Optional. A DNS record is created on Cloudflare." wide>
            <input value={f.hostname} onChange={(e) => set('hostname', e.target.value)} placeholder="shop.example.com" autoComplete="off" />
          </Field>
          <Field label="Tunnel">
            <select value={f.tunnel} onChange={(e) => set('tunnel', e.target.value)}>
              <option value="">No tunnel</option>
              {tunnels?.tunnels.map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <div className="form-row">
        <Field label="Ship new commits">
          <select value={f.autoDeploy} onChange={(e) => set('autoDeploy', e.target.value as AutoDeploy)}>
            <option value="webhook">On push, via GitHub webhook</option>
            <option value="poll">By checking the branch on a timer</option>
            <option value="off">Only when I click Deploy</option>
          </select>
        </Field>
        {f.autoDeploy === 'poll' && (
          <Field label="Check every (seconds)">
            <input type="number" min={30} value={f.pollInterval} onChange={(e) => set('pollInterval', Number(e.target.value))} />
          </Field>
        )}
      </div>
      <Switch
        checked={f.autoRollback}
        onChange={(v) => set('autoRollback', v)}
        hint="If a build fails or the app does not come up, the last good commit is redeployed."
      >
        Roll back automatically
      </Switch>
      <Field
        label="Environment variables"
        hint={
          <>
            One <code>KEY=value</code> per line. PORT is set for you.
          </>
        }
      >
        <textarea
          rows={4}
          value={f.env}
          onChange={(e) => set('env', e.target.value)}
          placeholder={'DATABASE_URL=postgres://…\nAPI_KEY=…'}
        />
      </Field>
      <details className="more" open={!creating && !!(f.installCmd || f.buildCmd || f.startCmd || f.gitToken || f.maxMemory)}>
        <summary>Build commands, private repository and limits</summary>
        <div className="form">
          <p className="hint">Leave blank to detect from package.json and the lockfile. Enter a single dash to skip a step.</p>
          <div className="form-row">
            <Field label="Install">
              <input value={f.installCmd} onChange={(e) => set('installCmd', e.target.value)} placeholder="npm ci" />
            </Field>
            <Field label="Build">
              <input value={f.buildCmd} onChange={(e) => set('buildCmd', e.target.value)} placeholder="npm run build" />
            </Field>
            <Field label="Start">
              <input value={f.startCmd} onChange={(e) => set('startCmd', e.target.value)} placeholder="npm start" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="GitHub access token" hint="Fine-grained token with read access to contents. Never written to .git/config." wide>
              <input
                type="password"
                value={f.gitToken}
                onChange={(e) => set('gitToken', e.target.value)}
                autoComplete="new-password"
                placeholder="github_pat_…"
              />
            </Field>
            <Field label="Memory limit" hint="pm2 restarts the app above this.">
              <input value={f.maxMemory} onChange={(e) => set('maxMemory', e.target.value)} placeholder="512M" />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Startup timeout (seconds)" hint="How long to wait for the port to open.">
              <input type="number" value={f.healthTimeout} onChange={(e) => set('healthTimeout', Number(e.target.value))} />
            </Field>
            <span />
          </div>
        </div>
      </details>
    </div>
  );
}

/** Modal for creating an app; opens the live deploy log afterwards. */
export function AppForm() {
  const { f, set } = useAppFormState();
  const [nameTouched, setNameTouched] = useState(false);
  const { open } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  const toast = useToast();

  useEffect(() => {
    if (!nameTouched && f.repo) set('name', nameFromRepo(f.repo));
  }, [f.repo, nameTouched, set]);

  const submit = async () => {
    const r = await post<{ app: AppView; deploy?: Deploy; site?: unknown; warning?: string }>('/api/apps', f);
    if (r.warning) toast(r.warning, 'warn', 9000);
    if (r.site) report(r.site, `${f.hostname} now points at ${f.name}`);
    await refresh();
    navigate({ page: 'app', id: r.app.id, tab: 'deploys' });
    if (r.deploy) open(<DeployLogDialog id={r.deploy.id} />, { wide: true });
  };

  return (
    <Modal title="Add an app" onSubmit={submit} submitLabel="Create and deploy">
      <Fields f={f} set={set} creating onNameTouched={() => setNameTouched(true)} />
    </Modal>
  );
}

/** Inline settings form on the app page. */
export function AppSettings({ app, footer }: { app: AppView; footer?: ReactNode }) {
  const { f, set } = useAppFormState(app);
  const [redeploy, setRedeploy] = useState(false);
  const [busy, setBusy] = useState(false);
  const { open } = useDialog();
  const refresh = useRefresh();
  const toast = useToast();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { hostname: _h, tunnel: _t, ...body } = f;
      const r = await put<{ deploy?: Deploy; restarted?: boolean; warning?: string }>(`/api/apps/${app.id}`, { ...body, redeploy });
      if (r.warning) toast(r.warning, 'warn', 9000);
      toast(r.restarted ? 'Saved and restarted with the new settings' : 'Saved', 'ok');
      await refresh();
      if (r.deploy) open(<DeployLogDialog id={r.deploy.id} />, { wide: true });
    } catch (err) {
      toast((err as Error).message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="stack">
      <Fields f={f} set={set} creating={false} onNameTouched={() => {}} />
      <Switch checked={redeploy} onChange={setRedeploy} hint="Otherwise env and start command changes only restart the running build.">
        Rebuild and deploy after saving
      </Switch>
      <div className="btn-row">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy && <span className="spin" />}
          Save changes
        </button>
        {footer}
      </div>
    </form>
  );
}
