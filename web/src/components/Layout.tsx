import type { ReactNode } from 'react';
import { post } from '../lib/api';
import { useMonitoring, useStatus, useTunnels } from '../lib/queries';
import { useToast } from '../lib/toast';
import { Banner, Button, Pill } from './ui';

export const PAGES = [
  ['overview', 'Overview'], ['apps', 'Apps'], ['domains', 'Domains'], ['tunnels', 'Tunnels'],
  ['services', 'Services'], ['monitoring', 'Monitoring'], ['caddyfile', 'Caddyfile'], ['activity', 'Log'], ['settings', 'Settings'],
] as const;
export type Page = (typeof PAGES)[number][0];

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('hp_theme', next); } catch { /* private mode */ }
}

export function Layout({ page, onNavigate, children }: { page: Page; onNavigate: (p: Page) => void; children: ReactNode }) {
  const { data: s } = useStatus();
  const { data: mon } = useMonitoring();
  const firing = mon?.alerts.filter((a) => a.state === 'firing').length ?? 0;
  return (
    <>
      <header className="top">
        <div className="brand"><div className="logo">⌂</div>Homeport <small>git · pm2 · Caddy · Cloudflare · Prometheus</small></div>
        <div className="pills">
          {!s ? <Pill>memuat…</Pill> : <>
            <Pill state={!s.caddy.version ? 'err' : s.caddy.adminUp ? 'ok' : 'warn'} title={s.caddy.version ?? 'tidak ditemukan'}>Caddy</Pill>
            <Pill state={!s.cloudflared.version ? 'err' : s.cloudflared.loggedIn ? 'ok' : 'warn'} title={s.cloudflared.loggedIn ? 'login OK' : 'belum login'}>cloudflared</Pill>
            <Pill state={s.pm2.version ? 'ok' : 'err'} title={s.pm2.version ?? s.pm2.error ?? ''}>pm2</Pill>
            {mon && <Pill state={!mon.enabled ? '' : firing ? 'err' : 'ok'} title={firing ? `${firing} alert aktif` : 'monitoring'}>{firing ? `${firing} alert` : 'metrics'}</Pill>}
          </>}
          <button className="btn sm ghost" onClick={toggleTheme} title="Ganti tema" aria-label="Ganti tema">◐</button>
        </div>
      </header>
      <nav className="tabs">
        {PAGES.map(([key, label]) => (
          <button key={key} className={page === key ? 'active' : ''} onClick={() => onNavigate(key)}>
            {label}{key === 'monitoring' && firing > 0 && <span className="badge">{firing}</span>}
          </button>
        ))}
      </nav>
      <main>{children}</main>
    </>
  );
}

/** First-run guidance shown on top of most pages until the basics work. */
export function SetupBanners({ onNavigate }: { onNavigate?: (p: Page) => void }) {
  const { data: s, refetch } = useStatus();
  const { data: tunnels } = useTunnels();
  const toast = useToast();
  if (!s) return null;
  const login = async () => {
    const r = await post<{ url?: string; already?: boolean; error?: string; output?: string }>('/api/cloudflared/login');
    if (r.already) { toast('Sudah login', 'ok'); return refetch(); }
    if (r.error) throw new Error(r.error + (r.output ? `\n${r.output}` : ''));
    window.open(r.url, '_blank', 'noopener');
    toast('Buka link yang muncul, pilih domain, lalu Authorize. Setelah itu refresh halaman ini.', 'info', 12_000);
  };
  const startCaddy = async () => { const r = await post<{ note: string }>('/api/caddy/start'); toast(r.note, 'ok'); await refetch(); };
  return (
    <>
      {!s.cloudflared.version && <Banner>cloudflared tidak ditemukan. Install: <code>brew install cloudflared</code></Banner>}
      {s.cloudflared.version && !s.cloudflared.loggedIn && <Banner action={<Button variant="primary" size="sm" onClick={login}>Login Cloudflare</Button>}>cloudflared belum login. Login sekali untuk membuat tunnel &amp; DNS.</Banner>}
      {!s.caddy.version && <Banner>Caddy tidak ditemukan. Install: <code>brew install caddy</code></Banner>}
      {s.caddy.version && !s.caddy.adminUp && <Banner action={<Button variant="primary" size="sm" onClick={startCaddy}>Start Caddy</Button>}>Caddy belum jalan — domain tidak bisa diakses.</Banner>}
      {tunnels && tunnels.tunnels.length === 0 && s.cloudflared.loggedIn && onNavigate && (
        <Banner action={<Button size="sm" variant="primary" onClick={() => onNavigate('tunnels')}>Buat tunnel</Button>}>Belum ada tunnel. Biasanya cukup satu tunnel untuk semua domain.</Banner>
      )}
    </>
  );
}
