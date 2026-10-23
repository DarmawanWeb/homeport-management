import { useEffect, useState } from 'react';
import { Button, Check, Empty, Field, Toolbar } from '../components/ui';
import { post, put } from '../lib/api';
import { useAppState, useRefresh } from '../lib/queries';
import { useReport, useToast } from '../lib/toast';
import type { PublicSettings } from '../../../src/shared/types';

type S = PublicSettings;

export function Settings() {
  const { data: state } = useAppState();
  const [f, setF] = useState<S | null>(null);
  const toast = useToast();
  const report = useReport();
  const refresh = useRefresh();
  useEffect(() => { if (state && !f) setF(structuredClone(state.settings)); }, [state, f]);
  if (!f || !state) return <Empty>Memuat…</Empty>;

  const set = <K extends keyof S>(k: K, v: S[K]) => setF({ ...f, [k]: v });
  const setMon = <K extends keyof S['monitoring']>(k: K, v: S['monitoring'][K]) => setF({ ...f, monitoring: { ...f.monitoring, [k]: v } });
  const setNotify = <K extends keyof S['notify']>(k: K, v: S['notify'][K]) => setF({ ...f, notify: { ...f.notify, [k]: v } });
  const text = (k: keyof S, label: string, hint?: React.ReactNode) => (
    <Field label={label} hint={hint}><input value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value as never)} /></Field>
  );
  const num = (k: keyof S, label: string, hint?: string) => (
    <Field label={label} hint={hint}><input type="number" value={Number(f[k])} onChange={(e) => set(k, Number(e.target.value) as never)} /></Field>
  );

  const save = async () => {
    const { cfApiTokenSet: _a, telegramTokenSet: _b, tunnelMetricsPorts: _c, defaultTunnel: _d, monitoring, ...rest } = f;
    const { enabled: _e, grafanaAdminPassword: _g, ...mon } = monitoring;
    const r = await put<{ settings: S }>('/api/settings', { ...rest, monitoring: mon });
    setF(structuredClone(r.settings));
    toast('Settings disimpan', 'ok');
    await refresh();
  };

  const createHookDomain = async () => {
    if (!f.webhookDomain) throw new Error('Isi domain webhook dulu');
    await put('/api/settings', { webhookDomain: f.webhookDomain });
    const r = await post('/api/sites', { hostname: f.webhookDomain, upstreamPort: f.webhookPort, tunnel: f.defaultTunnel, routeDns: true, overwriteDns: true, notes: 'Homeport webhook' });
    report(r, `Domain webhook dibuat: ${f.webhookDomain}`);
    await refresh();
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); }}>
      <Toolbar title="Settings">
        <a className="btn" href="/api/export">Export backup</a>
        <Button variant="primary" onClick={save}>Simpan settings</Button>
      </Toolbar>
      <div className="grid2">
        <section className="card section">
          <h3>Apps &amp; Webhook</h3>
          {text('appsDir', 'Folder app', <>Repo di-clone ke sini, mis. <code>~/apps/&lt;nama&gt;</code></>)}
          <div className="row">{num('portRangeStart', 'Port awal app', 'port otomatis mulai dari sini')}{num('webhookPort', 'Port webhook server', 'lokal, diakses lewat Caddy')}</div>
          <Field label="Domain webhook (publik)" hint={<>Hanya endpoint <code>/hooks/&lt;id&gt;</code> yang terbuka ke internet; dashboard tetap lokal. Setiap request diverifikasi HMAC.</>}>
            <div className="copy">
              <input value={f.webhookDomain} onChange={(e) => set('webhookDomain', e.target.value)} placeholder="hooks.domainkamu.com" />
              <Button onClick={createHookDomain}>Buat domain webhook</Button>
            </div>
          </Field>
        </section>

        <section className="card section">
          <h3>Notifikasi</h3>
          <Field label="Discord webhook URL" hint="Server Settings → Integrations → Webhooks → New Webhook → Copy URL">
            <input value={f.notify.discordWebhook} onChange={(e) => setNotify('discordWebhook', e.target.value)} placeholder="https://discord.com/api/webhooks/…" autoComplete="off" />
          </Field>
          <div className="row">
            <Field label="Telegram bot token" hint="dari @BotFather"><input type="password" value={f.notify.telegramBotToken} onChange={(e) => setNotify('telegramBotToken', e.target.value)} autoComplete="new-password" /></Field>
            <Field label="Telegram chat id" hint="kirim pesan ke bot, cek @userinfobot"><input value={f.notify.telegramChatId} onChange={(e) => setNotify('telegramChatId', e.target.value)} /></Field>
          </div>
          <Check checked={f.notify.onDeploySuccess} onChange={(v) => setNotify('onDeploySuccess', v)}>Deploy berhasil</Check>
          <Check checked={f.notify.onDeployFailed} onChange={(v) => setNotify('onDeployFailed', v)}>Deploy gagal / rollback</Check>
          <Check checked={f.notify.onAlerts} onChange={(v) => setNotify('onAlerts', v)}>Alert (app down, tunnel putus, disk penuh, …)</Check>
          <Button size="sm" onClick={async () => { await save(); await post('/api/settings/notify/test'); toast('Notifikasi tes terkirim', 'ok'); }}>Simpan &amp; kirim tes</Button>
        </section>

        <section className="card section">
          <h3>Monitoring</h3>
          <div className="row">
            <Field label="prometheus"><input value={f.monitoring.prometheusBin} onChange={(e) => setMon('prometheusBin', e.target.value)} /></Field>
            <Field label="grafana"><input value={f.monitoring.grafanaBin} onChange={(e) => setMon('grafanaBin', e.target.value)} /></Field>
            <Field label="node_exporter"><input value={f.monitoring.nodeExporterBin} onChange={(e) => setMon('nodeExporterBin', e.target.value)} /></Field>
          </div>
          <Field label="Grafana home" hint="Kosongkan = otomatis (Homebrew: …/opt/grafana/share/grafana)"><input value={f.monitoring.grafanaHome} onChange={(e) => setMon('grafanaHome', e.target.value)} /></Field>
          <div className="row">
            <Field label="Port Prometheus"><input type="number" value={f.monitoring.prometheusPort} onChange={(e) => setMon('prometheusPort', Number(e.target.value))} /></Field>
            <Field label="Port Grafana"><input type="number" value={f.monitoring.grafanaPort} onChange={(e) => setMon('grafanaPort', Number(e.target.value))} /></Field>
            <Field label="Retensi data"><input value={f.monitoring.retention} onChange={(e) => setMon('retention', e.target.value)} placeholder="30d" /></Field>
          </div>
        </section>

        <section className="card section">
          <h3>Caddy</h3>
          {text('caddyfilePath', 'Lokasi Caddyfile')}
          <div className="row">{num('caddyHttpPort', 'Port proxy Caddy', 'tujuan semua tunnel')}{text('caddyAdmin', 'Admin API')}</div>
          <Check checked={f.autoApply} onChange={(v) => set('autoApply', v)}>Apply otomatis setiap ada perubahan domain</Check>
          <Field label="Opsi global ekstra (di dalam blok { })"><textarea value={f.caddyGlobalExtra} onChange={(e) => set('caddyGlobalExtra', e.target.value)} placeholder={'servers {\n  trusted_proxies static private_ranges\n}'} /></Field>
          <Field label="Blok mentah di akhir file"><textarea value={f.caddyRawAppend} onChange={(e) => set('caddyRawAppend', e.target.value)} /></Field>
        </section>

        <section className="card section">
          <h3>Binary &amp; nama proses</h3>
          <div className="row">{text('caddyBin', 'caddy')}{text('cloudflaredBin', 'cloudflared')}{text('pm2Bin', 'pm2')}</div>
          {text('cloudflaredDir', 'Folder cloudflared', 'Lokasi cert.pem dan kredensial tunnel (<id>.json)')}
          <div className="row">{text('caddyPm2Name', 'Nama pm2 Caddy')}{text('tunnelPm2Prefix', 'Prefix pm2 tunnel')}</div>
        </section>

        <section className="card section">
          <h3>Cloudflare API (opsional)</h3>
          <p className="hint">Hanya untuk <b>menghapus</b> CNAME DNS otomatis saat domain/tunnel dihapus. Buat token dengan izin <code>Zone → DNS → Edit</code> dan <code>Zone → Zone → Read</code>.</p>
          <Field label="API token"><input type="password" value={f.cfApiToken} onChange={(e) => set('cfApiToken', e.target.value)} autoComplete="new-password" /></Field>
          <Button size="sm" onClick={async () => { await save(); const r = await post<{ zones: string[] }>('/api/settings/cf-token/test'); toast(`Token OK. Zone: ${r.zones.join(', ') || '(tidak ada)'}`, 'ok', 8000); }}>Simpan &amp; tes token</Button>
        </section>
      </div>
    </form>
  );
}
