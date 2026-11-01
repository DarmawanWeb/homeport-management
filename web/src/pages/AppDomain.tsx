import { Globe } from 'lucide-react';
import { useState } from 'react';
import type { AppView } from '../../../src/shared/types';
import { Button, Field, Modal } from '../components/ui';
import { post } from '../lib/api';
import { useDialog } from '../lib/dialog';
import { isRootDomain } from '../lib/format';
import { useAppState, useRefresh, useTunnels } from '../lib/queries';
import { useReport, useToast } from '../lib/toast';
import { DnsSwitches } from './AppForm';

/** Opens "Add a domain" for an app: any hostname, a root domain included, not only <name>.<appDomain>. */
export function AddDomainButton({ app, iconOnly }: { app: AppView; iconOnly?: boolean }) {
  const { open } = useDialog();
  return (
    <Button icon={<Globe />} iconOnly={iconOnly} title="Add a domain" onClick={() => open(<AddDomainDialog app={app} />)}>
      Add domain
    </Button>
  );
}

function AddDomainDialog({ app }: { app: AppView }) {
  const { data: state } = useAppState();
  const { data: tunnels } = useTunnels();
  const appDomain = state?.settings.appDomain ?? '';
  const suggested = appDomain && !app.domains.length ? `${app.name.replace(/[^a-z0-9-]/g, '-')}.${appDomain}` : '';
  const [f, setF] = useState({
    hostname: suggested,
    tunnel: state?.settings.defaultTunnel ?? '',
    routeDns: true,
    overwriteDns: false,
    alsoWww: false,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const { close } = useDialog();
  const report = useReport();
  const toast = useToast();
  const refresh = useRefresh();

  const submit = async () => {
    const host = f.hostname
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (!host) throw new Error('Enter a hostname, for example example.com or edu.example.com');
    const hosts = [host, ...(f.alsoWww && isRootDomain(host) && !host.startsWith('www.') ? [`www.${host}`] : [])];
    for (const hostname of hosts) {
      const r = await post('/api/sites', {
        hostname,
        upstreamPort: app.port,
        pm2Name: app.name,
        tunnel: f.tunnel,
        routeDns: f.routeDns && !!f.tunnel,
        overwriteDns: f.overwriteDns,
        notes: app.name,
      });
      report(r, `${hostname} now points at ${app.name}`);
    }
    close();
    await refresh();
    if (hosts.length > 1) toast(`Tip: redirect www.${host} to ${host} with a Cloudflare redirect rule to keep one address.`, 'info', 9000);
  };

  return (
    <Modal title={`Add a domain to ${app.name}`} onSubmit={submit} submitLabel="Add domain">
      <div className="form">
        <div className="form-row">
          <Field label="Hostname" hint="A root domain (example.com) or any subdomain (edu.example.com) on your Cloudflare account." wide>
            <input
              value={f.hostname}
              onChange={(e) => set('hostname', e.target.value)}
              placeholder="example.com"
              autoComplete="off"
              // biome-ignore lint/a11y/noAutofocus: the only field the dialog is about
              autoFocus
            />
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
        {f.hostname.trim() && (
          <DnsSwitches
            host={f.hostname}
            tunnel={f.tunnel}
            routeDns={f.routeDns}
            overwriteDns={f.overwriteDns}
            alsoWww={f.alsoWww}
            set={(k, v) => set(k, v)}
          />
        )}
      </div>
    </Modal>
  );
}
