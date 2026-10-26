import { Download, Send } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { PublicSettings } from '../../../src/shared/types';
import { Button, Field, Loading, PageHead, Panel, Switch } from '../components/ui';
import { post, put } from '../lib/api';
import { useAppState, useRefresh } from '../lib/queries';
import { useReport, useToast } from '../lib/toast';

type S = PublicSettings;

export function Settings() {
  const { data: state } = useAppState();
  const [f, setF] = useState<S | null>(null);
  const toast = useToast();
  const report = useReport();
  const refresh = useRefresh();
  useEffect(() => {
    if (state && !f) setF(structuredClone(state.settings));
  }, [state, f]);
  if (!f) return <Loading />;

  const set = <K extends keyof S>(k: K, v: S[K]) => setF({ ...f, [k]: v });
  const setMon = <K extends keyof S['monitoring']>(k: K, v: S['monitoring'][K]) => setF({ ...f, monitoring: { ...f.monitoring, [k]: v } });
  const setNotify = <K extends keyof S['notify']>(k: K, v: S['notify'][K]) => setF({ ...f, notify: { ...f.notify, [k]: v } });
  const text = (k: keyof S, label: string, hint?: ReactNode) => (
    <Field label={label} hint={hint}>
      <input value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value as never)} />
    </Field>
  );
  const num = (k: keyof S, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <input type="number" value={Number(f[k])} onChange={(e) => set(k, Number(e.target.value) as never)} />
    </Field>
  );

  const save = async (quiet = false) => {
    const { cfApiTokenSet: _a, telegramTokenSet: _b, tunnelMetricsPorts: _c, defaultTunnel: _d, monitoring, ...rest } = f;
    const { enabled: _e, grafanaAdminPassword: _g, ...mon } = monitoring;
    const r = await put<{ settings: S }>('/api/settings', { ...rest, monitoring: mon });
    setF(structuredClone(r.settings));
    if (!quiet) toast('Settings saved', 'ok');
    await refresh();
  };

  const createHookDomain = async () => {
    if (!f.webhookDomain) throw new Error('Enter the webhook hostname first');
    await save(true);
    const r = await post('/api/sites', {
      hostname: f.webhookDomain,
      upstreamPort: f.webhookPort,
      tunnel: f.defaultTunnel,
      routeDns: true,
      overwriteDns: true,
      notes: 'Homeport webhooks',
    });
    report(r, `${f.webhookDomain} now receives GitHub webhooks`);
  };

  return (
    <div className="page">
      <PageHead
        title="Settings"
        description="Stored in data/db.json on this machine. Secrets are never sent back to the browser in full."
        actions={
          <>
            <a className="btn" href="/api/export">
              <Download /> Export backup
            </a>
            <Button variant="primary" onClick={() => save()}>
              Save settings
            </Button>
          </>
        }
      />
      <div className="cols">
        <Panel title="Webhooks and apps" description="Where code lives and how GitHub reaches this machine.">
          <div className="form">
            <Field
              label="Public webhook hostname"
              hint="Only /hooks/<app-id> is reachable on it. The dashboard stays private to this machine."
            >
              <div className="input-group">
                <input value={f.webhookDomain} onChange={(e) => set('webhookDomain', e.target.value)} placeholder="hooks.example.com" />
                <Button onClick={createHookDomain}>Create domain</Button>
              </div>
            </Field>
            <Field
              label="Default domain for apps"
              hint={
                <>
                  Like <code>vercel.app</code>: a new app called <code>shop</code> gets <code>shop.{f.appDomain || 'example.com'}</code>{' '}
                  automatically. Use a zone in your Cloudflare account.
                </>
              }
            >
              <input
                value={f.appDomain}
                onChange={(e) => set('appDomain', e.target.value.trim().toLowerCase())}
                placeholder="example.com"
              />
            </Field>
            {text('appsDir', 'Apps folder', 'Each repository is cloned to a folder with the app name.')}
            <div className="form-row">
              {num('portRangeStart', 'First app port', 'New apps get the next free port from here.')}
              {num('webhookPort', 'Webhook listener port', 'Local only; Caddy forwards to it.')}
            </div>
          </div>
        </Panel>

        <Panel title="Notifications" description="Deploy results and alerts, sent where you already look.">
          <div className="form">
            <Field label="Discord webhook URL" hint="Server settings, Integrations, Webhooks, New webhook, Copy URL.">
              <input
                value={f.notify.discordWebhook}
                onChange={(e) => setNotify('discordWebhook', e.target.value)}
                placeholder="https://discord.com/api/webhooks/…"
                autoComplete="off"
              />
            </Field>
            <div className="form-row">
              <Field label="Telegram bot token" hint="From @BotFather.">
                <input
                  type="password"
                  value={f.notify.telegramBotToken}
                  onChange={(e) => setNotify('telegramBotToken', e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Telegram chat ID" hint="Message your bot, then ask @userinfobot.">
                <input value={f.notify.telegramChatId} onChange={(e) => setNotify('telegramChatId', e.target.value)} />
              </Field>
            </div>
            <Switch checked={f.notify.onDeploySuccess} onChange={(v) => setNotify('onDeploySuccess', v)}>
              Successful deploys
            </Switch>
            <Switch checked={f.notify.onDeployFailed} onChange={(v) => setNotify('onDeployFailed', v)}>
              Failed deploys and rollbacks
            </Switch>
            <Switch
              checked={f.notify.onAlerts}
              onChange={(v) => setNotify('onAlerts', v)}
              hint="Apps down, tunnel disconnected, disk almost full, and when they recover."
            >
              Alerts
            </Switch>
            <div>
              <Button
                icon={<Send />}
                onClick={async () => {
                  await save(true);
                  await post('/api/settings/notify/test');
                  toast('Test message sent', 'ok');
                }}
              >
                Save and send a test
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title="Monitoring" description="Binaries and ports for Prometheus, Grafana and node_exporter.">
          <div className="form">
            <div className="form-row">
              <Field label="prometheus">
                <input value={f.monitoring.prometheusBin} onChange={(e) => setMon('prometheusBin', e.target.value)} />
              </Field>
              <Field label="grafana">
                <input value={f.monitoring.grafanaBin} onChange={(e) => setMon('grafanaBin', e.target.value)} />
              </Field>
              <Field label="node_exporter">
                <input value={f.monitoring.nodeExporterBin} onChange={(e) => setMon('nodeExporterBin', e.target.value)} />
              </Field>
            </div>
            <Field label="Grafana home" hint="Leave blank to find it automatically. It is the folder that contains conf/defaults.ini.">
              <input value={f.monitoring.grafanaHome} onChange={(e) => setMon('grafanaHome', e.target.value)} />
            </Field>
            <div className="form-row">
              <Field label="Prometheus port">
                <input
                  type="number"
                  value={f.monitoring.prometheusPort}
                  onChange={(e) => setMon('prometheusPort', Number(e.target.value))}
                />
              </Field>
              <Field label="Grafana port">
                <input type="number" value={f.monitoring.grafanaPort} onChange={(e) => setMon('grafanaPort', Number(e.target.value))} />
              </Field>
              <Field label="Keep data for">
                <input value={f.monitoring.retention} onChange={(e) => setMon('retention', e.target.value)} placeholder="30d" />
              </Field>
            </div>
          </div>
        </Panel>

        <Panel title="Caddy" description="The local reverse proxy every tunnel points at.">
          <div className="form">
            {text('caddyfilePath', 'Caddyfile location')}
            <div className="form-row">
              {num('caddyHttpPort', 'Proxy port', 'Where tunnels send traffic.')}
              {text('caddyAdmin', 'Admin API address')}
            </div>
            <Switch
              checked={f.autoApply}
              onChange={(v) => set('autoApply', v)}
              hint="Turn off to batch several edits, then apply from the Caddyfile page."
            >
              Apply domain changes immediately
            </Switch>
            <Field label="Extra global options" hint="Inside the top-level { } block.">
              <textarea
                value={f.caddyGlobalExtra}
                onChange={(e) => set('caddyGlobalExtra', e.target.value)}
                placeholder={'servers {\n  trusted_proxies static private_ranges\n}'}
              />
            </Field>
            <Field label="Raw blocks appended to the file">
              <textarea value={f.caddyRawAppend} onChange={(e) => set('caddyRawAppend', e.target.value)} />
            </Field>
          </div>
        </Panel>

        <Panel title="Cloudflare API" description="Optional. Lets Homeport delete DNS records when you delete a domain or tunnel.">
          <div className="form">
            <Field label="API token" hint="Permissions: Zone, DNS, Edit and Zone, Zone, Read.">
              <input type="password" value={f.cfApiToken} onChange={(e) => set('cfApiToken', e.target.value)} autoComplete="new-password" />
            </Field>
            <div>
              <Button
                onClick={async () => {
                  await save(true);
                  const r = await post<{ zones: string[] }>('/api/settings/cf-token/test');
                  toast(`Token works. Zones: ${r.zones.join(', ') || 'none'}`, 'ok', 8000);
                }}
              >
                Save and test
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title="Binaries and process names" description="Change these only if a tool lives outside your PATH.">
          <div className="form">
            <div className="form-row">
              {text('caddyBin', 'caddy')}
              {text('cloudflaredBin', 'cloudflared')}
              {text('pm2Bin', 'pm2')}
            </div>
            {text('cloudflaredDir', 'cloudflared folder', 'Holds cert.pem and tunnel credentials.')}
            <div className="form-row">
              {text('caddyPm2Name', 'Caddy process name')}
              {text('tunnelPm2Prefix', 'Tunnel process prefix')}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
