import { Globe, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Site } from '../../../src/shared/types';
import { SetupNotices } from '../components/Shell';
import { Badge, Button, Empty, Field, Light, Loading, Modal, PageHead, Panel, Switch } from '../components/ui';
import { del, post, put } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { useAppState, usePm2, useRefresh, useSiteHealth, useTunnels } from '../lib/queries';
import { useReport } from '../lib/toast';

export function Domains() {
  const { data: state } = useAppState();
  const { data: health } = useSiteHealth();
  const { open } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  if (!state) return <Loading />;
  const sites = state.sites;

  const toggle = async (s: Site) => {
    report(await post(`/api/sites/${s.id}/toggle`), s.enabled ? `${s.hostname} turned off` : `${s.hostname} turned on`);
    await refresh();
  };
  const apply = async () => {
    report({ apply: await post('/api/caddy/apply') }, 'Caddy reloaded and tunnel routes synced');
    await refresh();
  };

  return (
    <div className="page">
      <PageHead
        title="Domains"
        description={`Every public hostname and the local port it reaches. Requests come in through a tunnel, and Caddy on :${state.settings.caddyHttpPort} sends each host to its app.`}
        actions={
          <>
            <Button onClick={apply}>Re-apply config</Button>
            <Button variant="primary" icon={<Plus />} onClick={() => open(<SiteForm />)}>
              Add domain
            </Button>
          </>
        }
      />
      <SetupNotices />
      <Panel flush>
        {sites.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Goes to</th>
                <th className="hide-sm">Tunnel</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => {
                const h = health?.[s.id];
                return (
                  <tr key={s.id} className={s.enabled ? '' : 'off'}>
                    <td className="primary-cell">
                      <a href={`https://${s.hostname}`} target="_blank" rel="noopener noreferrer">
                        {s.hostname}
                      </a>
                      <span className="sub">
                        {[s.pm2Name, s.basicAuthUser && 'password protected', s.compress && 'compressed', !s.enabled && 'turned off']
                          .filter(Boolean)
                          .join(', ') || s.notes}
                      </span>
                    </td>
                    <td>
                      <span className="btn-row" style={{ gap: 8 }}>
                        <Light
                          tone={h === true ? 'ok' : h === false ? 'err' : undefined}
                          label={h ? 'port answering' : 'port not answering'}
                        />
                        <span className="code">
                          {s.upstreamHost}:{s.upstreamPort}
                        </span>
                      </span>
                    </td>
                    <td className="hide-sm">{s.tunnel ? <Badge tone="sea">{s.tunnel}</Badge> : <Badge tone="err">No tunnel</Badge>}</td>
                    <td>
                      <div className="row-actions">
                        <Button size="sm" onClick={() => toggle(s)}>
                          {s.enabled ? 'Turn off' : 'Turn on'}
                        </Button>
                        <Button size="sm" onClick={() => open(<SiteForm site={s} />)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => open(<DeleteSite site={s} />)}>
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
            icon={<Globe />}
            title="No domains yet"
            action={
              <Button variant="primary" icon={<Plus />} onClick={() => open(<SiteForm />)}>
                Add a domain
              </Button>
            }
          >
            Point a hostname on your Cloudflare account at any port on this machine. Apps added from Git can create their domain for you.
          </Empty>
        )}
      </Panel>
    </div>
  );
}

type SiteDraft = Omit<Site, 'id' | 'createdAt' | 'updatedAt'> & {
  routeDns: boolean;
  overwriteDns: boolean;
  deleteOldDns: boolean;
  basicAuthPw: string;
};

export function SiteForm({ site, preset }: { site?: Site; preset?: Partial<Site> }) {
  const { data: state } = useAppState();
  const { data: tunnels } = useTunnels();
  const { data: pm2 } = usePm2();
  const { close } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  const st = state?.settings;
  const [f, setF] = useState<SiteDraft>(() => ({
    hostname: '',
    upstreamHost: 'localhost',
    upstreamPort: 3000,
    scheme: 'http',
    tlsInsecure: false,
    tunnel: st?.defaultTunnel ?? '',
    pm2Name: '',
    enabled: true,
    compress: false,
    basicAuthUser: '',
    basicAuthHash: '',
    extra: '',
    notes: '',
    ...preset,
    ...site,
    routeDns: true,
    overwriteDns: !!site,
    deleteOldDns: false,
    basicAuthPw: '',
  }));
  const set = <K extends keyof SiteDraft>(k: K, v: SiteDraft[K]) => setF((s) => ({ ...s, [k]: v }));
  const procs = (pm2?.list ?? []).filter(
    (p) => st && p.name !== 'homeport' && !p.name.startsWith('hp-') && !p.name.startsWith(st.tunnelPm2Prefix),
  );

  const submit = async () => {
    const { basicAuthPw, ...body } = f;
    if (body.basicAuthUser && basicAuthPw)
      body.basicAuthHash = (await post<{ hash: string }>('/api/caddy-hash', { password: basicAuthPw })).hash;
    if (!body.basicAuthUser) body.basicAuthHash = '';
    if (body.basicAuthUser && !body.basicAuthHash) throw new Error('Enter a password for the protected domain');
    const r = site ? await put(`/api/sites/${site.id}`, body) : await post('/api/sites', body);
    close();
    report(r, site ? `${f.hostname} updated` : `${f.hostname} added`);
    await refresh();
  };

  return (
    <Modal title={site ? `Edit ${site.hostname}` : 'Add a domain'} onSubmit={submit} submitLabel={site ? 'Save changes' : 'Add domain'}>
      <div className="form">
        <Field label="Hostname" hint="Must belong to a zone on the Cloudflare account cloudflared is signed in to.">
          <input
            value={f.hostname}
            onChange={(e) => set('hostname', e.target.value)}
            placeholder="shop.example.com"
            required
            autoComplete="off"
          />
        </Field>
        {procs.length > 0 && (
          <Field label="Running on this machine" hint="Pick a pm2 process to fill in its port.">
            <div className="chips">
              {procs.map((p) => (
                <button
                  type="button"
                  key={p.name}
                  className="chip"
                  onClick={() => setF((s) => ({ ...s, pm2Name: p.name, upstreamPort: p.port ?? s.upstreamPort, notes: s.notes || p.name }))}
                >
                  <Light tone={p.status === 'online' ? 'ok' : 'err'} />
                  {p.name}
                  {p.port ? <span className="code">:{p.port}</span> : null}
                </button>
              ))}
            </div>
          </Field>
        )}
        <div className="form-row">
          <Field label="Local host" wide>
            <input value={f.upstreamHost} onChange={(e) => set('upstreamHost', e.target.value)} />
          </Field>
          <Field label="Port">
            <input
              type="number"
              min={1}
              max={65535}
              value={f.upstreamPort}
              onChange={(e) => set('upstreamPort', Number(e.target.value))}
              required
            />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Tunnel">
            <select value={f.tunnel} onChange={(e) => set('tunnel', e.target.value)}>
              <option value="">No tunnel</option>
              {tunnels?.tunnels.map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
              {f.tunnel && !tunnels?.tunnels.some((t) => t.name === f.tunnel) && <option>{f.tunnel}</option>}
            </select>
          </Field>
          <Field label="App name" hint="Optional label linking this domain to an app.">
            <input value={f.pm2Name} onChange={(e) => set('pm2Name', e.target.value)} />
          </Field>
        </div>
        <Switch
          checked={f.routeDns}
          onChange={(v) => set('routeDns', v)}
          hint={site ? 'Only runs when the hostname or tunnel changes.' : 'Creates a CNAME to the tunnel on Cloudflare.'}
        >
          Point DNS at the tunnel
        </Switch>
        <Switch
          checked={f.overwriteDns}
          onChange={(v) => set('overwriteDns', v)}
          hint="Needed when the hostname already has a record, for example from an old tunnel."
        >
          Replace an existing DNS record
        </Switch>
        {site && st?.cfApiTokenSet && (
          <Switch checked={f.deleteOldDns} onChange={(v) => set('deleteOldDns', v)}>
            Delete the old record when the hostname changes
          </Switch>
        )}
        <details className="more" open={!!(site && (site.extra || site.basicAuthUser || site.scheme === 'https' || site.compress))}>
          <summary>Password, compression and Caddy directives</summary>
          <div className="form">
            <div className="form-row">
              <Field label="Username">
                <input value={f.basicAuthUser} onChange={(e) => set('basicAuthUser', e.target.value)} autoComplete="off" />
              </Field>
              <Field label="Password" hint="Stored as a bcrypt hash.">
                <input
                  type="password"
                  value={f.basicAuthPw}
                  onChange={(e) => set('basicAuthPw', e.target.value)}
                  placeholder={f.basicAuthHash ? 'Unchanged' : ''}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <Switch checked={f.compress} onChange={(v) => set('compress', v)}>
              Compress responses with zstd or gzip
            </Switch>
            <div className="form-row">
              <Field label="Upstream protocol">
                <select value={f.scheme} onChange={(e) => set('scheme', e.target.value as 'http' | 'https')}>
                  <option value="http">http</option>
                  <option value="https">https</option>
                </select>
              </Field>
              {f.scheme === 'https' && (
                <Switch
                  checked={f.tlsInsecure}
                  onChange={(v) => set('tlsInsecure', v)}
                  hint="For self-signed certificates on the upstream."
                >
                  Skip certificate check
                </Switch>
              )}
            </div>
            <Field label="Extra Caddy directives" hint="Placed inside this site's block. Validated before it goes live.">
              <textarea
                value={f.extra}
                onChange={(e) => set('extra', e.target.value)}
                placeholder={'header X-Robots-Tag noindex\nrequest_body { max_size 50MB }'}
              />
            </Field>
            <Field label="Note">
              <input value={f.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </div>
        </details>
      </div>
    </Modal>
  );
}

function DeleteSite({ site }: { site: Site }) {
  const { data: state } = useAppState();
  const [dns, setDns] = useState(true);
  const { close } = useDialog();
  const report = useReport();
  const refresh = useRefresh();
  const canDeleteDns = !!state?.settings.cfApiTokenSet;
  return (
    <Modal
      title={`Delete ${site.hostname}?`}
      danger
      submitLabel="Delete domain"
      onSubmit={async () => {
        const r = await del(`/api/sites/${site.id}?dns=${dns && canDeleteDns ? 1 : 0}`);
        close();
        report(r, `${site.hostname} deleted`);
        await refresh();
      }}
    >
      <div className="form">
        <p>Its Caddy route and tunnel ingress rule are removed right away.</p>
        {canDeleteDns ? (
          <Switch checked={dns} onChange={setDns}>
            Also delete the DNS record on Cloudflare
          </Switch>
        ) : (
          <p className="hint">The DNS record stays on Cloudflare. Add an API token in Settings to have Homeport remove it.</p>
        )}
      </div>
    </Modal>
  );
}
